// Cancelled businesses' files move to cold storage after a 30-day grace
// period and back if they subscribe again; only that business's ACL-owned
// files are rewritten, each at most once. Storage is an in-memory stand-in
// for the provider bucket (only objectStorageClient.bucket() is replaced; the
// real listing, ACL check and storage-class code runs). Disposable DB only:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/cancelled-storage-class.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The cancelled storage class test requires the disposable fresh-schema database.");
}

const BUCKET = "storage-class-test-fake-bucket";
process.env.PRIVATE_OBJECT_DIR = `/${BUCKET}/private`;

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-cancelled-storage-class-"));
let lib;
try {
  const output = path.join(temp, "job.mjs");
  await build({
    entryPoints: [path.join(testsDir, "cancelled-storage-class.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

// ── In-memory bucket ─────────────────────────────────────────────────────────
const objects = new Map(); // provider object name -> { size, acl, storageClass }
const rewrites = [];
const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
const metadataOf = (name) => {
  const object = objects.get(name);
  if (!object) throw notFound();
  return {
    size: String(object.size), storageClass: object.storageClass,
    metadata: object.acl ? { "custom:aclPolicy": JSON.stringify(object.acl) } : {},
  };
};
const fileRef = (name, listed = false) => ({
  name,
  metadata: listed ? metadataOf(name) : undefined,
  async exists() { return [objects.has(name)]; },
  async getMetadata() { return [metadataOf(name)]; },
  async setStorageClass(storageClass) {
    const object = objects.get(name);
    if (!object) throw notFound();
    object.storageClass = storageClass;
    rewrites.push(`${name}:${storageClass}`);
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
const key = (objectPath) => `private/${objectPath.replace(/^\/objects\//, "")}`;
const put = (objectPath, acl, storageClass = "STANDARD") => objects.set(key(objectPath), { size: 100, acl, storageClass });
const classOf = (objectPath) => objects.get(key(objectPath))?.storageClass;
const owner = (clientId) => ({ owner: String(clientId), visibility: "private" });
const reference = (clientId, objectPath) => db.execute(sql`
  INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present) VALUES (${objectPath}, ${clientId}, 100, true)`);
const archivedAt = async (id) => (await db.execute(sql`SELECT files_archived_at FROM clients WHERE id = ${id}`)).rows[0].files_archived_at;
const cancel = (id, daysAgo) => db.execute(sql`
  UPDATE clients SET cancelled_at = now() - make_interval(days => ${daysAgo}),
    data_deletion_scheduled_at = now() - make_interval(days => ${daysAgo}) + interval '12 months'
  WHERE id = ${id}`);

try {
  assert.equal(lib.cancelledFilesStorageClass(), "ARCHIVE", "archive is the default cold class");
  const cancelled = await createTenant("storage-cancelled");
  const recent = await createTenant("storage-recently-cancelled");
  const active = await createTenant("storage-active");
  const C = cancelled.clientId;
  const R = recent.clientId;
  const A = active.clientId;
  const scope = [C, R, A];

  const cOwned = [`/objects/finalized/tenant-${C}/report.pdf`, `/objects/legacy/c-owned.jpg`];
  const cUnmarked = `/objects/uploads/tenant-${C}/never-finalised.jpg`;
  const cForeign = `/objects/legacy/active-owned.pdf`; // stale reference to A's file
  for (const objectPath of cOwned) put(objectPath, owner(C));
  put(cUnmarked, null);
  put(cForeign, owner(A));
  for (const objectPath of [cOwned[1], cUnmarked, cForeign]) await reference(C, objectPath);
  const rFile = `/objects/finalized/tenant-${R}/photo.jpg`;
  put(rFile, owner(R));
  const aFile = `/objects/finalized/tenant-${A}/cert.pdf`;
  put(aFile, owner(A));
  await cancel(C, 40);
  await cancel(R, 10);

  const first = await lib.runCancelledStorageClassJob({ clientIds: scope });
  assert.deepEqual(first, { archived: 1, restored: 0, objectsMoved: 2 });
  for (const objectPath of cOwned) assert.equal(classOf(objectPath), "ARCHIVE", `${objectPath} archived`);
  assert.equal(classOf(cUnmarked), "STANDARD", "an unmarked upload is not touched");
  assert.equal(classOf(cForeign), "STANDARD", "another business's file is not touched");
  assert.equal(classOf(rFile), "STANDARD", "a business inside the 30-day grace period is not touched");
  assert.equal(classOf(aFile), "STANDARD", "an active business is not touched");
  assert.ok(await archivedAt(C));
  assert.equal(await archivedAt(R), null);
  assert.equal(await archivedAt(A), null);
  assert.equal(objects.get(key(cOwned[0])).acl.owner, String(C), "the ACL survives the move");

  rewrites.length = 0;
  assert.deepEqual(await lib.runCancelledStorageClassJob({ clientIds: scope }), { archived: 0, restored: 0, objectsMoved: 0 });
  assert.equal(rewrites.length, 0, "archived files are not rewritten again");

  // Resubscribing clears cancelled_at; the files come back to standard storage.
  await db.execute(sql`UPDATE clients SET cancelled_at = NULL, data_deletion_scheduled_at = NULL WHERE id = ${C}`);
  assert.deepEqual(await lib.runCancelledStorageClassJob({ clientIds: scope }), { archived: 0, restored: 1, objectsMoved: 2 });
  for (const objectPath of cOwned) assert.equal(classOf(objectPath), "STANDARD", `${objectPath} restored`);
  assert.equal(await archivedAt(C), null);
  console.log("Cancelled businesses' own files move to cold storage after 30 days and back on reactivation.");

  // A file already in the cold class is counted but not rewritten; deleted
  // businesses are left alone; "off" switches the job off.
  await cancel(C, 40);
  put(cOwned[0], owner(C), "ARCHIVE");
  rewrites.length = 0;
  assert.deepEqual(await lib.runCancelledStorageClassJob({ clientIds: [C] }), { archived: 1, restored: 0, objectsMoved: 1 });
  assert.deepEqual(rewrites, [`${key(cOwned[1])}:ARCHIVE`]);
  await cancel(R, 40);
  await db.execute(sql`UPDATE clients SET data_deleted_at = now() WHERE id = ${R}`);
  assert.deepEqual(await lib.runCancelledStorageClassJob({ clientIds: [R] }), { archived: 0, restored: 0, objectsMoved: 0 });
  assert.equal(classOf(rFile), "STANDARD", "a deleted business is skipped");
  process.env.CANCELLED_FILES_STORAGE_CLASS = "off";
  assert.equal((await lib.runCancelledStorageClassJob({ clientIds: scope })).skipped, "switched off");
  process.env.CANCELLED_FILES_STORAGE_CLASS = "glacier";
  assert.throws(() => lib.cancelledFilesStorageClass(), /must be NEARLINE, COLDLINE, ARCHIVE or off/);
  delete process.env.CANCELLED_FILES_STORAGE_CLASS;
  console.log("Already-cold files, deleted businesses and the off switch are respected.");
} finally {
  await pool.end();
}
