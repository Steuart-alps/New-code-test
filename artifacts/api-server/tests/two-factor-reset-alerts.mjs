// Durable two-factor reset security alerts: provider failure then retry,
// restart recovery in a new process, deduplication, and privacy of the queue.
// Run through test:two-factor-reset-alerts: the fresh-schema harness owns a
// disposable database and API; email is captured, never sent.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.API_BASE;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1" || !base
    || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error("Use test:two-factor-reset-alerts with the disposable local API harness.");
}

const SUBJECT = "Security alert: your two-factor authentication was reset";
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
    entryPoints: [path.join(testsDir, "two-factor-reset-alerts.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: `import { createRequire as __bannerCrReq } from 'node:module';\nglobalThis.require = __bannerCrReq(import.meta.url);` },
  });
  // A separate worker process, standing in for the API after a restart.
  const childFile = path.join(outDir, "worker.mjs");
  await writeFile(childFile, `
    import { appendFileSync } from "node:fs";
    const lib = await import(${JSON.stringify(new URL(`file://${outFile}`).href)});
    const [mode, arg, outbox, offset] = process.argv.slice(2);
    const record = (message) => appendFileSync(outbox, JSON.stringify(message) + "\\n");
    if (mode === "crash-after-accept") {
      // The provider accepts the message, then the process dies before it can
      // record the outcome.
      await lib.deliverTwoFactorResetAlert(Number(arg), {
        sendEmail: async (message) => { record(message); process.exit(17); },
      });
      process.exit(3);
    }
    const result = await lib.runTwoFactorResetAlertRecovery(
      { sendEmail: async (message) => record(message) },
      { userIds: JSON.parse(arg), clockOffsetSeconds: Number(offset) },
    );
    console.log(JSON.stringify(result));
    await lib.pool.end();
  `);
  return { outDir, outFile, childFile };
}

async function readJsonLines(file) {
  const raw = await readFile(file, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  const { outDir, outFile, childFile } = await bundleEntry();
  const lib = await import(new URL(`file://${outFile}`).href);
  const {
    resetTwoFactorWithAlert, deliverTwoFactorResetAlert, runTwoFactorResetAlertRecovery,
    TWO_FACTOR_RESET_ALERT_LEASE_MINUTES, db, pool, usersTable, sql,
  } = lib;
  const tag = `tfa-alert-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userIds = [];
  const secrets = [];
  const childOutbox = path.join(outDir, "worker-outbox.jsonl");
  const worker = (...args) => spawnSync(process.execPath, [childFile, ...args.map(String)], {
    env: process.env, encoding: "utf8", timeout: 60_000,
  });

  async function makeUser(label, extra = {}) {
    const secret = `JBSWY3DP${randomUUID().replace(/-/g, "").toUpperCase()}`;
    const recoveryCode = `RC-${randomUUID()}`;
    const recoveryHash = createHash("sha256").update(recoveryCode).digest("hex");
    const passwordHash = `fixture-hash-${randomUUID()}`;
    secrets.push(secret, recoveryCode, recoveryHash, passwordHash);
    const [user] = await db.insert(usersTable).values({
      email: `${tag}-${label}@test.local`, passwordHash, name: `Alert <${label}> & Co`,
      role: "client_staff", active: true,
      totpSecret: secret, totpEnabled: true, totpRecoveryHash: recoveryHash,
      ...extra,
    }).returning();
    await db.execute(sql`INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES (${user.id}, ${recoveryHash})`);
    userIds.push(user.id);
    return user;
  }
  async function alertsFor(userId) {
    return (await db.execute(sql`
      SELECT id, status, attempts, delivery_key, claim_token,
        next_attempt_at > now() AS backing_off
      FROM two_factor_reset_notifications WHERE user_id = ${userId} ORDER BY id
    `)).rows;
  }
  async function userState(userId) {
    return (await db.execute(sql`
      SELECT totp_enabled, totp_secret, totp_recovery_hash, updated_at FROM users WHERE id = ${userId}
    `)).rows[0];
  }
  const cleared = (state) => state?.totp_enabled === false && state.totp_secret === null && state.totp_recovery_hash === null;
  const graceSeconds = 180; // beyond the route's first-attempt grace and the first backoff

  try {
    // ---- Provider failure, then a successful retry ----------------------
    const u1 = await makeUser("failure");
    const reset1 = await resetTwoFactorWithAlert(u1.id);
    check("reset queues one alert", Number.isInteger(reset1?.alertId), JSON.stringify(reset1));
    const afterReset1 = await userState(u1.id);
    check("reset clears two-factor enrolment", cleared(afterReset1));

    const failedKeys = [];
    let threw = false;
    try {
      await deliverTwoFactorResetAlert(reset1.alertId, {
        sendEmail: async (message) => { failedKeys.push(message.idempotencyKey); throw new Error("provider 503"); },
      });
    } catch { threw = true; }
    check("provider failure surfaces to the caller for logging", threw);
    const [failedRow] = await alertsFor(u1.id);
    check("failed alert stays pending with backoff",
      failedRow?.status === "pending" && failedRow.attempts === 1 && failedRow.backing_off === true && failedRow.claim_token === null,
      JSON.stringify(failedRow));
    check("provider failure does not undo the reset", cleared(await userState(u1.id)));

    const sent = [];
    const okSend = async (message) => { sent.push(message); };
    const early = await runTwoFactorResetAlertRecovery({ sendEmail: okSend }, { userIds: [u1.id] });
    check("recovery respects the retry backoff", early.examined === 0 && sent.length === 0, JSON.stringify(early));

    const retried = await runTwoFactorResetAlertRecovery({ sendEmail: okSend }, { userIds: [u1.id], clockOffsetSeconds: graceSeconds });
    check("recovery delivers the alert once the backoff passes", retried.sent === 1 && sent.length === 1, JSON.stringify(retried));
    check("retry goes to the affected user with the security subject",
      sent[0]?.to === u1.email && sent[0]?.subject === SUBJECT);
    check("retry reuses the provider idempotency key of the failed attempt",
      !!failedKeys[0] && sent[0]?.idempotencyKey === failedKeys[0], `${failedKeys[0]} vs ${sent[0]?.idempotencyKey}`);
    check("retry renders the persisted reset time",
      sent[0]?.text.includes(`${new Date(afterReset1.updated_at).toISOString()} (UTC)`));
    check("retry HTML escapes the user's name", sent[0]?.html.includes("Hello Alert &lt;failure&gt; &amp; Co"));
    const [sentRow] = await alertsFor(u1.id);
    check("delivered alert is recorded as sent", sentRow?.status === "sent" && sentRow.attempts === 2, JSON.stringify(sentRow));
    const afterRetry = await userState(u1.id);
    check("retry never repeats the reset",
      cleared(afterRetry) && new Date(afterRetry.updated_at).getTime() === new Date(afterReset1.updated_at).getTime());

    // ---- Deduplication ---------------------------------------------------
    const again = await runTwoFactorResetAlertRecovery({ sendEmail: okSend }, { userIds: [u1.id], clockOffsetSeconds: 24 * 3600 });
    check("a sent alert is never re-sent", again.examined === 0 && sent.length === 1, JSON.stringify(again));
    const directAgain = await deliverTwoFactorResetAlert(reset1.alertId, { sendEmail: okSend });
    check("direct redelivery of a sent alert is skipped", directAgain === "skipped" && sent.length === 1);

    const retriedRequest = await resetTwoFactorWithAlert(u1.id);
    check("a retried reset request for an already-reset account queues no second alert",
      retriedRequest?.alertId === null && (await alertsFor(u1.id)).length === 1);

    const u2 = await makeUser("concurrent");
    const reset2 = await resetTwoFactorWithAlert(u2.id);
    const concurrentSent = [];
    const slowSend = async (message) => {
      concurrentSent.push(message);
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    const outcomes = await Promise.all([
      deliverTwoFactorResetAlert(reset2.alertId, { sendEmail: slowSend }),
      deliverTwoFactorResetAlert(reset2.alertId, { sendEmail: slowSend }),
      runTwoFactorResetAlertRecovery({ sendEmail: slowSend }, { userIds: [u2.id], clockOffsetSeconds: graceSeconds }),
    ]);
    check("concurrent workers send the alert exactly once",
      concurrentSent.length === 1 && (await alertsFor(u2.id))[0]?.status === "sent", JSON.stringify(outcomes));

    const u3 = await makeUser("repeat");
    const reset3 = await resetTwoFactorWithAlert(u3.id);
    try {
      await deliverTwoFactorResetAlert(reset3.alertId, { sendEmail: async () => { throw new Error("provider down"); } });
    } catch { /* queued for retry */ }
    await db.execute(sql`UPDATE users SET totp_enabled = true, totp_secret = ${secrets[0]} WHERE id = ${u3.id}`);
    const reset3b = await resetTwoFactorWithAlert(u3.id);
    check("a second reset while an alert is undelivered still resets",
      cleared(await userState(u3.id)) && reset3b !== null);
    check("a second reset while an alert is undelivered keeps one open alert",
      reset3b?.alertId === null && (await alertsFor(u3.id)).length === 1);

    // ---- Restart: a new process delivers what the old one left -----------
    // u4: the API committed the reset but died before its first attempt.
    const u4 = await makeUser("restart-pending");
    await resetTwoFactorWithAlert(u4.id);
    const restartRun = worker("recover", JSON.stringify([u4.id]), childOutbox, graceSeconds);
    const restartResult = JSON.parse(restartRun.stdout.trim().split("\n").pop() || "{}");
    const childMessages = await readJsonLines(childOutbox);
    check("a new worker process delivers the pending alert",
      restartRun.status === 0 && restartResult.sent === 1
        && childMessages.filter((m) => m.to === u4.email).length === 1
        && (await alertsFor(u4.id))[0]?.status === "sent",
      `${restartRun.status} ${restartRun.stderr} ${JSON.stringify(restartResult)}`);

    // u5: the provider accepted the message, then the process crashed before
    // recording it. The lease blocks early replays; after it expires a new
    // process replays with the same key, so the provider deduplicates it.
    const u5 = await makeUser("restart-sending");
    const reset5 = await resetTwoFactorWithAlert(u5.id);
    const crash = worker("crash-after-accept", reset5.alertId, childOutbox, 0);
    const crashMessages = (await readJsonLines(childOutbox)).filter((m) => m.to === u5.email);
    const [stuck] = await alertsFor(u5.id);
    check("crashed worker leaves the alert leased, not lost",
      crash.status === 17 && crashMessages.length === 1 && stuck?.status === "sending", `${crash.status} ${JSON.stringify(stuck)}`);
    const inLease = worker("recover", JSON.stringify([u5.id]), childOutbox, graceSeconds);
    check("a live lease is not replayed by another worker",
      inLease.status === 0 && (await readJsonLines(childOutbox)).filter((m) => m.to === u5.email).length === 1, inLease.stderr);
    const afterLease = worker("recover", JSON.stringify([u5.id]), childOutbox, (TWO_FACTOR_RESET_ALERT_LEASE_MINUTES + 1) * 60);
    const u5Messages = (await readJsonLines(childOutbox)).filter((m) => m.to === u5.email);
    check("an abandoned lease is replayed with the same provider key",
      afterLease.status === 0 && u5Messages.length === 2 && u5Messages[0].idempotencyKey === u5Messages[1].idempotencyKey
        && (await alertsFor(u5.id))[0]?.status === "sent",
      `${afterLease.stderr} ${JSON.stringify(u5Messages.map((m) => m.idempotencyKey))}`);

    // ---- Beyond the provider's dedupe window: expire, do not replay ------
    const u6 = await makeUser("expired");
    await resetTwoFactorWithAlert(u6.id);
    await db.execute(sql`UPDATE two_factor_reset_notifications SET created_at = now() - interval '24 hours' WHERE user_id = ${u6.id}`);
    const expiredSent = [];
    const expiredRun = await runTwoFactorResetAlertRecovery(
      { sendEmail: async (m) => { expiredSent.push(m); } }, { userIds: [u6.id], clockOffsetSeconds: graceSeconds });
    check("an alert older than the provider window is expired, not replayed",
      expiredRun.expired === 1 && expiredSent.length === 0 && (await alertsFor(u6.id))[0]?.status === "expired",
      JSON.stringify(expiredRun));

    // ---- Privacy: the queue holds no secrets ------------------------------
    const queued = (await db.execute(sql`
      SELECT row_to_json(t)::text AS json FROM two_factor_reset_notifications t
      WHERE user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
    `)).rows.map((row) => row.json);
    const columns = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'two_factor_reset_notifications' ORDER BY column_name
    `)).rows.map((row) => row.column_name);
    check("queue columns hold only identifiers, timing and delivery state",
      JSON.stringify(columns) === JSON.stringify([
        "attempts", "claim_token", "created_at", "delivery_key", "id", "next_attempt_at",
        "reset_at", "sent_at", "status", "updated_at", "user_id",
      ]), JSON.stringify(columns));
    const queuedText = queued.join("\n");
    check("queued payloads contain no secrets, recovery codes, hashes or addresses",
      queued.length >= 6
        && secrets.every((secret) => !queuedText.includes(secret))
        && !queuedText.includes("@test.local") && !queuedText.includes(tag),
      `${queued.length} rows`);
    const allMessages = [...sent, ...concurrentSent, ...(await readJsonLines(childOutbox))];
    const messageText = allMessages.map((m) => `${m.subject}\n${m.text}\n${m.html}\n${m.idempotencyKey}`).join("\n");
    check("rendered alerts contain no secrets or recovery codes",
      allMessages.length > 0 && secrets.every((secret) => !messageText.includes(secret)));

    // ---- The real route, through the disposable API -----------------------
    let cookie = "";
    const request = async (method, route, body) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      return { status: response.status, data: await response.json().catch(() => null) };
    };
    const adminEmail = `${tag}-admin@test.local`;
    const password = "fixture-password-123";
    const registered = await request("POST", "/auth/register", { name: "Alert Admin", email: adminEmail, password });
    await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data?.verificationToken ?? "")}`);
    const login = await request("POST", "/auth/login", { email: adminEmail, password });
    check("route fixture admin signs in", login.status === 200, JSON.stringify(login.data));
    const [adminRow] = (await db.execute(sql`SELECT id, client_id FROM users WHERE email = ${adminEmail}`)).rows;
    if (adminRow) userIds.push(adminRow.id);
    const staff = await makeUser("route", { clientId: adminRow?.client_id ?? null });
    const capturePath = process.env.TEST_EMAIL_CAPTURE_PATH;
    const routeNotices = async () => (await readJsonLines(capturePath)).filter((m) => m.to === staff.email && m.subject === SUBJECT);

    const routeReset = await request("POST", `/users/${staff.id}/reset-2fa`, {});
    check("route reset succeeds", routeReset.status === 200, JSON.stringify(routeReset.data));
    const routeAlerts = await alertsFor(staff.id);
    check("route delivers the alert immediately and records it as sent",
      (await routeNotices()).length === 1 && routeAlerts.length === 1 && routeAlerts[0].status === "sent",
      JSON.stringify(routeAlerts));
    check("route passes the alert's provider idempotency key",
      String((await routeNotices())[0]?.idempotencyKey ?? "").startsWith(routeAlerts[0]?.delivery_key ?? "missing"));
    const routeRetry = await request("POST", `/users/${staff.id}/reset-2fa`, {});
    check("a retried route request does not send a second alert",
      routeRetry.status === 200 && (await routeNotices()).length === 1 && (await alertsFor(staff.id)).length === 1);
  } finally {
    try {
      if (userIds.length) {
        const ids = sql.join(userIds.map((id) => sql`${id}`), sql`, `);
        const clientIds = (await db.execute(sql`SELECT DISTINCT client_id FROM users WHERE id IN (${ids}) AND client_id IS NOT NULL`)).rows
          .map((row) => row.client_id);
        await db.execute(sql`DELETE FROM users WHERE id IN (${ids})`);
        for (const clientId of clientIds) await db.execute(sql`DELETE FROM clients WHERE id = ${clientId}`).catch(() => {});
        const left = (await db.execute(sql`SELECT count(*)::int AS n FROM two_factor_reset_notifications WHERE user_id IN (${ids})`)).rows[0];
        check("fixture alerts are removed with their users", left?.n === 0);
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
