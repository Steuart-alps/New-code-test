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
    check("failed send is released for retry", retry.clientsEmailed === 1 && sent.length === 1, JSON.stringify(retry));
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