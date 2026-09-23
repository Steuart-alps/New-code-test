import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(testsDir, "../../../lib/db");
// The workspace DB package owns pg. Build alongside it so pg remains a real
// external runtime dependency instead of being bundled into this test artifact.
const outDir = await mkdtemp(path.join(dbDir, ".safe-ack-build-"));
const pinoLink = path.join(dbDir, "node_modules", "pino");
let pinoLinkCreated = false;
let pool;
let clientIds = [];
try {
  // pino belongs to the API package while pg belongs to the DB package. Keep
  // both external and temporarily expose the former to Node's ESM resolver.
  await symlink(path.resolve(testsDir, "../node_modules/pino"), pinoLink, "junction");
  pinoLinkCreated = true;
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "safe-track-ack-reminders.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    // Keep the real database driver and all Node built-ins external, as the
    // other database integration tests do.
    external: ["pg", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "node:*"],
    banner: { js: "import { createRequire as __bannerCrReq } from 'node:module'; globalThis.require = __bannerCrReq(import.meta.url);" },
  });
  const lib = await import(new URL(`file://${outFile}`).href);
  const {
    db,
    sql,
    runSafeTrackAckReminderJob,
    getOutstandingSafeTrackAcknowledgements,
    parseSafeTrackReminderSettings,
    isSafeTrackReminderDue,
    registerSafeTrackAckReminderSchedule,
  } = lib;
  pool = lib.pool;
  const tag = `safe-ack-${Date.now()}`;
  const insertClient = async (suffix) => {
    const row = await db.execute(sql`INSERT INTO clients (name, slug, active) VALUES (${`${tag}-${suffix}`}, ${`${tag}-${suffix}`}, true) RETURNING id`);
    clientIds.push(row.rows[0].id); return row.rows[0].id;
  };
  const primary = await insertClient("one");
  const foreign = await insertClient("two");
  // Runtime migrations may not have run in an isolated test database.
  await db.execute(sql`ALTER TABLE safe_risk_assessments ADD COLUMN IF NOT EXISTS department_id integer`);
  await db.execute(sql`ALTER TABLE safe_sops ADD COLUMN IF NOT EXISTS department_id integer`);
  await db.execute(sql`ALTER TABLE safe_handbook ADD COLUMN IF NOT EXISTS department_id integer`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS safe_track_ack_reminder_log (id serial PRIMARY KEY, client_id integer NOT NULL, sent_at timestamp NOT NULL DEFAULT now())`);
  const site = await db.execute(sql`INSERT INTO sites (client_id, name) VALUES (${primary}, 'North') RETURNING id`);
  const siteId = site.rows[0].id;
  const department = await db.execute(sql`INSERT INTO departments (client_id, name) VALUES (${primary}, 'Operations') RETURNING id`);
  const departmentId = department.rows[0].id;
  await db.execute(sql`UPDATE sites SET department_id = ${departmentId} WHERE id = ${siteId} AND client_id = ${primary}`);
  const active = await db.execute(sql`INSERT INTO staff_roster (client_id, name, site_id, department, email, active) VALUES (${primary}, 'Active', ${siteId}, 'differently formatted dept', 'staff@test.local', true) RETURNING id`);
  await db.execute(sql`INSERT INTO staff_roster (client_id, name, site_id, active) VALUES (${primary}, 'Inactive', ${siteId}, false)`);
  await db.execute(sql`INSERT INTO staff_roster (client_id, name, active) VALUES (${primary}, 'Elsewhere', true)`);
  const doc = await db.execute(sql`
    INSERT INTO safe_risk_assessments (client_id, site_id, department_id, title, requires_acknowledgement, created_at)
    VALUES (${primary}, ${siteId}, ${departmentId}, 'Due site document', true, now()) RETURNING id`);
  await db.execute(sql`
    INSERT INTO safe_risk_assessments (client_id, site_id, title, requires_acknowledgement, created_at)
    VALUES (${primary}, ${siteId}, 'Second required document', true, now())`);
  await db.execute(sql`
    INSERT INTO safe_risk_assessments (client_id, title, requires_acknowledgement, created_at)
    VALUES (${foreign}, 'Foreign document', true, now() - interval '8 days')`);
  const gaps = await getOutstandingSafeTrackAcknowledgements(primary, new Date());
  assert.deepEqual(gaps.map((gap) => [gap.title, gap.staffTotal, gap.outstanding]), [
    ["Due site document", 1, ["Active"]],
    ["Second required document", 1, ["Active"]],
  ]);
  // One live acknowledgement clears the only active site staff member.
  await db.execute(sql`INSERT INTO safe_track_acknowledgements (client_id, document_type, document_id, staff_roster_id, staff_name) VALUES (${primary}, 'ra', ${doc.rows[0].id}, ${active.rows[0].id}, 'Active')`);
  const remaining = await getOutstandingSafeTrackAcknowledgements(primary);
  assert.deepEqual(remaining.map((gap) => gap.title), ["Second required document"]);
  await db.execute(sql`DELETE FROM safe_track_acknowledgements WHERE client_id = ${primary}`);
  assert.deepEqual(parseSafeTrackReminderSettings({}), {
    frequency: "daily",
    time: "08:50",
    timeZone: "Europe/London",
  });
  assert.equal(
    isSafeTrackReminderDue(
      new Date("2026-01-07T08:49:00.000Z"),
      parseSafeTrackReminderSettings({}),
    ),
    false,
  );
  assert.equal(
    isSafeTrackReminderDue(
      new Date("2026-01-07T08:50:00.000Z"),
      parseSafeTrackReminderSettings({}),
    ),
    true,
  );
  const weeklySettings = parseSafeTrackReminderSettings({
    safeTrackReminderFrequency: "weekly",
    safeTrackReminderTime: "08:50",
    accountTimezone: "Europe/London",
  });
  assert.equal(isSafeTrackReminderDue(new Date("2026-01-05T08:50:00.000Z"), weeklySettings), true);
  assert.equal(isSafeTrackReminderDue(new Date("2026-01-06T08:50:00.000Z"), weeklySettings), false);
  const sent = [];
  const deps = {
    now: () => new Date("2026-01-05T08:50:00.000Z"),
    listClients: async () => [{ id: primary, name: "Primary" }],
    getSettings: async () => ({
      safeTrackReminderFrequency: "weekly",
      safeTrackReminderTime: "08:50",
      accountTimezone: "Europe/London",
    }),
    isSafeTrackEntitled: async () => true,
    getRecipients: async () => ({ emails: ["manager@test.local", "MANAGER@test.local", "failed@test.local"] }),
    send: async ({ to, html }) => {
      if (to === "failed@test.local") throw new Error("mail failure");
      assert.match(html, /Risk Assessment/);
      if (to === "staff@test.local") {
        assert.match(html, /Your SafeTrack sign-offs are outstanding/);
        assert.doesNotMatch(html, /Waiting on:/);
      } else {
        assert.match(html, /Waiting on: Active/);
      }
      sent.push(to);
    },
  };
  // Two concurrent real database claims: only one scheduler gets the digest.
  const [one, two] = await Promise.all([runSafeTrackAckReminderJob(deps), runSafeTrackAckReminderJob(deps)]);
  assert.equal(one.remindersClaimed + two.remindersClaimed, 1);
  assert.deepEqual(sent.sort(), ["manager@test.local", "staff@test.local"]);
  assert.equal(one.errors + two.errors, 1, "partial email failure remains isolated");
  let fullyAcknowledgedSendCalled = false;
  const fullyAcknowledged = await runSafeTrackAckReminderJob({
    ...deps,
    getOutstanding: async () => [],
    claim: async () => { throw new Error("claim must not run without outstanding acknowledgements"); },
    send: async () => { fullyAcknowledgedSendCalled = true; },
  });
  assert.equal(fullyAcknowledged.clientsAlerted, 0);
  assert.equal(fullyAcknowledged.emailsSent, 0);
  assert.equal(fullyAcknowledgedSendCalled, false);
  const schedules = [];
  registerSafeTrackAckReminderSchedule((expression, task) => schedules.push({ expression, task }), async () => {});
  assert.equal(schedules[0].expression, "*/5 * * * *");
  console.log("SafeTrack acknowledgement reminder integration checks passed.");
} finally {
  if (pool) {
    for (const id of clientIds) {
      await pool.query("DELETE FROM safe_track_ack_reminder_log WHERE client_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM clients WHERE id = $1", [id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
  await rm(outDir, { recursive: true, force: true });
  if (pinoLinkCreated) await rm(pinoLink, { recursive: true, force: true });
}