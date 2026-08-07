// Contractor compliance-expiry reminder job integration tests.
//
// Seeds a client with contractors at various insurance/DBS states, runs the
// real runContractorComplianceReminderJob with a fake email sender injected,
// and verifies:
//   - insurance expiring within 30 days OR already expired is alerted
//   - insurance expiring far in the future is NOT alerted
//   - a DBS check older than 3 years is alerted; a recent one is not
//   - only client_admin / maintenance-manager users are emailed
//   - a second run sends nothing (dedupe by contractor+milestone)
//   - renewing the insurance date produces a new milestone and re-alerts
//
// Usage: node tests/contractor-compliance-reminders.mjs   (DATABASE_URL must be set)
// Exits 0 when every check passes, 1 otherwise.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name} — ${detail}`);
    console.error(`FAIL: ${name} — ${detail}`);
  }
}

async function bundleEntry() {
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "contractor-compliance-reminders.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);`,
    },
  });
  return { outDir, outFile };
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
function yearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

function pathToUrl(p) {
  return new URL(`file://${p}`).href;
}

async function main() {
  const { outDir, outFile } = await bundleEntry();
  const lib = await import(pathToUrl(outFile));
  const { runContractorComplianceReminderJob, db, pool, clientsTable, usersTable, contractorsTable, sql } = lib;

  const tag = `contractorcompl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let clientId = null;

  async function seedContractor(label, fields) {
    const [row] = await db
      .insert(contractorsTable)
      .values({
        clientId,
        name: `Contractor ${label}`,
        email: `${tag}-${label}@test.local`,
        ...fields,
      })
      .returning();
    return row;
  }

  try {
    const [client] = await db
      .insert(clientsTable)
      .values({ name: `Contractor Compliance Test ${tag}`, slug: tag, active: true })
      .returning();
    clientId = client.id;

    // Managers who should be emailed.
    const [admin] = await db
      .insert(usersTable)
      .values({
        email: `${tag}-admin@test.local`,
        passwordHash: "x",
        name: "Admin",
        role: "client_admin",
        clientId,
        active: true,
      })
      .returning();
    // A viewer who must NOT be emailed.
    await db
      .insert(usersTable)
      .values({
        email: `${tag}-viewer@test.local`,
        passwordHash: "x",
        name: "Viewer",
        role: "viewer",
        clientId,
        active: true,
      })
      .returning();

    const insSoon = await seedContractor("ins-soon", { publicLiabilityExpiry: daysFromNow(10) });
    const insExpired = await seedContractor("ins-expired", { publicLiabilityExpiry: daysFromNow(-5) });
    const insFar = await seedContractor("ins-far", { publicLiabilityExpiry: daysFromNow(200) });
    const dbsOld = await seedContractor("dbs-old", { dbsCheckDate: yearsAgo(4) });
    const dbsRecent = await seedContractor("dbs-recent", { dbsCheckDate: yearsAgo(1) });

    // --- Run 1 ---
    const sent = [];
    const fakeSend = async ({ to, subject, html }) => { sent.push({ to, subject, html }); };
    const r1 = await runContractorComplianceReminderJob(fakeSend);

    check("run1: client alerted once", r1.clientsAlerted === 1, `clientsAlerted=${r1.clientsAlerted}`);
    check("run1: single digest email captured", sent.length === 1, `captured=${sent.length}`);
    check(
      "run1: three reminders claimed (ins-soon, ins-expired, dbs-old)",
      r1.remindersClaimed === 3,
      `remindersClaimed=${r1.remindersClaimed}`,
    );

    const html = sent[0]?.html ?? "";
    check("run1: ins-soon included", html.includes(insSoon.name), "missing ins-soon");
    check("run1: ins-expired included", html.includes(insExpired.name), "missing ins-expired");
    check("run1: dbs-old included", html.includes(dbsOld.name), "missing dbs-old");
    check("run1: ins-far NOT included", !html.includes(insFar.name), "ins-far wrongly included");
    check("run1: dbs-recent NOT included", !html.includes(dbsRecent.name), "dbs-recent wrongly included");

    const recipients = sent[0]?.to ?? [];
    check("run1: admin emailed", recipients.includes(admin.email), `recipients=${JSON.stringify(recipients)}`);
    check(
      "run1: viewer not emailed",
      !recipients.includes(`${tag}-viewer@test.local`),
      `recipients=${JSON.stringify(recipients)}`,
    );

    // --- Run 2: dedupe, nothing new ---
    sent.length = 0;
    const r2 = await runContractorComplianceReminderJob(fakeSend);
    check("run2: nothing re-sent", r2.remindersClaimed === 0 && sent.length === 0, `claimed=${r2.remindersClaimed}, captured=${sent.length}`);

    // --- Renew insurance → new milestone → re-alert ---
    await db.execute(sql`
      UPDATE contractors SET public_liability_expiry = ${daysFromNow(15)} WHERE id = ${insSoon.id}
    `);
    sent.length = 0;
    const r3 = await runContractorComplianceReminderJob(fakeSend);
    check(
      "run3: renewed insurance re-alerts (new milestone)",
      r3.remindersClaimed === 1 && sent.length === 1,
      `claimed=${r3.remindersClaimed}, captured=${sent.length}`,
    );
  } finally {
    try {
      if (clientId != null) {
        await db.execute(sql`DELETE FROM contractor_compliance_reminder_log WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM contractors WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM users WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
      }
    } catch (err) {
      console.error("Cleanup failed:", err);
      failures.push(`cleanup — ${err?.message ?? err}`);
    }
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
