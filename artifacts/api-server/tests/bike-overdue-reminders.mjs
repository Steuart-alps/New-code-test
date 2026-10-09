import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) passed++;
  else {
    failures.push(`${name} — ${detail}`);
    console.error(`FAIL: ${name} — ${detail}`);
  }
}

async function bundleEntry() {
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "bike-overdue-reminders.entry.ts")],
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
    runBikeOverdueJob, BIKE_OVERDUE_REPEAT_INTERVALS_DAYS, parseBikeOverdueRepeatInterval,
    appSettingsTable, db, pool, clientsTable, usersTable, sql,
  } = lib;
  const tag = `bike-overdue-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let clientId;
  let dailyClientId;
  let idemClientId;
  const sent = [];

  try {
    check("one-time cadence is valid by default", parseBikeOverdueRepeatInterval("0") === 0, "default cadence");
    check("configured repeat intervals are selectable",
      JSON.stringify(BIKE_OVERDUE_REPEAT_INTERVALS_DAYS) === JSON.stringify([1, 3, 7, 14])
        && BIKE_OVERDUE_REPEAT_INTERVALS_DAYS.every((days) => parseBikeOverdueRepeatInterval(String(days)) === days),
      "repeat cadence choices");
    check("invalid repeat intervals fail validation",
      [null, "", "2", "7.0", "-1", 7].every((value) => parseBikeOverdueRepeatInterval(value) === null),
      "invalid cadence accepted");
    // This standalone suite does not boot the API, so it must install the
    // additive runtime-migration pieces used by the reminder claim protocol.
    await db.execute(sql`ALTER TABLE bike_hire_records ADD COLUMN IF NOT EXISTS overdue_notification_claim_token text`);
    await db.execute(sql`ALTER TABLE bike_hire_records ADD COLUMN IF NOT EXISTS overdue_notification_claimed_at timestamp`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_bike_hire_overdue_alerts"
      ON bike_hire_records (client_id, status, return_date_expected, overdue_notified_at)
    `);

    const [client] = await db.insert(clientsTable).values({
      name: `Bike overdue test ${tag}`,
      slug: tag,
      active: true,
    }).returning();
    clientId = client.id;

    const [admin] = await db.insert(usersTable).values({
      email: `${tag}-admin@test.local`, passwordHash: "x", name: "Admin",
      role: "client_admin", clientId, active: true,
    }).returning();
    await db.insert(usersTable).values([
      { email: `${tag}-staff@test.local`, passwordHash: "x", name: "Staff", role: "client_staff", clientId, active: true },
      { email: `${tag}-manager@test.local`, passwordHash: "x", name: "Manager", role: "client_staff", clientId, active: true, isMaintenanceManager: true },
      { email: `${tag}-inactive@test.local`, passwordHash: "x", name: "Inactive", role: "client_admin", clientId, active: false },
    ]);

    const bikeResult = await db.execute(sql`
      INSERT INTO bikes (client_id, ref, name, type, status)
      VALUES (${clientId}, 'BIKE-57', 'Test bike', 'hybrid', 'hired')
      RETURNING id
    `);
    const bikeId = bikeResult.rows[0].id;
    await db.execute(sql`
      INSERT INTO bike_hire_records
        (client_id, bike_id, guest_name, guest_contact, hire_date, return_date_expected, status)
      VALUES
        (${clientId}, ${bikeId}, 'Overdue Guest', '07000 000057', CURRENT_DATE - 3, CURRENT_DATE - 2, 'active'),
        (${clientId}, ${bikeId}, 'Due Today', 'today@test.local', CURRENT_DATE, CURRENT_DATE, 'active'),
        (${clientId}, ${bikeId}, 'Already Returned', NULL, CURRENT_DATE - 4, CURRENT_DATE - 3, 'returned')
    `);

    const fakeSend = async (message) => sent.push(message);
    const deps = { sendEmail: fakeSend, sendPush: async () => 0 };
    const first = await runBikeOverdueJob(deps);
    check("first run sends the overdue hire's digest",
      first.clientsEmailed === 1 && sent.length === 1 && sent[0]?.html.includes("Overdue Guest"),
      JSON.stringify(first));
    check("only tenant managers receive digest",
      JSON.stringify([...(sent[0]?.to ?? [])].sort()) === JSON.stringify([admin.email, `${tag}-manager@test.local`].sort()),
      JSON.stringify(sent[0]?.to));
    check("digest lists bike reference", sent[0]?.html.includes("BIKE-57"), "bike reference missing");
    check("digest lists guest and contact", sent[0]?.html.includes("Overdue Guest") && sent[0]?.html.includes("07000 000057"), "guest details missing");
    check("digest lists days overdue", sent[0]?.html.includes("2 days overdue"), "days overdue missing");
    check("today and returned hires excluded", !sent[0]?.html.includes("Due Today") && !sent[0]?.html.includes("Already Returned"), "ineligible hire included");

    sent.length = 0;
    const second = await runBikeOverdueJob(deps);
    check("second run is idempotent for the already-notified hire",
      second.clientsEmailed === 0 && sent.length === 0, JSON.stringify(second));

    await db.execute(sql`
      UPDATE bike_hire_records
      SET overdue_notified_at = now() - (30 * interval '1 day')
      WHERE client_id = ${clientId} AND guest_name = 'Overdue Guest'
    `);
    const disabledRepeat = await runBikeOverdueJob(deps);
    check("missing setting keeps the one-time default after a long delay",
      disabledRepeat.clientsEmailed === 0 && sent.length === 0, JSON.stringify(disabledRepeat));

    // A second tenant opts into daily reminders. Its setting must not change
    // the first tenant's one-time default or later weekly choice.
    const [dailyClient] = await db.insert(clientsTable).values({
      name: `Bike overdue daily test ${tag}`,
      slug: `${tag}-daily`,
      active: true,
    }).returning();
    dailyClientId = dailyClient.id;
    const [dailyAdmin] = await db.insert(usersTable).values({
      email: `${tag}-daily-admin@test.local`, passwordHash: "x", name: "Daily Admin",
      role: "client_admin", clientId: dailyClientId, active: true,
    }).returning();
    const dailyBike = await db.execute(sql`
      INSERT INTO bikes (client_id, ref, name, type, status)
      VALUES (${dailyClientId}, 'BIKE-58', 'Daily test bike', 'hybrid', 'hired')
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO bike_hire_records
        (client_id, bike_id, guest_name, hire_date, return_date_expected, status, overdue_notified_at)
      VALUES
        (${dailyClientId}, ${dailyBike.rows[0].id}, 'Daily Cadence Guest', CURRENT_DATE - 5,
         CURRENT_DATE - 4, 'active', now() - (2 * interval '1 day'))
    `);
    await db.insert(appSettingsTable).values({
      clientId: dailyClientId, key: "bike_overdue_repeat_interval_days", value: "1",
    });

    await db.execute(sql`
      UPDATE bike_hire_records SET overdue_notified_at = now() - (6 * interval '1 day')
      WHERE client_id = ${clientId} AND guest_name = 'Overdue Guest'
    `);
    sent.length = 0;
    const dailyRepeat = await runBikeOverdueJob(deps);
    check("daily cadence repeats after one day, while unconfigured client stays one-time",
      dailyRepeat.clientsEmailed === 1 && sent.length === 1
        && sent[0]?.to?.includes(dailyAdmin.email)
        && sent[0]?.html.includes("Daily Cadence Guest")
        && !sent[0]?.html.includes("Overdue Guest"),
      JSON.stringify(dailyRepeat));

    sent.length = 0;
    await db.insert(appSettingsTable).values({
      clientId, key: "bike_overdue_repeat_interval_days", value: "7",
    });
    const beforeWeeklyCadence = await runBikeOverdueJob(deps);
    check("weekly cadence waits until seven days have elapsed",
      beforeWeeklyCadence.clientsEmailed === 0 && sent.length === 0, JSON.stringify(beforeWeeklyCadence));

    await db.execute(sql`
      UPDATE bike_hire_records SET overdue_notified_at = now() - (7 * interval '1 day')
      WHERE client_id = ${clientId} AND guest_name = 'Overdue Guest'
    `);
    const repeats = [];
    const concurrentSend = async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      repeats.push(message);
    };
    const [concurrentA, concurrentB] = await Promise.all([
      runBikeOverdueJob({ sendEmail: concurrentSend, sendPush: async () => { throw new Error("push unavailable"); } }),
      runBikeOverdueJob({ sendEmail: concurrentSend, sendPush: async () => { throw new Error("push unavailable"); } }),
    ]);
    check("weekly repeat is sent once under concurrent workers",
      repeats.length === 1 && repeats[0]?.html.includes("Overdue Guest")
        && !repeats[0]?.html.includes("Daily Cadence Guest"),
      JSON.stringify({ concurrentA, concurrentB, sends: repeats.length }));
    sent.length = 0;
    const afterPushFailure = await runBikeOverdueJob(deps);
    check("push partial failure does not reopen email claim",
      afterPushFailure.clientsEmailed === 0 && sent.length === 0, JSON.stringify(afterPushFailure));

    await db.execute(sql`
      UPDATE bike_hire_records
      SET status = 'returned', overdue_notified_at = now() - (7 * interval '1 day')
      WHERE client_id = ${clientId} AND guest_name = 'Overdue Guest'
    `);
    await db.execute(sql`
      UPDATE bike_hire_records
      SET status = 'cancelled', overdue_notified_at = now() - (7 * interval '1 day')
      WHERE client_id = ${dailyClientId} AND guest_name = 'Daily Cadence Guest'
    `);
    sent.length = 0;
    const returned = await runBikeOverdueJob(deps);
    check("returned and cancelled hires suppress repeats",
      returned.clientsEmailed === 0 && sent.length === 0, JSON.stringify(returned));

    // Simulate a brand-new hire state: the earlier initial alert's outbox row
    // would otherwise mark this exact reminder period as already handled today.
    await db.execute(sql`DELETE FROM bike_overdue_notification_log WHERE client_id = ${clientId}`);
    await db.execute(sql`
      UPDATE bike_hire_records
      SET status = 'active', overdue_notified_at = NULL,
          overdue_notification_claim_token = NULL, overdue_notification_claimed_at = NULL
      WHERE client_id = ${clientId} AND guest_name = 'Overdue Guest'
    `);
    const failed = await runBikeOverdueJob({
      sendEmail: async () => { throw new Error("simulated outage"); },
      sendPush: async () => 0,
    });
    check("email failure is recorded", failed.errors === 1, JSON.stringify(failed));
    sent.length = 0;
    const retry = await runBikeOverdueJob(deps);
    check("failed send is retried", retry.clientsEmailed === 1 && sent.length === 1, JSON.stringify(retry));

    // ---- Uncertain provider outcome: accepted, but the response times out ----
    const [idemClient] = await db.insert(clientsTable).values({
      name: `Bike overdue idempotency test ${tag}`,
      slug: `${tag}-idem`,
      active: true,
    }).returning();
    idemClientId = idemClient.id;
    const [idemAdmin] = await db.insert(usersTable).values({
      email: `${tag}-idem-admin@test.local`, passwordHash: "x", name: "Idem Admin",
      role: "client_admin", clientId: idemClientId, active: true,
    }).returning();
    const idemBike = await db.execute(sql`
      INSERT INTO bikes (client_id, ref, name, type, status)
      VALUES (${idemClientId}, 'BIKE-59', 'Idempotency bike', 'hybrid', 'hired')
      RETURNING id
    `);
    const idemHire = await db.execute(sql`
      INSERT INTO bike_hire_records
        (client_id, bike_id, guest_name, hire_date, return_date_expected, status)
      VALUES (${idemClientId}, ${idemBike.rows[0].id}, 'Timeout Guest', CURRENT_DATE - 3, CURRENT_DATE - 1, 'active')
      RETURNING id
    `);
    const idemHireId = idemHire.rows[0].id;
    await db.insert(appSettingsTable).values({
      clientId: idemClientId, key: "bike_overdue_repeat_interval_days", value: "1",
    });

    // Fake provider with Resend's documented key semantics: a repeated
    // idempotency key with the same payload returns the original message
    // without delivering again; a changed payload is rejected (409).
    const provider = {
      accepted: new Map(),
      delivered: [],
      calls: [],
      timeoutsAfterAccept: 0,
      async send(message) {
        provider.calls.push(message);
        if (message.to?.every((to) => !to.startsWith(`${tag}-idem-`))) {
          // Other fixture tenants are irrelevant to this provider.
          return;
        }
        const body = JSON.stringify({ to: message.to, subject: message.subject, html: message.html });
        const key = message.idempotencyKey;
        if (key && provider.accepted.has(key)) {
          if (provider.accepted.get(key) !== body) throw new Error("409 invalid_idempotent_request");
          return;
        }
        if (key) provider.accepted.set(key, body);
        provider.delivered.push(message);
        if (provider.timeoutsAfterAccept > 0) {
          provider.timeoutsAfterAccept--;
          throw new Error("Simulated provider response timeout after acceptance");
        }
      },
    };
    const idemDeps = { sendEmail: provider.send, sendPush: async () => 0 };
    const idemCalls = () => provider.calls.filter((m) => m.to?.includes(idemAdmin.email));
    const outbox = async () => (await db.execute(sql`
      SELECT status, idempotency_key, attempts FROM bike_overdue_notification_log
      WHERE client_id = ${idemClientId} ORDER BY id
    `)).rows;
    const hireState = async () => (await db.execute(sql`
      SELECT overdue_notified_at, overdue_notification_claim_token FROM bike_hire_records WHERE id = ${idemHireId}
    `)).rows[0];

    provider.timeoutsAfterAccept = 1;
    const uncertain = await runBikeOverdueJob(idemDeps);
    const afterTimeout = await outbox();
    check("uncertain timeout is reported as an error",
      uncertain.errors === 1 && provider.delivered.length === 1, JSON.stringify({ uncertain, delivered: provider.delivered.length }));
    check("uncertain send keeps a pending digest with a stable key",
      afterTimeout.length === 1 && afterTimeout[0].status === "pending"
        && afterTimeout[0].idempotency_key.startsWith(`bike-overdue-${idemClientId}-`),
      JSON.stringify(afterTimeout));
    check("uncertain send does not record a successful alert",
      (await hireState()).overdue_notified_at === null, "hire marked notified after timeout");

    const retried = await runBikeOverdueJob(idemDeps);
    const retryCalls = idemCalls();
    check("retry after uncertain timeout does not deliver a second message",
      provider.delivered.length === 1 && retried.clientsEmailed === 1 && retried.errors === 0,
      JSON.stringify({ retried, delivered: provider.delivered.length }));
    check("retry replays the identical request under the same idempotency key",
      retryCalls.length === 2
        && retryCalls[0].idempotencyKey === retryCalls[1].idempotencyKey
        && retryCalls[0].html === retryCalls[1].html
        && retryCalls[0].subject === retryCalls[1].subject,
      JSON.stringify(retryCalls.map((m) => m.idempotencyKey)));
    const afterRetry = await outbox();
    const retriedHire = await hireState();
    check("confirmed retry finalises the digest and the hire",
      afterRetry.length === 1 && afterRetry[0].status === "sent" && afterRetry[0].attempts === 2
        && retriedHire.overdue_notified_at !== null && retriedHire.overdue_notification_claim_token === null,
      JSON.stringify({ afterRetry, retriedHire }));
    const noRepeat = await runBikeOverdueJob(idemDeps);
    check("finalised digest is not sent again in the same period",
      idemCalls().length === 2 && noRepeat.clientsEmailed === 0, JSON.stringify(noRepeat));

    // The next cadence period is a different reminder and gets a new key. Its
    // uncertain outcome is resolved by the recovery-only replay.
    await db.execute(sql`
      UPDATE bike_hire_records SET overdue_notified_at = now() - (25 * interval '1 hour') WHERE id = ${idemHireId}
    `);
    provider.timeoutsAfterAccept = 1;
    await runBikeOverdueJob(idemDeps);
    const recovered = await runBikeOverdueJob(idemDeps, { recoverOnly: true });
    const periods = await outbox();
    check("next cadence period uses a new idempotency key",
      periods.length === 2 && periods[0].idempotency_key !== periods[1].idempotency_key,
      JSON.stringify(periods));
    check("recovery-only replay confirms the uncertain repeat without duplicating it",
      provider.delivered.length === 2 && recovered.clientsEmailed === 1 && periods[1].status === "sent",
      JSON.stringify({ recovered, delivered: provider.delivered.length, periods }));

    // A replay must not resend an alert once every hire in it has been returned.
    await db.execute(sql`
      UPDATE bike_hire_records SET overdue_notified_at = now() - (25 * interval '1 hour') WHERE id = ${idemHireId}
    `);
    provider.timeoutsAfterAccept = 1;
    await runBikeOverdueJob(idemDeps);
    await db.execute(sql`UPDATE bike_hire_records SET status = 'returned' WHERE id = ${idemHireId}`);
    const callsBefore = idemCalls().length;
    const afterReturn = await runBikeOverdueJob(idemDeps, { recoverOnly: true });
    const cancelled = await outbox();
    check("returned hire cancels its unconfirmed digest without another send",
      idemCalls().length === callsBefore && afterReturn.clientsEmailed === 0
        && cancelled.length === 3 && cancelled[2].status === "cancelled"
        && (await hireState()).overdue_notification_claim_token === null,
      JSON.stringify({ afterReturn, cancelled }));

    // An unconfirmed digest older than the provider's key window is expired
    // rather than replayed, and stops blocking new alerts for the client.
    await db.execute(sql`
      UPDATE bike_hire_records SET status = 'active', overdue_notified_at = now() - (25 * interval '1 hour') WHERE id = ${idemHireId}
    `);
    provider.timeoutsAfterAccept = 1;
    await runBikeOverdueJob(idemDeps);
    await db.execute(sql`
      UPDATE bike_overdue_notification_log SET created_at = now() - (24 * interval '1 hour')
      WHERE client_id = ${idemClientId} AND status = 'pending'
    `);
    const callsBeforeExpiry = idemCalls().length;
    await runBikeOverdueJob(idemDeps, { recoverOnly: true });
    const expired = await outbox();
    check("digest outside the provider idempotency window is expired, not replayed",
      idemCalls().length === callsBeforeExpiry && expired.at(-1)?.status === "expired"
        && (await hireState()).overdue_notification_claim_token === null,
      JSON.stringify(expired));
  } finally {
    try {
      if (clientId) {
        await db.execute(sql`DELETE FROM bike_hire_records WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM bikes WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM users WHERE client_id = ${clientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`);
      }
      if (dailyClientId) {
        await db.execute(sql`DELETE FROM bike_hire_records WHERE client_id = ${dailyClientId}`);
        await db.execute(sql`DELETE FROM bikes WHERE client_id = ${dailyClientId}`);
        await db.execute(sql`DELETE FROM users WHERE client_id = ${dailyClientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${dailyClientId}`);
      }
      if (idemClientId) {
        await db.execute(sql`DELETE FROM bike_hire_records WHERE client_id = ${idemClientId}`);
        await db.execute(sql`DELETE FROM bikes WHERE client_id = ${idemClientId}`);
        await db.execute(sql`DELETE FROM users WHERE client_id = ${idemClientId}`);
        await db.execute(sql`DELETE FROM app_settings WHERE client_id = ${idemClientId}`);
        await db.execute(sql`DELETE FROM clients WHERE id = ${idemClientId}`);
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