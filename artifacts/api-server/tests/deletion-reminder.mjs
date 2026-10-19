// A cancelled business gets one reminder, with the download link, 30 days
// before its 12-month deletion: not earlier, not twice, retried when nothing
// was delivered, and owed again after it resubscribes and cancels again.
// Disposable DB only:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/deletion-reminder.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The deletion reminder test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-deletion-reminder-"));
let lib;
try {
  const output = path.join(temp, "job.mjs");
  await build({
    entryPoints: [path.join(testsDir, "deletion-reminder.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const sent = [];
let failSends = false;
const sendEmail = async (message) => {
  if (failSends) throw new Error("simulated provider outage");
  sent.push(message);
};
const run = (clientIds) => lib.runDeletionReminderJob({ sendEmail, clientIds });
const schedule = (clientId, days) => db.execute(sql`
  UPDATE clients SET cancelled_at = now() - interval '11 months',
    data_deletion_scheduled_at = now() + make_interval(days => ${days})
  WHERE id = ${clientId}`);
const reminderSent = async (clientId) => (await db.execute(sql`
  SELECT deletion_reminder_sent_at FROM clients WHERE id = ${clientId}`)).rows[0].deletion_reminder_sent_at;

try {
  assert.equal(lib.DELETION_REMINDER_DAYS, 30);
  const due = await createTenant("reminder-due");
  const later = await createTenant("reminder-later");
  const active = await createTenant("reminder-active");
  const scope = [due.clientId, later.clientId, active.clientId];
  await schedule(due.clientId, 20);
  await schedule(later.clientId, 60);

  // A delivery failure releases the claim so the next run retries.
  failSends = true;
  assert.deepEqual(await run(scope), { clientsReminded: 0, emailsSent: 0 });
  assert.equal(await reminderSent(due.clientId), null, "a failed reminder is retried");
  failSends = false;

  const first = await run(scope);
  assert.equal(first.clientsReminded, 1, "only the business inside the 30 days is reminded");
  assert.ok(first.emailsSent >= 1);
  assert.ok(sent.every((m) => m.subject.startsWith("Reminder: your ComplyTrack data will be deleted on")));
  assert.ok(sent.every((m) => m.text.includes("/settings#data-export")), "the reminder links the download");
  assert.ok(sent.every((m) => /We recommend downloading a copy/.test(m.text)));
  assert.notEqual(await reminderSent(due.clientId), null);
  assert.equal(await reminderSent(later.clientId), null, "not reminded 60 days out");
  assert.equal(await reminderSent(active.clientId), null, "an active business is never reminded");

  const count = sent.length;
  assert.deepEqual(await run(scope), { clientsReminded: 0, emailsSent: 0 }, "no second reminder");
  assert.equal(sent.length, count);

  // Resubscribing clears the reminder with the retention clock, so a later
  // cancellation is reminded again.
  assert.equal(await lib.clearRetentionSchedule(due.clientId), true);
  assert.equal(await reminderSent(due.clientId), null);
  await schedule(due.clientId, 10);
  assert.equal((await run(scope)).clientsReminded, 1, "reminded again after cancelling again");

  // Already deleted: nothing is sent.
  await db.execute(sql`UPDATE clients SET deletion_reminder_sent_at = NULL, data_deleted_at = now() WHERE id = ${due.clientId}`);
  assert.equal((await run(scope)).clientsReminded, 0, "a deleted business is not reminded");
  console.log("Deletion reminders go out once, 30 days before the 12-month deletion, with the download link.");
} finally {
  await pool.end().catch(() => {});
}
