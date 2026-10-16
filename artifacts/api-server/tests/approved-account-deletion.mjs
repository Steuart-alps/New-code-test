// Reviewed account deletion across the database and stored files (Replit #367).
// Nothing is purged while a request awaits review, inside the 30-day minimum
// wait or the retention window, under a legal hold, or after a self-approval;
// an approved, due request removes only that tenant's ACL-owned files and
// leaves a durable, append-only outcome. Storage is an in-memory stand-in for
// the provider bucket (only objectStorageClient.bucket() is replaced; the real
// listing, ACL and delete code runs). Runs only inside the disposable database:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/approved-account-deletion.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The approved account deletion test requires the disposable fresh-schema database.");
}

// A made-up bucket name: the fake below answers for it, nothing reaches Google.
const BUCKET = "erasure-test-fake-bucket";
process.env.PRIVATE_OBJECT_DIR = `/${BUCKET}/private`;

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-approved-account-deletion-"));
let lib;
try {
  const output = path.join(temp, "deletion.mjs");
  await build({
    entryPoints: [path.join(testsDir, "approved-account-deletion.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

// ── In-memory bucket ─────────────────────────────────────────────────────────
const objects = new Map(); // provider object name -> { size, acl }
const deletes = [];
let failDeleteOf = null;
const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
const metadataOf = (name) => {
  const object = objects.get(name);
  if (!object) throw notFound();
  return { size: String(object.size), metadata: object.acl ? { "custom:aclPolicy": JSON.stringify(object.acl) } : {} };
};
const fileRef = (name, listed = false) => ({
  name,
  metadata: listed ? metadataOf(name) : undefined,
  async exists() { return [objects.has(name)]; },
  async getMetadata() { return [metadataOf(name)]; },
  async delete({ ignoreNotFound } = {}) {
    if (failDeleteOf === name) throw new Error("simulated provider outage");
    if (!objects.delete(name) && !ignoreNotFound) throw notFound();
    deletes.push(name);
  },
});
lib.objectStorageClient.bucket = (bucketName) => {
  assert.equal(bucketName, BUCKET, "only the fake bucket may be touched");
  return {
    async getFiles({ prefix }) {
      return [[...objects.keys()].filter((name) => name.startsWith(prefix)).map((name) => fileRef(name, true))];
    },
    file: (name) => fileRef(name),
  };
};
const owner = (clientId) => ({ owner: String(clientId), visibility: "private" });
const put = (objectPath, acl, size = 100) => objects.set(`private/${objectPath.replace(/^\/objects\//, "")}`, { size, acl });
const has = (objectPath) => objects.has(`private/${objectPath.replace(/^\/objects\//, "")}`);
const reference = (clientId, objectPath) => db.execute(sql`
  INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present) VALUES (${objectPath}, ${clientId}, 100, true)`);

// ── Helpers ──────────────────────────────────────────────────────────────────
const run = (clientIds) => lib.runDataDeletionJob({
  clientIds, eraseStorage: lib.eraseClientStorageObjects, sendEmail: async () => {},
});
const client = async (id) => (await db.execute(sql`SELECT data_deleted_at FROM clients WHERE id = ${id}`)).rows[0];
const outcomes = async (id) => (await db.execute(sql`
  SELECT request_id, reason, approved_by, outcome, rows_deleted, objects_deleted, objects_skipped, error, started_at, finished_at
  FROM client_data_deletion_outcomes WHERE client_id = ${id} ORDER BY id`)).rows;
const requestRow = async (id) => (await db.execute(sql`SELECT status FROM client_data_deletion_requests WHERE id = ${id}`)).rows[0];
const submit = async (tenant) => (await db.execute(sql`
  INSERT INTO client_data_deletion_requests (client_id, requested_by, earliest_deletion_at, notification_state)
  VALUES (${tenant.clientId}, ${tenant.userId}, now() + interval '30 days', 'sent') RETURNING id`)).rows[0].id;
const review = async (reviewer, tenant, requestId, decision = "approved") => {
  await db.execute(sql`INSERT INTO consultant_clients (user_id, client_id) VALUES (${reviewer.userId}, ${tenant.clientId}) ON CONFLICT DO NOTHING`);
  return reviewer.request("PATCH", `/admin/data-deletion-requests/${requestId}/review`, {
    decision, note: "Checked retention obligations and legal holds for this account",
  });
};
const backdate = (requestId, requestedDaysAgo, earliestDaysAgo) => db.execute(sql`
  UPDATE client_data_deletion_requests
     SET requested_at = now() - make_interval(days => ${requestedDaysAgo}),
         earliest_deletion_at = now() - make_interval(days => ${earliestDaysAgo})
   WHERE id = ${requestId}`);

try {
  const target = await createTenant("erasure-target");
  const neighbour = await createTenant("erasure-neighbour");
  const reviewer = await createTenant("erasure-reviewer");
  const selfApproved = await createTenant("erasure-self-approved");
  const retention = await createTenant("erasure-retention-window");
  const T = target.clientId;
  const N = neighbour.clientId;

  // The target's files: two it owns under its prefix (one referenced), a
  // legacy file outside the prefix it owns and references, a reserved upload
  // never finalised (no ACL), a stale reference to the neighbour's file, and
  // a file marked as the target's that nothing references outside its prefix.
  const owned = [`/objects/finalized/tenant-${T}/report.pdf`, `/objects/finalized/tenant-${T}/photo.jpg`, `/objects/legacy/target-owned.pdf`];
  const unmarkedUpload = `/objects/uploads/tenant-${T}/abandoned.jpg`;
  const staleForeign = `/objects/legacy/neighbour-owned.pdf`;
  const unrelatedMarked = `/objects/other-area/marked-but-unreferenced.pdf`;
  for (const objectPath of owned) put(objectPath, owner(T));
  put(unmarkedUpload, null);
  put(staleForeign, owner(N));
  put(unrelatedMarked, owner(T));
  for (const objectPath of [owned[0], owned[2], unmarkedUpload, staleForeign]) await reference(T, objectPath);
  // A COSHH safety data sheet outside the prefix, referenced only by its register row.
  const registerFile = `/objects/legacy/target-sds.pdf`;
  owned.push(registerFile);
  put(registerFile, owner(T));
  await db.execute(sql`INSERT INTO coshh_substances (client_id, product_name, sds_object_path) VALUES (${T}, 'Bleach', ${registerFile})`);
  // The neighbour's own files, under its prefix and referenced.
  const neighbourFiles = [`/objects/finalized/tenant-${N}/cert.pdf`, `/objects/uploads/tenant-${N}/receipt.jpg`];
  for (const objectPath of neighbourFiles) { put(objectPath, owner(N)); await reference(N, objectPath); }
  const everyoneElse = [...neighbourFiles, staleForeign, unrelatedMarked, unmarkedUpload];
  const scope = [T, N, selfApproved.clientId, retention.clientId];
  const nothingPurged = async (label) => {
    assert.equal(await run(scope).then((r) => r.clientsDeleted), 0, `${label}: nothing deleted`);
    assert.equal(deletes.length, 0, `${label}: no stored file deleted`);
    for (const id of scope) assert.equal((await client(id)).data_deleted_at, null, `${label}: client ${id} intact`);
    assert.deepEqual(await outcomes(T), [], `${label}: no outcome recorded`);
  };

  // The 12-month retention window that has not passed purges nothing.
  await db.execute(sql`UPDATE clients SET cancelled_at = now() - interval '2 months',
    data_deletion_scheduled_at = now() + interval '10 months' WHERE id = ${retention.clientId}`);
  // A request approved by its own requester (written outside the review route).
  await db.execute(sql`
    INSERT INTO client_data_deletion_requests (client_id, requested_by, requested_at, earliest_deletion_at,
      status, notification_state, reviewed_by, reviewed_at, review_note)
    VALUES (${selfApproved.clientId}, ${selfApproved.userId}, now() - interval '40 days', now() - interval '10 days',
      'approved', 'sent', ${selfApproved.userId}, now() - interval '35 days', 'Self approval written directly')`);

  const requestId = await submit(target);
  await nothingPurged("pending review");

  // A reviewer cannot be the requester; the review route refuses it.
  assert.equal((await target.request("PATCH", `/admin/data-deletion-requests/${requestId}/review`, {
    decision: "approved", note: "Approving my own request should fail",
  })).status, 404);
  const approved = await review(reviewer, target, requestId);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  await nothingPurged("approved, inside the 30-day wait");

  // A back-dated earliest date alone does not shorten the 30 days from the request.
  await backdate(requestId, 5, 1);
  await nothingPurged("earliest date back-dated, request 5 days old");

  // Past the 30 days, a legal hold added after approval still stops execution.
  await backdate(requestId, 31, 1);
  const hold = (await db.execute(sql`
    INSERT INTO privacy_retention_schedules (client_id, record_category, scope_description, retention_period,
      retention_trigger, justification, legal_hold_active, legal_hold_reason)
    VALUES (${T}, 'incidents', 'Open claim', 'until settled', 'claim', 'Insurer request', true, 'Claim pending')
    RETURNING id`)).rows[0].id;
  await nothingPurged("legal hold");
  await db.execute(sql`UPDATE privacy_retention_schedules SET active = false WHERE id = ${hold}`);

  // Approved, due and unheld: only the target is deleted.
  const result = await run(scope);
  assert.equal(result.clientsDeleted, 1);
  assert.ok((await client(T)).data_deleted_at, "the target is stamped deleted");
  for (const id of [N, selfApproved.clientId, retention.clientId]) {
    assert.equal((await client(id)).data_deleted_at, null, `client ${id} untouched`);
    assert.deepEqual(await outcomes(id), [], `client ${id} has no outcome`);
  }
  assert.deepEqual(deletes.sort(), owned.map((p) => `private/${p.slice("/objects/".length)}`).sort(),
    "exactly the target's ACL-owned files were deleted");
  for (const objectPath of owned) assert.equal(has(objectPath), false, `${objectPath} deleted`);
  for (const objectPath of everyoneElse) assert.equal(has(objectPath), true, `${objectPath} kept`);
  assert.equal((await requestRow(requestId)).status, "completed");
  const [done] = await outcomes(T);
  assert.equal(done.outcome, "completed");
  assert.equal(done.reason, "approved_request");
  assert.equal(done.request_id, requestId);
  assert.equal(done.approved_by, reviewer.userId);
  assert.equal(done.objects_deleted, owned.length);
  assert.equal(done.objects_skipped, 2, "the unmarked upload and the stale foreign reference were left");
  assert.ok(done.rows_deleted > 0);
  assert.equal(done.error, null);
  assert.ok(new Date(done.finished_at) >= new Date(done.started_at));
  const neighbourRows = await db.execute(sql`SELECT count(*)::int AS n FROM storage_usage_objects WHERE client_id = ${N}`);
  assert.equal(neighbourRows.rows[0].n, neighbourFiles.length, "the neighbour's records are untouched");
  console.log("Approved deletion removed only the requesting tenant's eligible files and recorded the outcome.");

  // The outcome is durable: it cannot be edited or deleted.
  await assert.rejects(db.execute(sql`UPDATE client_data_deletion_outcomes SET objects_deleted = 0 WHERE client_id = ${T}`),
    (err) => /append-only/.test(`${err?.message} ${err?.cause?.message}`));
  await assert.rejects(db.execute(sql`DELETE FROM client_data_deletion_outcomes WHERE client_id = ${T}`),
    (err) => /append-only/.test(`${err?.message} ${err?.cause?.message}`));
  assert.ok(lib.RETAINED_CLIENT_TABLES.has("client_data_deletion_outcomes"));

  // A provider failure part-way rolls the records back and records what went.
  // (The neighbour, now its untouched state is proven; the sign-up limit
  // allows five fixture tenants per run.)
  const failing = neighbour;
  const F = failing.clientId;
  const failingFiles = neighbourFiles;
  const failingRequest = await submit(failing);
  assert.equal((await review(reviewer, failing, failingRequest)).status, 200);
  await backdate(failingRequest, 31, 1);
  // The uploads prefix is listed before finalized, so the receipt goes first.
  failDeleteOf = `private/${failingFiles[0].slice("/objects/".length)}`;
  deletes.length = 0;
  await assert.rejects(run([F]), /Data deletion failed for 1 client/);
  assert.equal((await client(F)).data_deleted_at, null, "records are rolled back");
  assert.equal((await requestRow(failingRequest)).status, "approved", "the request stays approved for the retry");
  const [failure] = await outcomes(F);
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.request_id, failingRequest);
  assert.equal(failure.objects_deleted, 1, "the file deleted before the failure is recorded");
  assert.equal(failure.rows_deleted, 0);
  assert.match(failure.error, /stopped after 1 of 2/);
  failDeleteOf = null;
  assert.equal((await run([F])).clientsDeleted, 1, "the retry completes");
  assert.deepEqual((await outcomes(F)).map((row) => row.outcome), ["failed", "completed"]);
  assert.equal(has(staleForeign), true, "a file the neighbour owns but no longer references is not claimed");
  console.log("A failed deletion is rolled back, recorded, and retried.");
} finally {
  await pool.end();
}
