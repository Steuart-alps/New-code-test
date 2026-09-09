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
    db, pool, sql, appSettingsTable, clientsTable, usersTable, fixTrackIssuesTable,
    getStaleDays, getOverdueUrgentIssues, runFixTrackOverdueAlertJob,
  } = lib;
  const tag = `fix-alert-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let clientId;
  let secondClientId;
  const neutralizedClientIds = [];
  const sent = [];

  try {
    // The workflow can run against a pre-task database, so make its test tables
    // self-contained while preserving the same schema as runtime migrations.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fix_track_alert_log (
        id serial PRIMARY KEY,
        client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        log_date date NOT NULL DEFAULT CURRENT_DATE,
        status text NOT NULL DEFAULT 'sent',
        idempotency_key text,
        issue_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
        recipient_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
        recipient_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        sent_at timestamp,
        updated_at timestamp NOT NULL DEFAULT now(),
        UNIQUE (client_id, log_date)
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fix_track_escalation_log (
        id serial PRIMARY KEY,
        client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        issue_id integer NOT NULL REFERENCES fix_track_issues(id) ON DELETE CASCADE,
        log_date date NOT NULL DEFAULT CURRENT_DATE,
        sent_at timestamp NOT NULL DEFAULT now(),
        UNIQUE (issue_id, log_date)
      )
    `);

    const activeClients = await db.execute(sql`
      SELECT c.id
      FROM clients c
      LEFT JOIN fix_track_alert_log l
        ON l.client_id = c.id AND l.log_date = CURRENT_DATE
      WHERE c.active = true AND l.id IS NULL
    `);
    for (const row of activeClients.rows) neutralizedClientIds.push(Number(row.id));
    await db.execute(sql`
      INSERT INTO fix_track_alert_log (client_id, log_date, status, sent_at)
      SELECT id, CURRENT_DATE, 'sent', now() FROM clients
      ON CONFLICT (client_id, log_date) DO NOTHING
    `);

    const [client] = await db.insert(clientsTable).values({
      name: `Fix alert test ${tag}`, slug: tag, active: true,
    }).returning();
    clientId = client.id;
    const [secondClient] = await db.insert(clientsTable).values({
      name: `Fix alert threshold test ${tag}`, slug: `${tag}-threshold`, active: true,
    }).returning();
    secondClientId = secondClient.id;
    await db.insert(appSettingsTable).values([
      { clientId, key: "fixTrackStaleDays", value: "1" },
      { clientId: secondClientId, key: "fixTrackStaleDays", value: "3" },
    ]);
    const [admin] = await db.insert(usersTable).values({
      email: `${tag}-admin@test.local`, passwordHash: "x", name: "Admin",
      role: "client_admin", clientId, active: true,
    }).returning();
    const [manager] = await db.insert(usersTable).values({
      email: `${tag}-manager@test.local`, passwordHash: "x", name: "Manager",
      role: "client_staff", clientId, active: true, isMaintenanceManager: true,
    }).returning();
    await db.insert(usersTable).values([
      { email: `${tag}-staff@test.local`, passwordHash: "x", name: "Staff", role: "client_staff", clientId, active: true },
      { email: `${tag}-inactive@test.local`, passwordHash: "x", name: "Inactive", role: "client_admin", clientId, active: false },
    ]);

    const old = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(fixTrackIssuesTable).values([
      { clientId, title: "Urgent past target", issueType: "electrical", location: "Plant room", priority: "urgent", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", targetDate: "2026-01-02", updatedAt: new Date() },
      { clientId, title: "Urgent gone cold", issueType: "plumbing", location: "Kitchen", priority: "urgent", status: "in_progress", reportedBy: "Tester", reportedDate: "2026-01-01", updatedAt: old },
      { clientId, title: "High gone cold", issueType: "general", location: "Office", priority: "high", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", updatedAt: old },
      { clientId, title: "Medium past target", issueType: "general", location: "Office", priority: "medium", status: "in_progress", reportedBy: "Tester", reportedDate: "2026-01-01", targetDate: "2026-01-02", updatedAt: new Date() },
      { clientId, title: "Urgent still fresh", issueType: "general", location: "Office", priority: "urgent", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", updatedAt: new Date() },
      { clientId, title: "Resolved urgent", issueType: "general", location: "Office", priority: "urgent", status: "resolved", reportedBy: "Tester", reportedDate: "2026-01-01", targetDate: "2026-01-02", updatedAt: old },
      { clientId: secondClientId, title: "Tenant two cold", issueType: "general", location: "Office", priority: "urgent", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", updatedAt: old },
      { clientId: secondClientId, title: "Tenant two overdue", issueType: "general", location: "Office", priority: "medium", status: "reported", reportedBy: "Tester", reportedDate: "2026-01-01", targetDate: "2026-01-02", updatedAt: new Date() },
    ]);

    const eligible = await getOverdueUrgentIssues(clientId);
    const titles = eligible.map((issue) => issue.title);
    check("past-target issues of any priority are selected", titles.includes("Urgent past target") && titles.includes("Medium past target"));
    check("urgent and high issues beyond the tenant threshold are selected", titles.includes("Urgent gone cold") && titles.includes("High gone cold"));
    check("fresh and resolved issues are excluded", !titles.includes("Urgent still fresh") && !titles.includes("Resolved urgent"));
    const secondEligible = await getOverdueUrgentIssues(secondClientId);
    const secondTitles = secondEligible.map((issue) => issue.title);
    check("different tenants load different stale thresholds",
      (await getStaleDays(clientId)) === 1 && (await getStaleDays(secondClientId)) === 3);
    check("longer tenant threshold excludes the same-age cold issue", !secondTitles.includes("Tenant two cold"));
    check("target-date eligibility ignores the tenant threshold", secondTitles.includes("Tenant two overdue"));
    // Keep the threshold-only tenant out of the table-scanning delivery checks.
    await db.execute(sql`
      INSERT INTO fix_track_alert_log (client_id, log_date, status, sent_at)
      VALUES (${secondClientId}, CURRENT_DATE, 'sent', now())
      ON CONFLICT (client_id, log_date) DO NOTHING
    `);

    const fakeSend = async (message) => { sent.push(message); };
    const first = await runFixTrackOverdueAlertJob(fakeSend);
    check("one client digest is sent", first.clientsEmailed === 1 && sent.length === 1, JSON.stringify(first));
    check(
      "active admins and maintenance managers receive the alert",
      JSON.stringify([...(sent[0]?.to ?? [])].sort()) === JSON.stringify([admin.email, manager.email].sort()),
      JSON.stringify(sent[0]?.to),
    );
    check("digest groups and links eligible issues",
      sent[0]?.html.includes("Electrical") &&
      sent[0]?.html.includes("Urgent gone cold") &&
      sent[0]?.html.includes(`/fix-track/`) &&
      !sent[0]?.html.includes("Urgent still fresh"));

    sent.length = 0;
    const second = await runFixTrackOverdueAlertJob(fakeSend);
    check("second run is deduplicated for the day", second.clientsEmailed === 0 && sent.length === 0, JSON.stringify(second));

    // Reset this test tenant and prove concurrent workers cannot split a digest.
    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    await db.execute(sql`DELETE FROM fix_track_escalation_log WHERE client_id = ${clientId}`);
    sent.length = 0;
    const concurrentSend = async (message) => {
      sent.push(message);
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await Promise.all([
      runFixTrackOverdueAlertJob(concurrentSend),
      runFixTrackOverdueAlertJob(concurrentSend),
    ]);
    check("concurrent runs produce one digest", sent.length === 1, `sent=${sent.length}`);

    // A failed provider call leaves a replayable pending snapshot. The retry
    // must use the exact same provider idempotency key.
    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    await db.execute(sql`DELETE FROM fix_track_escalation_log WHERE client_id = ${clientId}`);
    let failedKey;
    const failed = await runFixTrackOverdueAlertJob(async (message) => {
      failedKey = message.idempotencyKey;
      throw new Error("simulated outage");
    });
    check("email outage is reported and remains pending", failed.errors === 1, JSON.stringify(failed));
    sent.length = 0;
    const retry = await runFixTrackOverdueAlertJob(fakeSend);
    check("pending digest retries successfully", retry.clientsEmailed === 1 && sent.length === 1, JSON.stringify(retry));
    check("retry reuses the stable provider key", sent[0]?.idempotencyKey === failedKey, `${failedKey} != ${sent[0]?.idempotencyKey}`);

    // Simulate provider acceptance followed by process termination before the
    // database finalization transaction. Recovery must replay the persisted
    // snapshot with the same key and then finish it.
    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    await db.execute(sql`DELETE FROM fix_track_escalation_log WHERE client_id = ${clientId}`);
    sent.length = 0;
    const acceptedThenCrashed = await runFixTrackOverdueAlertJob(fakeSend, {
      afterSend: async () => { throw new Error("simulated process termination"); },
    });
    check("post-acceptance termination leaves a sending snapshot", acceptedThenCrashed.errors === 1 && sent.length === 1);
    const acceptedKey = sent[0]?.idempotencyKey;
    await db.execute(sql`
      UPDATE fix_track_alert_log
      SET updated_at = now() - interval '16 minutes'
      WHERE client_id = ${clientId} AND status = 'sending'
    `);
    sent.length = 0;
    const recovered = await runFixTrackOverdueAlertJob(fakeSend, { recoverOnly: true });
    check("stale sending snapshot is recovered", recovered.clientsEmailed === 1 && sent.length === 1, JSON.stringify(recovered));
    check("post-acceptance recovery reuses the provider key", sent[0]?.idempotencyKey === acceptedKey);

    // While recovery is actively dispatching yesterday's snapshot, today's
    // normal run must not create a second digest with a different daily key.
    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    await db.execute(sql`DELETE FROM fix_track_escalation_log WHERE client_id = ${clientId}`);
    await runFixTrackOverdueAlertJob(async () => { throw new Error("prepare pending snapshot"); });
    await db.execute(sql`
      UPDATE fix_track_alert_log
      SET log_date = CURRENT_DATE - 1, updated_at = now() - interval '16 minutes'
      WHERE client_id = ${clientId}
    `);
    sent.length = 0;
    let releaseRecovery;
    let recoveryStarted;
    const started = new Promise((resolve) => { recoveryStarted = resolve; });
    const release = new Promise((resolve) => { releaseRecovery = resolve; });
    const heldRecovery = runFixTrackOverdueAlertJob(async (message) => {
      sent.push(message);
      recoveryStarted();
      await release;
    }, { recoverOnly: true });
    await started;
    const overlappingDaily = await runFixTrackOverdueAlertJob(fakeSend);
    check("daily run is blocked while older recovery is sending",
      overlappingDaily.clientsEmailed === 0 && sent.length === 1,
      JSON.stringify(overlappingDaily));
    releaseRecovery();
    await heldRecovery;
    check("cross-day recovery sends only one digest", sent.length === 1, `sent=${sent.length}`);

    // Yesterday's cooldown suppresses a consecutive-day repeat; an older
    // cooldown permits a later reminder while the issue remains unresolved.
    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    await db.execute(sql`UPDATE fix_track_escalation_log SET log_date = CURRENT_DATE - 1 WHERE client_id = ${clientId}`);
    sent.length = 0;
    await runFixTrackOverdueAlertJob(fakeSend);
    check("yesterday's issue alert is not repeated today", sent.length === 0, `sent=${sent.length}`);
    await db.execute(sql`UPDATE fix_track_escalation_log SET log_date = CURRENT_DATE - 2 WHERE client_id = ${clientId}`);
    await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
    await runFixTrackOverdueAlertJob(fakeSend);
    check("older cooldown permits a later reminder", sent.length === 1, `sent=${sent.length}`);
  } finally {
    try {
      if (clientId) {
        await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM fix_track_escalation_log WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM fix_track_issues WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM app_settings WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM users WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
      }
      if (secondClientId) {
        await db.execute(sql`DELETE FROM fix_track_alert_log WHERE client_id = ${secondClientId}`);
        await db.execute(sql`DELETE FROM fix_track_escalation_log WHERE client_id = ${secondClientId}`);
        await db.execute(sql`DELETE FROM fix_track_issues WHERE client_id = ${secondClientId}`);
        await db.execute(sql`DELETE FROM app_settings WHERE client_id = ${secondClientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${secondClientId}`);
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