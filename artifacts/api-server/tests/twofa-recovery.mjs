// E2E test: 2FA recovery code + admin 2FA reset.
// Usage: pnpm run test:twofa-recovery (starts a private, email-capturing API).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
let testIpSequence = 10;
const failures = [];
const sessions = [];
const fixtureId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const fixtureCompany = `TwoFA Co ${fixtureId}`;
const fixtureEmails = ["admin", "staff", "invited"].map(role => `twofa-${role}-${fixtureId}@test.local`);
function check(name, ok, detail = "") {
  if (ok) { passed++; } else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
}

// Bundle workspace-owned helpers; do not add a transitive pg import to this package.
const tmp = mkdtempSync(join(tmpdir(), "twofa-"));
const entry = join(tmp, "entry.mjs");
let generateToken;
let pool;
async function initializeHelpers() {
  const helperSource = join(tmp, "helpers.ts");
  writeFileSync(helperSource, [
    `export { generateToken } from ${JSON.stringify(new URL("../src/lib/totp.ts", import.meta.url).pathname)};`,
    `export { pool } from ${JSON.stringify(new URL("../../../lib/db/src/index.ts", import.meta.url).pathname)};`,
  ].join("\n"));
  execFileSync("pnpm", [
    "exec", "esbuild", helperSource, "--bundle", "--format=esm", "--platform=node",
    "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    `--outfile=${entry}`,
  ], { stdio: "pipe", timeout: 15000 });
  ({ generateToken, pool } = await import(entry));
  // Only this test process's private pool; production configuration is unchanged.
  Object.assign(pool.options, {
    connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000,
    idle_in_transaction_session_timeout: 25000,
  });
}

function makeSession() {
  let cookie = "";
  let csrfToken = "";
  const testIp = `203.0.113.${testIpSequence++}`;
  function saveCookie(res) {
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const nextCookie = setCookie.split(";")[0];
      if (nextCookie !== cookie) csrfToken = "";
      cookie = nextCookie;
    }
  }
  const request = async (method, path, body, { signal, csrf = true } = {}) => {
    const needsCsrf = csrf && cookie && !["GET", "HEAD", "OPTIONS"].includes(method);
    if (needsCsrf && !csrfToken) {
      const bootstrap = await fetch(`${BASE}/auth/csrf-token`, {
        headers: { cookie, "X-Forwarded-For": testIp },
        signal: AbortSignal.timeout(20000),
      });
      saveCookie(bootstrap);
      const data = await bootstrap.json();
      if (!bootstrap.ok || typeof data.token !== "string") throw new Error("Could not initialize test session CSRF");
      csrfToken = data.token;
    }
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-For": testIp,
        ...(cookie ? { cookie } : {}),
        ...(needsCsrf ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    saveCookie(res);
    if ([401, 403].includes(res.status)) csrfToken = "";
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  sessions.push(request);
  return request;
}

async function mobileRequest(method, path, body, token, ipSuffix) {
  const headers = {
    "Content-Type": "application/json",
    // Keep mobile regression calls isolated from the suite's login limiter.
    "X-Forwarded-For": `198.51.100.${ipSuffix}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  const ts = fixtureId;
  async function tokenRows(userId) {
    const result = await pool.query(
      "SELECT id, (used_at IS NULL) AS unused FROM password_reset_tokens WHERE user_id = $1 ORDER BY id",
      [userId]);
    return result.rows;
  }
  const admin = makeSession();
  const reg = await admin("POST", "/auth/register", {
    email: `twofa-admin-${ts}@test.local`,
    password: "password-123",
    name: "2FA Admin",
    orgName: fixtureCompany,
  });
  check("register admin", reg.status === 200 || reg.status === 201, `got ${reg.status}`);
  check("test verification token returned", typeof reg.data?.verificationToken === "string");
  const verified = await admin("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data?.verificationToken ?? "")}`);
  check("verify admin email", verified.status === 200, `got ${verified.status}`);
  const adminLogin = await admin("POST", "/auth/login", {
    email: `twofa-admin-${ts}@test.local`,
    password: "password-123",
  });
  check("login verified admin", adminLogin.status === 200, `got ${adminLogin.status}`);
  const adminSetup = await admin("GET", "/auth/2fa/setup");
  check("admin enrolls mandatory 2fa before creating users", adminSetup.status === 200 && !!adminSetup.data?.secret);
  if (!adminSetup.data?.secret) throw new Error("Admin fixture could not start mandatory 2fa setup");
  const adminEnabled = await admin("POST", "/auth/2fa/enable", { code: generateToken(adminSetup.data.secret) });
  check("admin mandatory 2fa enrollment succeeds with CSRF", adminEnabled.status === 200);

  const me = await admin("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.client?.id;
  check("admin has client context", clientId != null, JSON.stringify(me.data?.user));

  // ── User with 2FA: staff member created by admin ────────────────────────────
  const staffEmail = `twofa-staff-${ts}@test.local`;
  const staffCreate = await admin("POST", "/users", {
    email: staffEmail, password: "password-456", name: "2FA Staff", role: "client_staff", clientId,
  });
  check("create staff", [200, 201].includes(staffCreate.status), `got ${staffCreate.status}`);
  const staffId = staffCreate.data?.id;
  async function checkRemainingCodes(name, session, expected, path = "/auth/me") {
    const result = await session("GET", path);
    check(name, result.status === 200 && result.data?.user?.id === staffId
      && result.data.user.recoveryCodesRemaining === expected,
      `status ${result.status}, remaining ${result.data?.user?.recoveryCodesRemaining}`);
    const privateFields = new Set(["codeHash", "code_hash", "totpRecoveryHash", "totpSecret", "passwordHash", "recoveryCodes"]);
    function hasPrivateField(value) {
      return value != null && typeof value === "object"
        && Object.entries(value).some(([key, child]) => privateFields.has(key) || hasPrivateField(child));
    }
    check(`${name}: no recovery secrets or hashes in account status`, !hasPrivateField(result.data));
  }

  // ── Resend invitation: supersede the prior unused setup token ───────────────
  const invitedEmail = `twofa-invited-${ts}@test.local`;
  const invitedCreate = await admin("POST", "/users", {
    email: invitedEmail, name: "Invited Staff", role: "client_staff", clientId,
  });
  check("create invited staff without password", invitedCreate.status === 201, `got ${invitedCreate.status}`);
  const invitedId = invitedCreate.data?.id;
  const beforeResend = await tokenRows(invitedId);
  check(
    "initial invitation creates an unused setup token",
    beforeResend.length === 1 && beforeResend[0].unused,
    JSON.stringify(beforeResend),
  );
  const resend = await admin("POST", `/users/${invitedId}/resend-invite`, {});
  check("admin can resend staff invitation", [200, 502].includes(resend.status), `got ${resend.status}`);
  const afterResend = await tokenRows(invitedId);
  check(
    "resend invalidates the previous setup token",
    afterResend.length >= 2 && !afterResend[0].unused,
    JSON.stringify(afterResend),
  );
  check(
    "resend leaves one fresh unused setup token",
    afterResend.filter((row) => row.unused).length === 1,
    JSON.stringify(afterResend),
  );

  const staff = makeSession();
  await staff("POST", "/auth/login", { email: staffEmail, password: "password-456" });

  const setup = await staff("GET", "/auth/2fa/setup");
  check("2fa setup returns secret", !!setup.data?.secret);
  const code = generateToken(setup.data.secret);
  const enable = await staff("POST", "/auth/2fa/enable", { code });
  check("2fa enable ok", enable.status === 200, JSON.stringify(enable.data));
  const recoveryCodes = enable.data?.recoveryCodes;
  check("10 recovery codes issued", Array.isArray(recoveryCodes) && recoveryCodes.length === 10, JSON.stringify(recoveryCodes));
  check("recovery codes have expected format", recoveryCodes?.every((value) => /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value)), JSON.stringify(recoveryCodes));
  check("recovery codes are distinct", new Set(recoveryCodes ?? []).size === 10);
  const recoveryCode = recoveryCodes?.[0];
  await checkRemainingCodes("newly enabled account has 10 unused recovery codes", staff, 10);

  // ── Login with recovery code ────────────────────────────────────────────────
  const s2 = makeSession();
  const login2 = await s2("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  check("login requires 2fa", login2.data?.requires2fa === true);
  const badVerify = await s2("POST", "/auth/2fa/verify", { code: "AAAA-BBBB-CCCC" });
  check("wrong recovery code rejected", badVerify.status === 401, `got ${badVerify.status}`);
  const verify = await s2("POST", "/auth/2fa/verify", { code: recoveryCode });
  check("recovery code accepted", verify.status === 200, JSON.stringify(verify.data));
  check("2fa remains enabled after recovery", verify.data?.user?.totpEnabled === true);
  await checkRemainingCodes("successful recovery refreshes remaining count to 9", s2, 9);

  // Recovery code is single-use; 2FA remains active and another code still works.
  const s3 = makeSession();
  const login3 = await s3("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  check("login still requires 2fa after recovery", login3.data?.requires2fa === true);
  const reused = await s3("POST", "/auth/2fa/verify", { code: recoveryCode });
  check("used recovery code is rejected", reused.status === 401, `got ${reused.status}`);
  await checkRemainingCodes("rejected reuse does not consume another code", s2, 9);
  const secondCode = await s3("POST", "/auth/2fa/verify", { code: recoveryCodes?.[1] });
  check("a different recovery code still works", secondCode.status === 200, JSON.stringify(secondCode.data));
  await checkRemainingCodes("a second recovery leaves 8 codes", s3, 8);
  await checkRemainingCodes("account-status query cannot select someone else's codes", s3, 8,
    `/auth/me?userId=${me.data?.user?.id}&clientId=${clientId}`);

  // ── Two independent pending sessions race for one unused recovery code ─────
  const contenders = [makeSession(), makeSession()];
  const pendingLogins = await Promise.all(contenders.map(session =>
    session("POST", "/auth/login", { email: staffEmail, password: "password-456" })));
  check("both race sessions require 2fa",
    pendingLogins.every(login => login.status === 200 && login.data?.requires2fa === true));
  const racedCode = recoveryCodes[2];
  const racedHash = createHash("sha256")
    .update(racedCode.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  const beforeRace = await pool.query(
    "SELECT id, used_at::text AS used_at FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2",
    [staffId, racedHash]);
  check("race code exists once and starts unused",
    beforeRace.rows.length === 1 && beforeRace.rows[0].used_at === null);

  // Hold the code's row lock until BOTH HTTP requests reach consumption. Without
  // this barrier, Promise.all alone could pass even with an unsafe update if the
  // server happens to finish the first request before the second reaches SQL.
  const locker = await pool.connect();
  const transportAbort = new AbortController();
  let verifications;
  let overlapError;
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2 FOR UPDATE",
      [staffId, racedHash]);
    const lockPid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    // Attach rejection handling immediately, even while the SQL barrier is held.
    verifications = Promise.allSettled(contenders.map((session, index) =>
      session("POST", "/auth/2fa/verify", { code: racedCode }, index === 0 ? { signal: transportAbort.signal } : {})));
    let waiting = 0;
    const deadline = Date.now() + 10000;
    do {
      // Include indirect blockers: a second updater can queue behind the first
      // updater's tuple lock rather than directly behind our transaction.
      const blocked = await pool.query(`
        WITH RECURSIVE blocked AS (
          SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        )
        SELECT count(*)::int AS waiting FROM blocked
        JOIN pg_stat_activity activity USING (pid)
        WHERE activity.query ILIKE '%UPDATE totp_recovery_codes%'
      `, [lockPid]);
      waiting = blocked.rows[0].waiting;
      if (waiting === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    check("both verification requests overlap at recovery-code consumption", waiting === 2, `waiting: ${waiting}`);
    if (process.argv.includes("--force-race-transport-failure")) {
      transportAbort.abort(new Error("Injected verification transport failure"));
    }
  } catch (error) {
    overlapError = error;
  } finally {
    let rollbackError;
    try {
      await locker.query("ROLLBACK");
    } catch (error) {
      rollbackError = error;
      overlapError ??= error;
    } finally {
      locker.release(rollbackError);
    }
  }
  const settled = verifications ? await verifications : [];
  if (overlapError) throw overlapError;
  const rejected = settled.filter(result => result.status === "rejected");
  if (rejected.length > 0) {
    throw new AggregateError(rejected.map(result => result.reason), "Concurrent verification transport failure");
  }
  const raceResults = settled.map(result => result.value);
  check("exactly one concurrent recovery verification succeeds", raceResults.filter(result => result.status === 200).length === 1);
  check("exactly one concurrent recovery verification is rejected", raceResults.filter(result => result.status === 401).length === 1);
  const sessionResults = await Promise.all(contenders.map(session => session("GET", "/auth/me")));
  check("only the winning contender has an authenticated session",
    raceResults.length === 2 && raceResults.every((verification, index) =>
      verification.status === 200
        ? sessionResults[index].status === 200 && sessionResults[index].data?.user?.id === staffId
        : verification.status === 401 && sessionResults[index].status === 401));
  const afterRace = await pool.query(
    "SELECT id, used_at::text AS used_at FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2",
    [staffId, racedHash]);
  check("raced code has exactly one persisted used timestamp",
    afterRace.rows.length === 1 && afterRace.rows[0].id === beforeRace.rows[0]?.id
    && typeof afterRace.rows[0].used_at === "string" && afterRace.rows[0].used_at.length > 0);
  await checkRemainingCodes("concurrent recovery consumes exactly one remaining code", s3, 7);
  const replaySession = makeSession();
  await replaySession("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  const raceReplay = await replaySession("POST", "/auth/2fa/verify", { code: racedCode });
  check("raced recovery code cannot be reused afterward", raceReplay.status === 401);
  const afterReplay = await pool.query(
    "SELECT used_at::text AS used_at FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2",
    [staffId, racedHash]);
  check("rejected reuse does not replace the code's used timestamp",
    afterReplay.rows.length === 1 && afterReplay.rows[0].used_at === afterRace.rows[0]?.used_at);

  // ── Admin reset: re-enable 2FA, then admin clears it ───────────────────────
  const regenerated = await s3("POST", "/auth/2fa/recovery-codes/regenerate", { password: "password-456" });
  check("10 replacement codes issued", regenerated.data?.recoveryCodes?.length === 10, JSON.stringify(regenerated.data));
  await checkRemainingCodes("password-confirmed regeneration restores 10 unused codes", s3, 10);
  const sRegenerated = makeSession();
  await sRegenerated("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  const oldCode = await sRegenerated("POST", "/auth/2fa/verify", { code: recoveryCodes?.[3] });
  check("regeneration invalidates previous codes", oldCode.status === 401, `got ${oldCode.status}`);
  const newCode = await sRegenerated("POST", "/auth/2fa/verify", { code: regenerated.data?.recoveryCodes?.[0] });
  check("replacement recovery code works", newCode.status === 200, JSON.stringify(newCode.data));
  await checkRemainingCodes("replacement code activity refreshes remaining count to 9", sRegenerated, 9);
  const noCsrf = await s3("POST", "/auth/2fa/recovery-codes/regenerate", { password: "password-456" }, { csrf: false });
  check("cookie regeneration rejects a missing CSRF token", noCsrf.status === 403);
  await checkRemainingCodes("missing CSRF cannot replace recovery codes", s3, 9);
  const wrongPassword = await s3("POST", "/auth/2fa/recovery-codes/regenerate", { password: "not-the-password" });
  check("regeneration still requires the correct password", wrongPassword.status === 401);
  await checkRemainingCodes("wrong password leaves remaining codes unchanged", s3, 9);
  for (let index = 1; index < 10; index++) {
    const consumingSession = makeSession();
    const challenge = await consumingSession("POST", "/auth/login", { email: staffEmail, password: "password-456" });
    check(`remaining-count activity ${index} requires 2fa`, challenge.status === 200 && challenge.data?.requires2fa === true);
    const consumed = await consumingSession("POST", "/auth/2fa/verify", { code: regenerated.data.recoveryCodes[index] });
    check(`remaining-count activity ${index} consumes its code`, consumed.status === 200);
    const remaining = 9 - index;
    if ([3, 1, 0].includes(remaining)) {
      await checkRemainingCodes(`account status accurately reports ${remaining} unused codes`, s3, remaining);
    }
  }
  const replenished = await s3("POST", "/auth/2fa/recovery-codes/regenerate", { password: "password-456" });
  check("an exhausted account can regenerate 10 new codes", replenished.status === 200 && replenished.data?.recoveryCodes?.length === 10);
  await checkRemainingCodes("regeneration after exhaustion refreshes count to 10", s3, 10);

  // ── Mobile login challenge ──────────────────────────────────────────────────
  const mobileLogin = await fetch(`${BASE}/auth/mobile-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.200" },
    body: JSON.stringify({ email: staffEmail, password: "password-456" }),
    signal: AbortSignal.timeout(20000),
  });
  const mobileChallenge = await mobileLogin.json();
  check("mobile login returns a pending token", mobileLogin.status === 200 && typeof mobileChallenge?.pendingToken === "string");
  check("mobile login does not return bearer token before 2fa", mobileChallenge?.token === undefined);

  const mobileVerify = await fetch(`${BASE}/auth/mobile-login/verify-totp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.200" },
    body: JSON.stringify({
      pendingToken: mobileChallenge?.pendingToken,
      code: generateToken(setup.data.secret),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const mobileSession = await mobileVerify.json();
  check("mobile login exchanges valid 2fa challenge", mobileVerify.status === 200 && typeof mobileSession?.token === "string", JSON.stringify(mobileSession));

  const replay = await fetch(`${BASE}/auth/mobile-login/verify-totp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.200" },
    body: JSON.stringify({
      pendingToken: mobileChallenge?.pendingToken,
      code: generateToken(setup.data.secret),
    }),
    signal: AbortSignal.timeout(20000),
  });
  check("mobile login challenge is single use", replay.status === 401, `got ${replay.status}`);

  const userList = await admin("GET", "/users");
  const staffRow = (Array.isArray(userList.data) ? userList.data : []).find((u) => u.id === staffId);
  check("users list shows totpEnabled", staffRow?.totpEnabled === true, JSON.stringify(staffRow));

  const reset = await admin("POST", `/users/${staffId}/reset-2fa`, {});
  check("admin reset-2fa ok", reset.status === 200, JSON.stringify(reset.data));
  const s4 = makeSession();
  const login4 = await s4("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  check("plain login works after admin reset", login4.status === 200 && !login4.data?.requires2fa);

  // Staff cannot reset another user's 2FA (route is admin-only).
  const staffReset = await s4("POST", `/users/${staffId}/reset-2fa`, {});
  check("staff blocked from reset-2fa", [401, 403].includes(staffReset.status), `got ${staffReset.status}`);
  const staffResend = await s4("POST", `/users/${invitedId}/resend-invite`, {});
  check("staff blocked from resending invitations", [401, 403].includes(staffResend.status), `got ${staffResend.status}`);

}

try {
  await initializeHelpers();
  await main();
} catch (error) {
  console.error("Test run crashed:", error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(sessions.map(session => session("POST", "/auth/logout", {})));
  let cleanupClient;
  try {
    if (!pool) throw new Error("Test database helpers were not initialized");
    cleanupClient = await pool.connect();
    await cleanupClient.query("BEGIN");
    // Exact, UUID-scoped fixture identity only. Never delete other test tenants.
    const fixtureClients = await cleanupClient.query("SELECT id FROM clients WHERE name = $1", [fixtureCompany]);
    const clientIds = fixtureClients.rows.map(row => row.id);
    await cleanupClient.query("DELETE FROM users WHERE email = ANY($1::text[]) OR client_id = ANY($2::int[])",
      [fixtureEmails, clientIds]);
    await cleanupClient.query("DELETE FROM clients WHERE id = ANY($1::int[])", [clientIds]);
    await cleanupClient.query("COMMIT");
    const remaining = await cleanupClient.query(`
      SELECT
        (SELECT count(*)::int FROM users WHERE email = ANY($1::text[])) AS users,
        (SELECT count(*)::int FROM clients WHERE name = $2) AS clients
    `, [fixtureEmails, fixtureCompany]);
    check("fixture users and tenant are removed after the run",
      remaining.rows[0].users === 0 && remaining.rows[0].clients === 0);
  } catch (error) {
    if (cleanupClient) await cleanupClient.query("ROLLBACK").catch(() => {});
    console.error("Recovery test fixture cleanup failed:", error.message);
    process.exitCode = 1;
  } finally {
    cleanupClient?.release();
    if (pool) await pool.end();
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(`\n${passed} checks passed, ${failures.length} failed.`);
if (failures.length > 0) {
  console.error("\nFailures:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
}
