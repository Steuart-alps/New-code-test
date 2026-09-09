import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function bundleEntry() {
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "fix-track-overdue-alerts.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);` },
  });
  return { outDir, outFile };
}

async function main() {
  const { outDir, outFile } = await bundleEntry();
  const lib = await import(new URL(`file://${outFile}`).href);
  const {
    db, pool, sql, clientsTable, usersTable, appSettingsTable, fixTrackIssuesTable,
    getStaleDays, getOverdueUrgentIssues, runFixTrackOverdueAlertJob,
  } = lib;
  const tag = `fix-alert-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let clientId;
  let neutralizedClientIds = [];
  const sent = [];

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fix_track_alert_log (
        id serial PRIMARY KEY,
        client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        log_date date NOT NULL,
        sent_at timestamp,
        status text NOT NULL DEFAULT 'claimed',
        claim_token text,
        claimed_at timestamp,
        UNIQUE (client_id, log_date)
      )
    `);
    await db.execute(sql`
      ALTER TABLE fix_track_alert_log
        ADD COLUMN IF NOT EXISTS status text,
        ADD COLUMN IF NOT EXISTS claim_token text,
        ADD COLUMN IF NOT EXISTS claimed_at timestamp
    `);
    await db.execute(sql`
      ALTER TABLE fix_track_alert_log
        ALTER COLUMN sent_at DROP NOT NULL,
        ALTER COLUMN sent_at DROP DEFAULT
    `);
    await db.execute(sql`
      UPDATE fix_track_alert_log
      SET status = CASE WHEN sent_at IS NULL THEN 'claimed' ELSE 'sent' END
      WHERE status IS NULL
    `);
    await db.execute(sql`
      ALTER TABLE fix_track_alert_log
        ALTER COLUMN status SET DEFAULT 'claimed',
        ALTER COLUMN status SET NOT NULL
    `);
    // Keep unrelated development tenants out of this table-scanning job.
    const existingClaims = await db.execute(sql`
      SELECT client_id FROM fix_track_alert_log WHERE log_date = CURRENT_DATE
    `);
    const claimed = new Set(existingClaims.rows.map((row) => Number(row.client_id)));
    const activeClients = await db.execute(sql`SELECT id FROM clients WHERE active = true`);
    neutralizedClientIds = activeClients.rows
      .map((row) => Number(row.id))
      .filter((id) => !claimed.has(id));
    await db.execute(sql`
      INSERT INTO fix_track_alert_log (client_id, log_date, sent_at, status)
      SELECT id, CURRENT_DATE, now(), 'sent' FROM clients
      ON CONFLICT (client_id, log_date) DO NOTHING
    `);

    const [client] = await db.insert(clientsTable).values({
      name: `Fix alert test ${tag}`, slug: tag, active: true,
    }).returning();
    clientId = client.id;
    const [admin] = await db.insert(usersTable).values({
      email: `${tag}-admin@test.local`, passwordHash: "x", name: "Admin",
      role: "client_admin", clientId, active: true,
    }).returning();
    await db.insert(usersTable).values([
      { email: `${tag}-manager@test.local`, passwordHash: "x", name: "Manager", role: "client_staff", clientId, active: true, isMaintenanceManager: true },
      { email: `${tag}-staff@test.local`, passwordHash: "x", name: "Staff", role: "client_staff", clientId, active: true },
      { email: `${tag}-inactive@test.local`, passwordHash: "x", name: "Inactive", role: "client_admin", clientId, active: false },
    ]);
    await db.insert(appSettingsTable).values({ clientId, key: "fixTrackStaleDays", value: "3" });
    check("client stale threshold is configurable", (await getStaleDays(clientId)) === 3);

    await db.insert(fixTrackIssuesTable).values([
      { clientId, title: "Urgent past target", issueType: "electrical", location: "Plant room", priority: "urgent", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", targetDate: "2026-01-02", updatedAt: new Date() },
      { clientId, title: "Urgent gone cold", issueType: "plumbing", location: "Kitchen", priority: "urgent", status: "in_progress", reportedBy: "Tester", reportedDate: "2026-01-01", updatedAt: new Date(Date.now() - 4 * 86_400_000) },
      { clientId, title: "Urgent still fresh", issueType: "general", location: "Office", priority: "urgent", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", updatedAt: new Date() },
      { clientId, title: "High gone cold", issueType: "general", location: "Office", priority: "high", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", updatedAt: new Date(Date.now() - 10 * 86_400_000) },
      { clientId, title: "Resolved urgent", issueType: "general", location: "Office", priority: "urgent", status: "resolved", reportedBy: "Tester", reportedDate: "2026-01-01", targetDate: "2026-01-02", updatedAt: new Date(Date.now() - 10 * 86_400_000) },
    ]);

    const eligible = await getOverdueUrgentIssues(clientId, 3);
    const titles = eligible.map((issue) => issue.title);
    check("past-target urgent issue is selected", titles.includes("Urgent past target"));
    check("gone-cold urgent issue is selected", titles.includes("Urgent gone cold"));
    check("fresh urgent issue is excluded", !titles.includes("Urgent still fresh"));
    check("non-urgent stale issue is excluded", !titles.includes("High gone cold"));
    check("resolved urgent issue is excluded", !titles.includes("Resolved urgent"));

    const fakeSend = async (message) => sent.push(message);
    const first = await runFixTrackOverdueAlertJob(fakeSend);
    check("one client digest is sent", first.clientsEmailed === 1 && sent.length === 1, JSON.stringify(first));
    check(
      "only active managers receive the alert",
      JSON.stringify([...(sent[0]?.to ?? [])].sort()) === JSON.stringify([admin.email, `${tag}-manager@test.local`].sort()),
      JSON.stringify(sent[0]?.to),
    );
    check("email uses the tenant email configuration", sent[0]?.clientId === clientId, `clientId=${sent[0]?.clientId}`);
    check("email uses a stable daily provider key",
      sent[0]?.idempotencyKey === `fixtrack-urgent-alert:${clientId}:${new Date().toISOString().slice(0, 10)}`,
      sent[0]?.idempotencyKey);
    check("digest includes only eligible urgent jobs",
      sent[0]?.html.includes("Urgent past target") &&
      sent[0]?.html.includes("Urgent gone cold") &&
      !sent[0]?.html.includes("High gone cold"));

    sent.length = 0;
    const second = await runFixTrackOverdueAlertJob(fakeSend);
    check("second run is deduplicated for the day", second.clientsEmailed === 0 && sent.length === 0, JSON.stringify(second));

    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    const concurrentSends = [];
    const delayedSend = async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrentSends.push(message);
    };
    await Promise.all([
      runFixTrackOverdueAlertJob(delayedSend),
      runFixTrackOverdueAlertJob(delayedSend),
    ]);
    check("concurrent workers send only one digest", concurrentSends.length === 1, `sends=${concurrentSends.length}`);

    const dailyKey = concurrentSends[0]?.idempotencyKey;
    await db.execute(sql`
      UPDATE fix_track_alert_log
      SET status = 'claimed', claim_token = 'crashed-worker',
          claimed_at = now() - interval '1 minute', sent_at = NULL
      WHERE client_id = ${clientId} AND log_date = CURRENT_DATE
    `);
    sent.length = 0;
    const liveLease = await runFixTrackOverdueAlertJob(fakeSend);
    check("live claim lease is not stolen", liveLease.clientsEmailed === 0 && sent.length === 0, JSON.stringify(liveLease));

    await db.execute(sql`
      UPDATE fix_track_alert_log
      SET claimed_at = now() - interval '31 minutes'
      WHERE client_id = ${clientId} AND log_date = CURRENT_DATE
    `);
    const recovered = await runFixTrackOverdueAlertJob(fakeSend);
    check("expired crash claim is recovered", recovered.clientsEmailed === 1 && sent.length === 1, JSON.stringify(recovered));
    check("restart retry keeps the same provider key", sent[0]?.idempotencyKey === dailyKey, `${sent[0]?.idempotencyKey} !== ${dailyKey}`);

    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    const failed = await runFixTrackOverdueAlertJob(async () => { throw new Error("simulated outage"); });
    check("email outage is reported", failed.errors === 1, JSON.stringify(failed));
    const retry = await runFixTrackOverdueAlertJob(fakeSend);
    check("failed email claim is released for retry", retry.clientsEmailed === 1, JSON.stringify(retry));
  } finally {
    try {
      if (clientId) {
        await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM fix_track_issues WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM app_settings WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM users WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
      }
      for (const id of neutralizedClientIds) {
        await db.execute(sql`
          DELETE FROM fix_track_alert_log
          WHERE client_id = ${id} AND log_date = CURRENT_DATE
        `);
      }
    } catch (err) {
      failures.push(`cleanup — ${err?.message ?? err}`);
    }
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});