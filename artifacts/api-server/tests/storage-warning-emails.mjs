// A business's owners and admins get one email, with a link to buy more
// storage, when its stored files pass the warning level set in Settings: not
// below the level, not twice for one crossing, retried when nothing was
// delivered, and again after usage falls back under the level and rises again.
// Notices are kept. Disposable DB only:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/storage-warning-emails.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, createUser, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The storage warning email test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-storage-warning-"));
let lib;
try {
  const output = path.join(temp, "job.mjs");
  await build({
    entryPoints: [path.join(testsDir, "storage-warning-emails.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const GIB = 1024 ** 3;
const sent = [];
let failSends = false;
const sendEmail = async (message) => {
  if (failSends) throw new Error("simulated provider outage");
  sent.push(message);
};
const run = (clientIds) => lib.runStorageWarningEmailJob({ sendEmail, clientIds });
let objectSeq = 0;
const store = async (clientId, bytes) => {
  const objectPath = `/objects/uploads/tenant-${clientId}/warning-${++objectSeq}`;
  await db.execute(sql`
    INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present)
    VALUES (${objectPath}, ${clientId}, ${Math.round(bytes)}, true)`);
  return objectPath;
};
const remove = (objectPath) => db.execute(sql`
  UPDATE storage_usage_objects SET present = false, changed_at = now() WHERE object_path = ${objectPath}`);
const notices = async (clientId) => (await db.execute(sql`
  SELECT threshold_bytes::text AS threshold, used_bytes::text AS used, recipient_count, cleared_at
    FROM storage_warning_notices WHERE client_id = ${clientId} ORDER BY id`)).rows;

try {
  assert.equal(lib.DEFAULT_STORAGE_WARNING_THRESHOLD_BYTES, 5 * GIB);
  assert.equal(lib.storageWarningThresholdBytes(undefined), 5 * GIB);
  assert.equal(lib.storageWarningThresholdBytes("not a number"), 5 * GIB);
  assert.equal(lib.storageWarningThresholdBytes(String(2 * GIB)), 2 * GIB);
  // With a paid limit the email goes at 80% of it, or earlier if the owner chose a lower level.
  assert.equal(lib.storageWarningLevelBytes(undefined, null), 5 * GIB);
  assert.equal(lib.storageWarningLevelBytes(undefined, 10 * GIB), 8 * GIB);
  assert.equal(lib.storageWarningLevelBytes(String(2 * GIB), 10 * GIB), 2 * GIB);
  assert.equal(lib.storageWarningLevelBytes(String(9 * GIB), 10 * GIB), 8 * GIB);

  // Business text is escaped in the HTML and kept as written in the text.
  const preview = lib.buildStorageWarningEmail({
    recipientName: "Sam <b>", companyName: "Fish & Chips", usedBytes: 5.25 * GIB, thresholdBytes: 5 * GIB,
    storageUrl: "https://app.example/settings#storage",
  });
  assert.match(preview.html, /Fish &amp; Chips/);
  assert.doesNotMatch(preview.html, /Sam <b>/);
  assert.match(preview.text, /Fish & Chips is now storing about 5\.3 GB of files in ComplyTrack, past the warning level of 5 GB/);
  assert.match(preview.text, /Nothing has been deleted and uploads carry on as normal\./);
  // With a paid limit the email says what happens when storage is full.
  const limited = lib.buildStorageWarningEmail({
    recipientName: "Sam", companyName: "Fish & Chips", usedBytes: 9 * GIB, thresholdBytes: 8.8 * GIB,
    storageUrl: "https://app.example/settings#storage", capacityBytes: 11 * GIB, autoTopUp: false,
  });
  assert.match(limited.text, /Your storage is 11 GB; when it is full, new uploads will stop until more storage is added\./);
  assert.doesNotMatch(limited.text, /uploads carry on/);
  const topUp = lib.buildStorageWarningEmail({
    recipientName: "Sam", companyName: "Fish & Chips", usedBytes: 9 * GIB, thresholdBytes: 8.8 * GIB,
    storageUrl: "https://app.example/settings#storage", capacityBytes: 11 * GIB, autoTopUp: true,
  });
  assert.match(topUp.text, /we will add 10 GB automatically \(£1 a month\)/);

  const over = await createTenant("storage-warning-over");
  const under = await createTenant("storage-warning-under");
  const cancelled = await createTenant("storage-warning-cancelled");
  const scope = [over.clientId, under.clientId, cancelled.clientId];
  await createUser(over, { role: "client_admin" });
  await createUser(over, { role: "client_manager" });
  await createUser(over, { role: "client_staff" });
  const managerEmails = (await db.execute(sql`
    SELECT email FROM users WHERE client_id = ${over.clientId} AND role IN ('consultant', 'client_admin') ORDER BY id`))
    .rows.map((row) => row.email);
  assert.equal(managerEmails.length, 2);

  // A 1 GB level for the first business; the others keep the 5 GB default.
  await db.execute(sql`
    INSERT INTO app_settings (client_id, key, value) VALUES (${over.clientId}, 'storageWarningThresholdBytes', ${String(GIB)})`);
  const first = await store(over.clientId, 0.6 * GIB);
  await store(under.clientId, 4 * GIB);
  await store(cancelled.clientId, 6 * GIB);
  await db.execute(sql`UPDATE clients SET cancelled_at = now() WHERE id = ${cancelled.clientId}`);

  assert.deepEqual(await run(scope), { noticesClosed: 0, clientsNotified: 0, emailsSent: 0 }, "nothing below the level");

  const second = await store(over.clientId, 0.5 * GIB);
  // A delivery failure records nothing, so the next run retries.
  failSends = true;
  assert.deepEqual(await run(scope), { noticesClosed: 0, clientsNotified: 0, emailsSent: 0 });
  assert.equal((await notices(over.clientId)).length, 0, "a failed warning is retried");
  failSends = false;

  assert.deepEqual(await run(scope), { noticesClosed: 0, clientsNotified: 1, emailsSent: 2 });
  assert.deepEqual(sent.map((m) => m.to).sort(), [...managerEmails].sort(), "owner and admin, not managers or staff (they cannot buy storage)");
  assert.ok(sent.every((m) => m.text.includes("/settings#storage")), "the email links to buying storage");
  assert.ok(sent.every((m) => /past the warning level of 1 GB/.test(m.text)));
  assert.equal(new Set(sent.map((m) => m.idempotencyKey)).size, 2, "one provider key per recipient");
  const [notice] = await notices(over.clientId);
  assert.equal(Number(notice.threshold), GIB);
  assert.equal(Number(notice.used), Math.round(0.6 * GIB) + Math.round(0.5 * GIB));
  assert.equal(notice.recipient_count, 2);
  assert.equal(notice.cleared_at, null);
  assert.equal((await notices(cancelled.clientId)).length, 0, "a cancelled business is not emailed");
  assert.equal((await notices(under.clientId)).length, 0);

  // Still over the level: no second email for the same crossing.
  sent.length = 0;
  await store(over.clientId, 0.2 * GIB);
  assert.deepEqual(await run(scope), { noticesClosed: 0, clientsNotified: 0, emailsSent: 0 });
  assert.equal(sent.length, 0);

  // Just under the level (above 90%) keeps the notice open, so usage that
  // hovers around the level does not email every day.
  await remove(second);
  await store(over.clientId, 0.15 * GIB);
  assert.deepEqual(await run(scope), { noticesClosed: 0, clientsNotified: 0, emailsSent: 0 });

  // Well under the level closes the notice; crossing again emails again.
  await remove(first);
  assert.deepEqual(await run(scope), { noticesClosed: 1, clientsNotified: 0, emailsSent: 0 });
  await store(over.clientId, 1 * GIB);
  assert.deepEqual(await run(scope), { noticesClosed: 0, clientsNotified: 1, emailsSent: 2 });
  const history = await notices(over.clientId);
  assert.equal(history.length, 2, "earlier notices are kept");
  assert.notEqual(history[0].cleared_at, null);
  assert.equal(history[1].cleared_at, null);

  // Raising the level above the usage closes the open notice too.
  await db.execute(sql`
    UPDATE app_settings SET value = ${String(10 * GIB)}
     WHERE client_id = ${over.clientId} AND key = 'storageWarningThresholdBytes'`);
  assert.deepEqual(await run(scope), { noticesClosed: 1, clientsNotified: 0, emailsSent: 0 });
  console.log("Storage warning emails go once per crossing to owners and admins, with the link to buy storage.");
} finally {
  await pool.end().catch(() => {});
}
