// Trial-reminder job integration tests.
//
// Seeds clients in the dev database at various trial states, runs the real
// runTrialReminderJob with a fake email sender injected, and verifies:
//   - a client whose trial ends in 2 days gets exactly one reminder per
//     active consultant user (and nobody else)
//   - clients ending far in the future, already reminded, expired, or already
//     subscribed are skipped
//   - the sent flag is set, so a second run sends nothing
//   - if every send fails, the flag is released so the next run retries
//
// Pre-existing dev clients that happen to fall in the reminder window are
// temporarily marked as already-reminded and restored afterwards, so the test
// never emails (or permanently flags) real data.
//
// Usage: node tests/trial-reminders.mjs   (DATABASE_URL must be set)
// Exits 0 when every check passes, 1 otherwise.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
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
  // Output inside the tests dir so external bare imports (pino, pg, resend…)
  // resolve from artifacts/api-server/node_modules at runtime.
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "trial-reminders.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    // Bundle everything (workspace TS, pg, drizzle…) except packages that are
    // resolvable from artifacts/api-server/node_modules but do not bundle
    // cleanly (native addons, worker-thread transports).
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    // Keep bundled CJS packages (pg, express deps…) working in the ESM output.
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);`,
    },
  });
  return { outDir, outFile };
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function main() {
  const { outDir, outFile } = await bundleEntry();
  let lib;
  try {
    lib = await import(pathToUrl(outFile));
  } finally {
    // Sources are loaded into memory at import; safe to remove afterwards.
  }
  const { runTrialReminderJob, db, pool, clientsTable, usersTable, sql, eq, inArray } = lib;

  const tag = `trialrem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const seededClientIds = [];
  const neutralizedIds = [];

  async function seedClient(label, fields) {
    const [row] = await db
      .insert(clientsTable)
      .values({
        name: `Trial Reminder Test ${label}`,
        slug: `${tag}-${label}`,
        active: true,
        subscriptionStatus: "trial",
        ...fields,
      })
      .returning();
    seededClientIds.push(row.id);
    return row;
  }

  async function seedUser(clientId, label, role, active = true) {
    const email = `${tag}-${label}@test.local`;
    const [row] = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash: "x-not-a-real-hash",
        name: `Trial Test ${label}`,
        role,
        clientId,
        active,
      })
      .returning();
    return row;
  }

  try {
    // --- Neutralize pre-existing candidates so the run is hermetic ---
    const preExisting = await db.execute(sql`
      UPDATE clients
      SET trial_reminder_sent_at = now()
      WHERE active = true
        AND subscription_status IN ('trial', 'trialing')
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at > now()
        AND trial_reminder_sent_at IS NULL
      RETURNING id
    `);
    for (const r of preExisting.rows ?? []) neutralizedIds.push(r.id);

    // --- Seed the scenario ---
    const clientSend = await seedClient("send", { trialEndsAt: daysFromNow(2) });
    const clientFar = await seedClient("far", { trialEndsAt: daysFromNow(10) });
    const clientDone = await seedClient("done", {
      trialEndsAt: daysFromNow(2),
      trialReminderSentAt: new Date(),
    });
    const clientExpired = await seedClient("expired", { trialEndsAt: daysFromNow(-1) });
    const clientActive = await seedClient("subscribed", {
      trialEndsAt: daysFromNow(2),
      subscriptionStatus: "active",
    });

    const consultant1 = await seedUser(clientSend.id, "c1", "consultant");
    const consultant2 = await seedUser(clientSend.id, "c2", "consultant");
    const inactiveConsultant = await seedUser(clientSend.id, "c3-inactive", "consultant", false);
    const admin = await seedUser(clientSend.id, "admin", "client_admin");
    // Consultants for clients that must NOT be emailed.
    await seedUser(clientFar.id, "far-c", "consultant");
    await seedUser(clientDone.id, "done-c", "consultant");
    await seedUser(clientExpired.id, "expired-c", "consultant");
    await seedUser(clientActive.id, "subscribed-c", "consultant");

    // --- Run 1: exactly the right emails go out ---
    const sent = [];
    const fakeSend = async ({ to, subject }) => {
      sent.push({ to, subject });
    };

    const result1 = await runTrialReminderJob({ sendEmail: fakeSend });

    check("run1: one client notified", result1.clientsNotified === 1, `got ${result1.clientsNotified}`);
    check("run1: two emails sent", result1.emailsSent === 2 && sent.length === 2, `emailsSent=${result1.emailsSent}, captured=${sent.length}`);

    const recipients = sent.map((s) => s.to).sort();
    const expected = [consultant1.email, consultant2.email].sort();
    check(
      "run1: only active consultants of the 2-day client emailed",
      JSON.stringify(recipients) === JSON.stringify(expected),
      `got ${JSON.stringify(recipients)}, expected ${JSON.stringify(expected)}`,
    );
    check(
      "run1: inactive consultant and admin not emailed",
      !recipients.includes(inactiveConsultant.email) && !recipients.includes(admin.email),
      `recipients=${JSON.stringify(recipients)}`,
    );
    check(
      "run1: subject reflects 2 days remaining",
      sent.every((s) => s.subject.includes("2 days")),
      `subjects=${JSON.stringify(sent.map((s) => s.subject))}`,
    );

    const after = await db
      .select()
      .from(clientsTable)
      .where(inArray(clientsTable.id, seededClientIds));
    const byId = new Map(after.map((c) => [c.id, c]));
    check("run1: sent flag set on notified client", byId.get(clientSend.id)?.trialReminderSentAt != null, "flag still null");
    check("run1: far-future client flag untouched", byId.get(clientFar.id)?.trialReminderSentAt == null, "flag was set");
    check("run1: expired client flag untouched", byId.get(clientExpired.id)?.trialReminderSentAt == null, "flag was set");
    check("run1: subscribed client flag untouched", byId.get(clientActive.id)?.trialReminderSentAt == null, "flag was set");
    check(
      "run1: already-reminded client flag unchanged",
      byId.get(clientDone.id)?.trialReminderSentAt?.getTime() === clientDone.trialReminderSentAt.getTime(),
      "flag changed",
    );

    // --- Run 2: no duplicates ---
    sent.length = 0;
    const result2 = await runTrialReminderJob({ sendEmail: fakeSend });
    check("run2: nothing sent on second run", result2.emailsSent === 0 && sent.length === 0, `emailsSent=${result2.emailsSent}, captured=${sent.length}`);
    check("run2: no clients notified on second run", result2.clientsNotified === 0, `got ${result2.clientsNotified}`);

    // --- Failure path: if every send fails, the claim is released for retry ---
    await db
      .update(clientsTable)
      .set({ trialReminderSentAt: null })
      .where(eq(clientsTable.id, clientSend.id));
    const failingSend = async () => {
      throw new Error("simulated email outage");
    };
    const result3 = await runTrialReminderJob({ sendEmail: failingSend });
    check("run3: total send failure notifies nobody", result3.clientsNotified === 0 && result3.emailsSent === 0, JSON.stringify(result3));
    const [releasedRow] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, clientSend.id));
    check("run3: claim released after total failure", releasedRow?.trialReminderSentAt == null, "flag left set — client would never be retried");

    // --- And the retry then succeeds ---
    sent.length = 0;
    const result4 = await runTrialReminderJob({ sendEmail: fakeSend });
    check("run4: retry after outage sends again", result4.clientsNotified === 1 && sent.length === 2, `clientsNotified=${result4.clientsNotified}, captured=${sent.length}`);
  } finally {
    // --- Cleanup: remove seeded rows, restore neutralized real clients ---
    try {
      if (seededClientIds.length > 0) {
        await db.execute(sql`DELETE FROM users WHERE client_id IN (${sql.join(seededClientIds.map((id) => sql`${id}`), sql`, `)})`);
        await db.execute(sql`DELETE FROM clients WHERE id IN (${sql.join(seededClientIds.map((id) => sql`${id}`), sql`, `)})`);
      }
      if (neutralizedIds.length > 0) {
        await db.execute(sql`UPDATE clients SET trial_reminder_sent_at = NULL WHERE id IN (${sql.join(neutralizedIds.map((id) => sql`${id}`), sql`, `)})`);
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

function pathToUrl(p) {
  return new URL(`file://${p}`).href;
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
