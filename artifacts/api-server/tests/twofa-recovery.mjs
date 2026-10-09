// E2E test: 2FA recovery code + admin 2FA reset.
// Usage: pnpm run test:twofa-recovery (starts a private, email-capturing API).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
let testIpSequence = 10;
const failures = [];
const sessions = [];
const resetNoticeSubject = "Security alert: your two-factor authentication was reset";
const fixtureId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const fixtureCompany = `TwoFA Co ${fixtureId}`;
// A second, isolated tenant for the cross-tenant reset check.
const otherFixtureCompany = `TwoFA Other Co ${fixtureId}`;
const fixtureCompanies = [fixtureCompany, otherFixtureCompany];
const fixtureEmails = ["admin", "staff", "invited", "other-admin", "other-staff"]
  .map(role => `twofa-${role}-${fixtureId}@test.local`);
function check(name, ok, detail = "") {
  if (ok) { passed++; } else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
}
function capturedEmails() {
  const capturePath = process.env.TEST_EMAIL_CAPTURE_PATH;
  if (!capturePath) return [];
  return readFileSync(capturePath, "utf8").split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}
function resetNotices() {
  return capturedEmails().filter((mail) => JSON.stringify(mail).includes(resetNoticeSubject));
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

// ── Overlapping recovery-code regeneration (self-contained) ─────────────────
// Two signed-in sessions for one user regenerate at the same time. The barrier
// is implementation-agnostic: the test row-locks the user's existing code rows,
// fires both requests, and waits until both server backends are blocked
// (directly or transitively) behind the test transaction. Without per-user
// serialization both DELETEs queue on those rows and both inserts survive (20
// unused rows); with it, exactly one ten-code set remains.
async function overlappingRegenerationRegression({ admin, clientId }) {
  const recoveryHash = (code) => createHash("sha256")
    .update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  const password = "password-regen-789";

  async function enrolledUser(label) {
    const email = `twofa-regen-${label}-${fixtureId}@test.local`;
    const created = await admin("POST", "/users", {
      email, password, name: `Regen ${label}`, role: "client_staff", clientId,
    });
    check(`regen race: create user ${label}`, [200, 201].includes(created.status), `got ${created.status}`);
    const session = makeSession();
    await session("POST", "/auth/login", { email, password });
    const setup = await session("GET", "/auth/2fa/setup");
    if (!setup.data?.secret) throw new Error(`Regen race user ${label} could not start 2FA setup`);
    const enabled = await session("POST", "/auth/2fa/enable", { code: generateToken(setup.data.secret) });
    check(`regen race: user ${label} enrols with 10 codes`,
      enabled.status === 200 && enabled.data?.recoveryCodes?.length === 10, `got ${enabled.status}`);
    return { id: created.data?.id, email, session, enrolmentCodes: enabled.data?.recoveryCodes ?? [] };
  }
  async function signedInSession(user) {
    const session = makeSession();
    const login = await session("POST", "/auth/login", { email: user.email, password });
    if (login.data?.requires2fa !== true) throw new Error("Regen race login did not require 2FA");
    const totp = await session("POST", "/auth/2fa/verify", { code: user.enrolmentCodes.pop() });
    if (totp.status !== 200) throw new Error(`Regen race sign-in failed: ${totp.status}`);
    return session;
  }
  async function unusedHashes(userId) {
    const rows = await pool.query(
      "SELECT code_hash FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [userId]);
    return rows.rows.map(row => row.code_hash);
  }
  async function recoveryLogin(user, code) {
    const session = makeSession();
    await session("POST", "/auth/login", { email: user.email, password });
    return session("POST", "/auth/2fa/verify", { code });
  }

  const userA = await enrolledUser("a");
  const userB = await enrolledUser("b");
  // Two independent signed-in sessions (separate tabs / API clients) for user A.
  const tabs = [await signedInSession(userA), await signedInSession(userA)];
  const sessionB = await signedInSession(userB);
  const bBefore = new Set(await unusedHashes(userB.id));

  const locker = await pool.connect();
  let regenerations;
  let independent;
  let barrierError;
  try {
    await locker.query("BEGIN");
    const held = await locker.query(
      "SELECT id FROM totp_recovery_codes WHERE user_id = $1 FOR UPDATE", [userA.id]);
    if (held.rows.length === 0) throw new Error("Regen race user A has no code rows to hold");
    regenerations = Promise.allSettled(tabs.map(tab =>
      tab("POST", "/auth/2fa/recovery-codes/regenerate", { password })));
    let waiting = 0;
    const deadline = Date.now() + 10000;
    do {
      const blocked = await pool.query(`
        WITH RECURSIVE blocked AS (
          SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        )
        SELECT count(*)::int AS waiting FROM blocked
      `, [locker.processID]);
      waiting = blocked.rows[0].waiting;
      if (waiting === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    check("regen race: both regenerations are blocked at the replacement boundary",
      waiting === 2, `waiting: ${waiting}`);
    // User B regenerates while user A's replacements are still held.
    independent = await sessionB("POST", "/auth/2fa/recovery-codes/regenerate", { password });
    check("regen race: another user's regeneration is not blocked by user A",
      independent.status === 200 && independent.data?.recoveryCodes?.length === 10, `got ${independent.status}`);
  } catch (error) {
    barrierError = error;
  } finally {
    let rollbackError;
    try {
      await locker.query("ROLLBACK");
    } catch (error) {
      rollbackError = error;
      barrierError ??= error;
    } finally {
      locker.release(rollbackError);
    }
  }
  const settled = regenerations ? await regenerations : [];
  if (barrierError) throw barrierError;
  const rejected = settled.filter(result => result.status === "rejected");
  if (rejected.length > 0) throw new AggregateError(rejected.map(r => r.reason), "Regeneration transport failure");
  const responses = settled.map(result => result.value);
  check("regen race: both overlapping regenerations succeed",
    responses.length === 2 && responses.every(r => r.status === 200 && r.data?.recoveryCodes?.length === 10),
    JSON.stringify(responses.map(r => r.status)));

  const sets = responses.map(r => r.data?.recoveryCodes ?? []);
  const finalHashes = await unusedHashes(userA.id);
  const totalRows = Number((await pool.query(
    "SELECT count(*)::int AS n FROM totp_recovery_codes WHERE user_id = $1", [userA.id])).rows[0].n);
  check("regen race: exactly 10 unused rows remain, not 20 mixed rows",
    finalHashes.length === 10 && totalRows === 10, `unused ${finalHashes.length}, total ${totalRows}`);
  const finalSet = new Set(finalHashes);
  const matches = sets.map(set => set.length === 10 && set.every(code => finalSet.has(recoveryHash(code))));
  check("regen race: surviving rows are exactly one response's code set",
    matches.filter(Boolean).length === 1, JSON.stringify(matches));
  const survivorIndex = matches.indexOf(true);
  const survivor = sets[survivorIndex] ?? [];
  const superseded = sets[1 - survivorIndex] ?? [];
  check("regen race: no superseded code is stored",
    superseded.length === 10 && superseded.every(code => !finalSet.has(recoveryHash(code))));
  const meA = await tabs[0]("GET", "/auth/me");
  check("regen race: /auth/me reports 10 remaining after overlap",
    meA.status === 200 && meA.data?.user?.id === userA.id && meA.data.user.recoveryCodesRemaining === 10,
    `remaining ${meA.data?.user?.recoveryCodesRemaining}`);

  for (const code of superseded.slice(0, 3)) {
    const attempt = await recoveryLogin(userA, code);
    check("regen race: superseded code fails at recovery login", attempt.status === 401, `got ${attempt.status}`);
  }
  const firstUse = await recoveryLogin(userA, survivor[0]);
  check("regen race: surviving code signs in once",
    firstUse.status === 200 && firstUse.data?.user?.id === userA.id, `got ${firstUse.status}`);
  const reuse = await recoveryLogin(userA, survivor[0]);
  check("regen race: surviving code fails on reuse", reuse.status === 401, `got ${reuse.status}`);
  const meAfter = await tabs[1]("GET", "/auth/me");
  check("regen race: /auth/me reports 9 remaining after one use",
    meAfter.status === 200 && meAfter.data?.user?.recoveryCodesRemaining === 9,
    `remaining ${meAfter.data?.user?.recoveryCodesRemaining}`);

  const bHashes = await unusedHashes(userB.id);
  const bSet = new Set(bHashes);
  const bCodes = independent?.data?.recoveryCodes ?? [];
  check("regen race: other user holds exactly its own new set",
    bHashes.length === 10 && bCodes.every(code => bSet.has(recoveryHash(code)))
      && bHashes.every(hash => !bBefore.has(hash)));
  check("regen race: neither user's codes leak into the other's rows",
    [...sets[0], ...sets[1]].every(code => !bSet.has(recoveryHash(code)))
      && bCodes.every(code => !finalSet.has(recoveryHash(code))));
  const meB = await sessionB("GET", "/auth/me");
  check("regen race: other user's /auth/me count is 10",
    meB.status === 200 && meB.data?.user?.id === userB.id && meB.data.user.recoveryCodesRemaining === 10,
    `remaining ${meB.data?.user?.recoveryCodesRemaining}`);
}

// ── Recovery codes are bound to their own account (self-contained) ──────────
// Account A's genuine, unused recovery code is submitted against account B's
// valid password-authenticated pending challenge, on the web (/auth/2fa/verify)
// and mobile (/auth/mobile-login/verify-totp) paths. The code must be refused,
// leave no session or bearer token, stay unused for A, and then still sign A
// in on the same path. Codes, secrets and tokens are never printed.
const bindingEmails = ["bind-a", "bind-b"].map(label => `twofa-${label}-${fixtureId}@test.local`);
fixtureEmails.push(...bindingEmails);
async function recoveryCodeAccountBindingRegression({ admin, clientId }) {
  const password = "password-bind-345";
  const hashOf = (code) => createHash("sha256")
    .update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  let mobileIp = 230;

  async function enrolledUser(label, email) {
    const created = await admin("POST", "/users", {
      email, password, name: `Binding ${label}`, role: "client_staff", clientId,
    });
    check(`binding: create account ${label}`, created.status === 201 && Number.isInteger(created.data?.id),
      `got ${created.status}`);
    if (!Number.isInteger(created.data?.id)) throw new Error(`Binding account ${label} was not created`);
    const session = makeSession();
    await session("POST", "/auth/login", { email, password });
    const setup = await session("GET", "/auth/2fa/setup");
    if (!setup.data?.secret) throw new Error(`Binding account ${label} could not start 2FA setup`);
    const enabled = await session("POST", "/auth/2fa/enable", { code: generateToken(setup.data.secret) });
    const codes = enabled.data?.recoveryCodes ?? [];
    check(`binding: account ${label} enrols TOTP with 10 recovery codes`,
      enabled.status === 200 && codes.length === 10, `got ${enabled.status}`);
    return { id: created.data.id, email, codes };
  }
  async function codeRows(userId) {
    return (await pool.query(
      "SELECT id, code_hash, used_at::text AS used_at FROM totp_recovery_codes WHERE user_id = $1 ORDER BY id",
      [userId])).rows;
  }
  async function codeState(userId, code) {
    const rows = (await pool.query(
      "SELECT used_at::text AS used_at FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2",
      [userId, hashOf(code)])).rows;
    return rows.length === 1 ? (rows[0].used_at === null ? "unused" : "used") : `rows:${rows.length}`;
  }
  const mobileSessions = async (userId) => Number((await pool.query(
    "SELECT count(*)::int AS n FROM mobile_sessions WHERE user_id = $1", [userId])).rows[0].n);
  async function mobileChallenge(email) {
    const ip = mobileIp++;
    const started = await mobileRequest("POST", "/auth/mobile-login", { email, password }, null, ip);
    if (started.status !== 200 || typeof started.data?.pendingToken !== "string" || started.data.token !== undefined) {
      throw new Error(`Binding mobile challenge was not created (status ${started.status})`);
    }
    return { pendingToken: started.data.pendingToken, ip };
  }

  const userA = await enrolledUser("A", bindingEmails[0]);
  const userB = await enrolledUser("B", bindingEmails[1]);
  const aHashes = new Set(userA.codes.map(hashOf));
  check("binding: the two accounts hold distinct recovery-code sets",
    userB.codes.every(code => !aHashes.has(hashOf(code))));
  const bRowsBefore = await codeRows(userB.id);
  check("binding: account B starts with 10 unused stored codes",
    bRowsBefore.length === 10 && bRowsBefore.every(row => row.used_at === null));
  const [webCode, mobileCode] = userA.codes;

  // ── Web: A's code against B's pending cookie challenge ──
  const webB = makeSession();
  const webBLogin = await webB("POST", "/auth/login", { email: userB.email, password });
  check("binding web: B's password login leaves a pending 2FA challenge",
    webBLogin.status === 200 && webBLogin.data?.requires2fa === true, `got ${webBLogin.status}`);
  check("binding web: A's code starts unused", await codeState(userA.id, webCode) === "unused");
  const webCross = await webB("POST", "/auth/2fa/verify", { code: webCode });
  check("binding web: A's recovery code is rejected for B's challenge", webCross.status === 401,
    `got ${webCross.status}`);
  check("binding web: the rejection returns no user", webCross.data?.user === undefined);
  const webBMe = await webB("GET", "/auth/me");
  check("binding web: B's cookie session does not pass /auth/me", webBMe.status === 401, `got ${webBMe.status}`);
  check("binding web: PostgreSQL shows A's code still unused", await codeState(userA.id, webCode) === "unused");

  const webA = makeSession();
  const webALogin = await webA("POST", "/auth/login", { email: userA.email, password });
  check("binding web: A's password login requires 2fa", webALogin.data?.requires2fa === true);
  const webOwn = await webA("POST", "/auth/2fa/verify", { code: webCode });
  check("binding web: A then signs in with that code",
    webOwn.status === 200 && webOwn.data?.user?.id === userA.id, `got ${webOwn.status}`);
  const webAMe = await webA("GET", "/auth/me");
  check("binding web: A's session passes /auth/me as A",
    webAMe.status === 200 && webAMe.data?.user?.id === userA.id, `got ${webAMe.status}`);
  check("binding web: A's code is consumed by its owner", await codeState(userA.id, webCode) === "used");

  // ── Mobile: A's code against B's pending bearer challenge ──
  const bSessionsBefore = await mobileSessions(userB.id);
  const aSessionsBefore = await mobileSessions(userA.id);
  const bChallenge = await mobileChallenge(userB.email);
  check("binding mobile: A's second code starts unused", await codeState(userA.id, mobileCode) === "unused");
  const mobileCross = await mobileRequest("POST", "/auth/mobile-login/verify-totp",
    { pendingToken: bChallenge.pendingToken, code: mobileCode }, null, bChallenge.ip);
  check("binding mobile: A's recovery code is rejected for B's challenge", mobileCross.status === 401,
    `got ${mobileCross.status}`);
  check("binding mobile: no bearer token is issued", mobileCross.data?.token === undefined);
  if (typeof mobileCross.data?.token === "string") {
    const leaked = await mobileRequest("GET", "/auth/me", undefined, mobileCross.data.token, bChallenge.ip);
    check("binding mobile: a wrongly issued bearer token is not usable", leaked.status === 401,
      `got ${leaked.status}`);
  }
  check("binding mobile: no bearer session row is created for either account",
    await mobileSessions(userB.id) === bSessionsBefore && await mobileSessions(userA.id) === aSessionsBefore);
  check("binding mobile: PostgreSQL shows A's code still unused", await codeState(userA.id, mobileCode) === "unused");

  const aChallenge = await mobileChallenge(userA.email);
  const mobileOwn = await mobileRequest("POST", "/auth/mobile-login/verify-totp",
    { pendingToken: aChallenge.pendingToken, code: mobileCode }, null, aChallenge.ip);
  check("binding mobile: A then exchanges that code for a bearer token",
    mobileOwn.status === 200 && typeof mobileOwn.data?.token === "string", `got ${mobileOwn.status}`);
  const bearerMe = typeof mobileOwn.data?.token === "string"
    ? await mobileRequest("GET", "/auth/me", undefined, mobileOwn.data.token, aChallenge.ip)
    : { status: 0 };
  check("binding mobile: A's bearer token passes /auth/me as A",
    bearerMe.status === 200 && bearerMe.data?.user?.id === userA.id, `got ${bearerMe.status}`);
  check("binding mobile: A's code is consumed by its owner", await codeState(userA.id, mobileCode) === "used");
  await pool.query("DELETE FROM mobile_login_challenges WHERE user_id = $1", [userB.id]);

  // B's own codes are untouched by every attempt above, and the rest of A's are unused.
  check("binding: B's recovery-code rows are unchanged",
    JSON.stringify(await codeRows(userB.id)) === JSON.stringify(bRowsBefore));
  const aRows = await codeRows(userA.id);
  check("binding: A has exactly its two legitimately used codes consumed",
    aRows.length === 10 && aRows.filter(row => row.used_at !== null).length === 2);
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
  await overlappingRegenerationRegression({ admin, clientId });
  await recoveryCodeAccountBindingRegression({ admin, clientId });

  // ── User with 2FA: staff member created by admin ────────────────────────────
  const staffEmail = `twofa-staff-${ts}@test.local`;
  const staffCreate = await admin("POST", "/users", {
    email: staffEmail, password: "password-456", name: "2FA <Staff & Co>", role: "client_staff", clientId,
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
  async function startMobileChallenge(ipSuffix) {
    const result = await mobileRequest("POST", "/auth/mobile-login", {
      email: staffEmail, password: "password-456",
    }, null, ipSuffix);
    check(`mobile login creates a pending challenge (${ipSuffix})`,
      result.status === 200 && typeof result.data?.pendingToken === "string", `got ${result.status}`);
    check(`mobile login withholds the bearer token (${ipSuffix})`,
      result.data?.token === undefined, JSON.stringify(result.data));
    return result.data?.pendingToken;
  }
  const mobileChallengeHash = pendingToken =>
    createHash("sha256").update(pendingToken).digest("hex");
  const mobileSessionCount = async () => Number((await pool.query(
    "SELECT count(*)::int AS count FROM mobile_sessions WHERE user_id = $1", [staffId])).rows[0].count);
  async function verifyMobileChallenge(pendingToken, code, ipSuffix) {
    return mobileRequest("POST", "/auth/mobile-login/verify-totp", { pendingToken, code }, null, ipSuffix);
  }

  // Pin one challenge before expiry and at the exact boundary in the database,
  // so this does not depend on sleeping or the five-minute wall clock.
  for (const [ipSuffix, expirySql, label] of [
    [210, "now() - interval '1 millisecond'", "past expiry"],
    [211, "now()", "exact expiry boundary"],
  ]) {
    const pendingToken = await startMobileChallenge(ipSuffix);
    const tokenHash = mobileChallengeHash(pendingToken);
    const challenge = await pool.query(
      "SELECT extract(epoch FROM (expires_at - created_at)) * 1000 AS lifetime_ms FROM mobile_login_challenges WHERE token_hash = $1",
      [tokenHash]);
    const lifetimeMs = Number(challenge.rows[0]?.lifetime_ms);
    check(`mobile challenge is issued for five minutes (${label})`,
      challenge.rows.length === 1 && lifetimeMs >= 299000 && lifetimeMs <= 301000,
      `lifetime was ${lifetimeMs}ms`);
    await pool.query(`UPDATE mobile_login_challenges SET expires_at = ${expirySql} WHERE token_hash = $1`, [tokenHash]);
    const before = await mobileSessionCount();
    const verification = await verifyMobileChallenge(pendingToken, generateToken(setup.data.secret), ipSuffix);
    check(`mobile challenge cannot be used at or after ${label}`, verification.status === 401,
      `got ${verification.status}`);
    check(`mobile challenge rejection returns a stable code (${label})`,
      verification.data?.code === "MOBILE_LOGIN_CHALLENGE_INVALID",
      JSON.stringify(verification.data));
    check(`expired mobile challenge cannot issue a bearer session (${label})`,
      verification.data?.token === undefined && await mobileSessionCount() === before);
  }

  // A failed session insert happens after recovery-code consumption in the
  // transaction. The HTTP endpoint must roll both operations back so retrying
  // the still-valid challenge with the same one-use code succeeds.
  const rollbackToken = await startMobileChallenge(212);
  const rollbackCode = replenished.data.recoveryCodes[0];
  const rollbackCodeHash = createHash("sha256")
    .update(rollbackCode.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  const rollbackHash = mobileChallengeHash(rollbackToken);
  const suffix = fixtureId.replace(/[^a-zA-Z0-9_]/g, "_");
  const rejectFunction = `test_reject_mobile_session_${suffix}`;
  const rejectTrigger = `test_reject_mobile_session_${suffix}`;
  await pool.query(`CREATE FUNCTION public."${rejectFunction}"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_id = ${Number(staffId)} THEN
        RAISE EXCEPTION 'Injected mobile session creation failure';
      END IF;
      RETURN NEW;
    END;
    $$`);
  try {
    await pool.query(`CREATE TRIGGER "${rejectTrigger}" BEFORE INSERT ON mobile_sessions
      FOR EACH ROW EXECUTE FUNCTION public."${rejectFunction}"()`);
    const beforeSessions = await mobileSessionCount();
    const failedExchange = await verifyMobileChallenge(rollbackToken, rollbackCode, 212);
    check("mobile recovery verification reports a failed session exchange",
      failedExchange.status === 500, `got ${failedExchange.status}`);
    const afterFailedExchange = await pool.query(`
      SELECT rc.used_at, c.id AS challenge_id
      FROM totp_recovery_codes rc
      LEFT JOIN mobile_login_challenges c ON c.token_hash = $2
      WHERE rc.user_id = $1 AND rc.code_hash = $3
    `, [staffId, rollbackHash, rollbackCodeHash]);
    check("failed mobile challenge exchange rolls back recovery-code consumption and challenge deletion",
      afterFailedExchange.rows.length === 1 && afterFailedExchange.rows[0].used_at === null
      && afterFailedExchange.rows[0].challenge_id != null
      && await mobileSessionCount() === beforeSessions);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS "${rejectTrigger}" ON mobile_sessions`);
    await pool.query(`DROP FUNCTION IF EXISTS public."${rejectFunction}"()`);
  }
  const retriedExchange = await verifyMobileChallenge(rollbackToken, rollbackCode, 215);
  check("the recovery code and challenge remain usable after the failed exchange",
    retriedExchange.status === 200 && typeof retriedExchange.data?.token === "string",
    `got ${retriedExchange.status}`);
  const afterRetry = await pool.query(`
    SELECT rc.used_at, c.id AS challenge_id
    FROM totp_recovery_codes rc
    LEFT JOIN mobile_login_challenges c ON c.token_hash = $2
    WHERE rc.user_id = $1 AND rc.code_hash = $3
  `, [staffId, rollbackHash, rollbackCodeHash]);
  check("successful exchange consumes the recovery code and deletes its challenge",
    afterRetry.rows.length === 1 && afterRetry.rows[0].used_at != null
    && afterRetry.rows[0].challenge_id == null);

  // Hold the challenge row until both HTTP verifications are waiting on it;
  // otherwise Promise.all alone would not prove the requests actually raced.
  const raceToken = await startMobileChallenge(213);
  const raceHash = mobileChallengeHash(raceToken);
  const raceCode = replenished.data.recoveryCodes[1];
  const raceCodeHash = createHash("sha256")
    .update(raceCode.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  const beforeRaceSessions = await mobileSessionCount();
  const challengeLocker = await pool.connect();
  let mobileVerifications;
  let mobileRaceError;
  try {
    await challengeLocker.query("BEGIN");
    await challengeLocker.query(
      "SELECT id FROM mobile_login_challenges WHERE token_hash = $1 FOR UPDATE", [raceHash]);
    mobileVerifications = Promise.all([
      verifyMobileChallenge(raceToken, raceCode, 213),
      verifyMobileChallenge(raceToken, raceCode, 214),
    ]);
    let waiting = 0;
    const deadline = Date.now() + 10000;
    do {
      const blocked = await pool.query(`
        WITH RECURSIVE blocked AS (
          SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
        )
        SELECT count(*)::int AS waiting
        FROM blocked JOIN pg_stat_activity activity USING (pid)
        WHERE activity.query ILIKE '%FROM mobile_login_challenges%'
      `, [challengeLocker.processID]);
      waiting = blocked.rows[0].waiting;
      if (waiting === 2) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    check("both mobile verifications overlap while the challenge is locked",
      waiting === 2, `waiting: ${waiting}`);
  } catch (error) {
    mobileRaceError = error;
  } finally {
    let rollbackError;
    try {
      await challengeLocker.query("ROLLBACK");
    } catch (error) {
      rollbackError = error;
      mobileRaceError ??= error;
    } finally {
      challengeLocker.release(rollbackError);
    }
  }
  const mobileRaceResults = mobileVerifications ? await mobileVerifications : [];
  if (mobileRaceError) throw mobileRaceError;
  check("concurrent mobile challenge verification issues exactly one bearer session",
    mobileRaceResults.filter(result => result.status === 200
      && typeof result.data?.token === "string").length === 1
    && mobileRaceResults.filter(result => result.status === 401).length === 1,
    JSON.stringify(mobileRaceResults.map(result => result.status)));
  check("concurrent mobile challenge creates exactly one database session",
    await mobileSessionCount() === beforeRaceSessions + 1);
  const racedRecovery = await pool.query(
    "SELECT used_at FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2",
    [staffId, raceCodeHash]);
  check("concurrent mobile challenge consumes its recovery code once",
    racedRecovery.rows.length === 1 && racedRecovery.rows[0].used_at != null);

  // Run both lock orderings: a consumer that is only safe when it goes second
  // (e.g. an unconditional SELECT-then-UPDATE) fails one of these rounds.
  for (const [firstChannel, codeIndex, ipBase] of [["web", 3, 219], ["mobile", 4, 221]]) {
    await raceRecoveryCodeAcrossWebAndMobile({
      email: staffEmail, password: "password-456", userId: staffId,
      recoveryCode: replenished.data.recoveryCodes[codeIndex], firstChannel, ipBase,
    });
  }

  const mobileTokenChallenge = await startMobileChallenge(216);
  const mobileSession = await verifyMobileChallenge(
    mobileTokenChallenge, generateToken(setup.data.secret), 216);
  check("mobile login exchanges valid TOTP challenge",
    mobileSession.status === 200 && typeof mobileSession.data?.token === "string",
    JSON.stringify(mobileSession.data));
  const replay = await verifyMobileChallenge(
    mobileTokenChallenge, generateToken(setup.data.secret), 216);
  check("mobile login challenge is single use", replay.status === 401, `got ${replay.status}`);
  check("reused mobile challenge returns the stable invalid-challenge code",
    replay.data?.code === "MOBILE_LOGIN_CHALLENGE_INVALID", JSON.stringify(replay.data));

  // ── A stolen database snapshot cannot complete mobile sign-in ───────────────
  // Only the SHA-256 digest of the pending token is stored; presenting that
  // digest (as anyone reading the table could) must not be accepted.
  const stolenToken = await startMobileChallenge(217);
  const stored = await pool.query(
    "SELECT token_hash FROM mobile_login_challenges WHERE token_hash = $1", [mobileChallengeHash(stolenToken)]);
  check("stored challenge is the SHA-256 digest of the pending token", stored.rows.length === 1);
  const rawStored = await pool.query(
    "SELECT count(*)::int AS n FROM mobile_login_challenges WHERE token_hash = $1", [stolenToken]);
  check("raw pending token is absent from the stored challenges", rawStored.rows[0].n === 0);
  const beforeStolen = await mobileSessionCount();
  const stolen = await verifyMobileChallenge(stored.rows[0].token_hash, generateToken(setup.data.secret), 217);
  check("stored digest cannot be used as the pending token",
    stolen.status === 401 && stolen.data?.token === undefined
    && stolen.data?.code === "MOBILE_LOGIN_CHALLENGE_INVALID", JSON.stringify(stolen.data));
  check("stolen digest attempt creates no session", await mobileSessionCount() === beforeStolen);

  // ── A mistyped code keeps the sign-in recoverable ──────────────────────────
  const wrongCode = String((Number(generateToken(setup.data.secret)) + 1) % 1_000_000).padStart(6, "0");
  const mistyped = await verifyMobileChallenge(stolenToken, wrongCode, 217);
  check("mistyped code is refused without a bearer",
    mistyped.status === 401 && mistyped.data?.token === undefined, JSON.stringify(mistyped.data));
  check("mistyped code is not reported as an invalid challenge",
    mistyped.data?.code !== "MOBILE_LOGIN_CHALLENGE_INVALID", JSON.stringify(mistyped.data));
  check("mistyped code creates no session", await mobileSessionCount() === beforeStolen);
  const afterTypo = await pool.query(
    "SELECT count(*)::int AS n FROM mobile_login_challenges WHERE token_hash = $1", [mobileChallengeHash(stolenToken)]);
  check("mistyped code leaves the challenge in place", afterTypo.rows[0].n === 1);
  const recovered = await verifyMobileChallenge(stolenToken, generateToken(setup.data.secret), 217);
  check("the same challenge completes with the correct code after a typo",
    recovered.status === 200 && typeof recovered.data?.token === "string", JSON.stringify(recovered.data));
  check("successful exchange creates exactly one session", await mobileSessionCount() === beforeStolen + 1);

  // ── A disabled account cannot finish a mobile 2FA challenge ─────────────────
  const disabledChallenge = await startMobileChallenge(218);
  const disabledRecovery = replenished.data.recoveryCodes[2];
  const disabledRecoveryHash = createHash("sha256")
    .update(disabledRecovery.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  const deactivated = await admin("PUT", `/users/${staffId}`, { active: false });
  try {
    check("admin deactivates the fixture user", deactivated.status === 200 && deactivated.data?.active === false,
      JSON.stringify(deactivated.data));
    const sessionsWhileDisabled = await mobileSessionCount();
    const withTotp = await verifyMobileChallenge(disabledChallenge, generateToken(setup.data.secret), 218);
    check("disabled account: valid TOTP is refused", withTotp.status === 401 && withTotp.data?.token === undefined,
      JSON.stringify(withTotp.data));
    const withRecovery = await verifyMobileChallenge(disabledChallenge, disabledRecovery, 218);
    check("disabled account: valid recovery code is refused",
      withRecovery.status === 401 && withRecovery.data?.token === undefined, JSON.stringify(withRecovery.data));
    check("disabled account: no mobile session is created", await mobileSessionCount() === sessionsWhileDisabled);
    const recoveryState = await pool.query(
      "SELECT used_at FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2", [staffId, disabledRecoveryHash]);
    check("disabled account: the recovery code is not consumed",
      recoveryState.rows.length === 1 && recoveryState.rows[0].used_at === null);
  } finally {
    // Restore the fixture even if an assertion above threw.
    const restored = await admin("PUT", `/users/${staffId}`, { active: true });
    check("fixture user active again", restored.status === 200 && restored.data?.active === true);
    await pool.query("DELETE FROM mobile_login_challenges WHERE token_hash = $1", [mobileChallengeHash(disabledChallenge)]);
  }

  const userList = await admin("GET", "/users");
  const staffRow = (Array.isArray(userList.data) ? userList.data : []).find((u) => u.id === staffId);
  check("users list shows totpEnabled", staffRow?.totpEnabled === true, JSON.stringify(staffRow));

  const reset = await admin("POST", `/users/${staffId}/reset-2fa`, {});
  check("admin reset-2fa ok", reset.status === 200, JSON.stringify(reset.data));
  const resetEmail = resetNotices()[0];
  check("reset notice is sent only to the affected staff member",
    resetNotices().length === 1 && resetEmail?.to === staffEmail);
  const resetState = (await pool.query(
    "SELECT updated_at, totp_enabled, totp_secret, totp_recovery_hash FROM users WHERE id = $1",
    [staffId],
  )).rows[0];
  check("reset notice identifies the persisted UTC reset time",
    !!resetState?.updated_at && resetEmail?.text?.includes(`${new Date(resetState.updated_at).toISOString()} (UTC)`));
  check("reset notice tells staff to report unexpected resets and re-enrol",
    resetEmail?.text?.includes("contact your administrator immediately")
      && resetEmail.text.includes("re-enrol your authenticator promptly"));
  check("reset notice HTML escapes the affected user's name",
    resetEmail?.html?.includes("Hello 2FA &lt;Staff &amp; Co&gt;"));
  const noticeContents = `${resetEmail?.html ?? ""}\n${resetEmail?.text ?? ""}`;
  const issuedRecoveryCodes = [
    ...(recoveryCodes ?? []),
    ...(regenerated.data?.recoveryCodes ?? []),
    ...(replenished.data?.recoveryCodes ?? []),
  ];
  check("reset notice contains no passwords, authenticator secret, or recovery codes",
    !noticeContents.includes("password-456")
      && !noticeContents.includes(setup.data.secret)
      && issuedRecoveryCodes.every((code) => !noticeContents.includes(code)));
  check("successful reset clears 2FA before notification is sent",
    resetState?.totp_enabled === false && resetState.totp_secret === null && resetState.totp_recovery_hash === null);
  const s4 = makeSession();
  const login4 = await s4("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  check("plain login works after admin reset", login4.status === 200 && !login4.data?.requires2fa);

  const reSetup = await s4("GET", "/auth/2fa/setup");
  const reEnabled = reSetup.data?.secret
    ? await s4("POST", "/auth/2fa/enable", { code: generateToken(reSetup.data.secret) })
    : { status: reSetup.status };
  check("staff can re-enrol before the email-failure case", reEnabled.status === 200);
  const deliveryFailureReset = await admin("POST", `/users/${staffId}/reset-2fa`, {});
  check("email delivery failure does not undo a successful admin reset", deliveryFailureReset.status === 200);
  const afterDeliveryFailure = (await pool.query(
    "SELECT totp_enabled, totp_secret, totp_recovery_hash FROM users WHERE id = $1",
    [staffId],
  )).rows[0];
  check("2FA remains cleared after the notification provider fails",
    afterDeliveryFailure?.totp_enabled === false
      && afterDeliveryFailure.totp_secret === null
      && afterDeliveryFailure.totp_recovery_hash === null);
  check("a failed notification is not recorded as sent", resetNotices().length === 1);
  const missingReset = await admin("POST", `/users/${staffId + 1000000}/reset-2fa`, {});
  check("reset rejects a nonexistent user", missingReset.status === 404);
  check("rejected admin reset sends no security notification", resetNotices().length === 1);

  // Staff cannot reset another user's 2FA (route is admin-only).
  const staffReset = await s4("POST", `/users/${staffId}/reset-2fa`, {});
  check("staff blocked from reset-2fa", [401, 403].includes(staffReset.status), `got ${staffReset.status}`);
  check("permission-denied reset sends no security notification", resetNotices().length === 1);
  const staffResend = await s4("POST", `/users/${invitedId}/resend-invite`, {});
  check("staff blocked from resending invitations", [401, 403].includes(staffResend.status), `got ${staffResend.status}`);

  await checkCrossTenantResetIsRejected(admin, staffId);
}

// ── Cross-tenant: tenant A's admin cannot reset tenant B's enrolled staff ────
async function checkCrossTenantResetIsRejected(adminA, ownStaffId) {
  const otherAdminEmail = `twofa-other-admin-${fixtureId}@test.local`;
  const otherStaffEmail = `twofa-other-staff-${fixtureId}@test.local`;
  const adminB = makeSession();
  const regB = await adminB("POST", "/auth/register", {
    email: otherAdminEmail, password: "password-789", name: "Other 2FA Admin", orgName: otherFixtureCompany,
  });
  check("cross-tenant: register tenant B admin", [200, 201].includes(regB.status), `got ${regB.status}`);
  const verifiedB = await adminB("GET",
    `/auth/verify-email?token=${encodeURIComponent(regB.data?.verificationToken ?? "")}`);
  check("cross-tenant: verify tenant B admin", verifiedB.status === 200, `got ${verifiedB.status}`);
  const loginB = await adminB("POST", "/auth/login", { email: otherAdminEmail, password: "password-789" });
  check("cross-tenant: login tenant B admin", loginB.status === 200, `got ${loginB.status}`);
  const setupB = await adminB("GET", "/auth/2fa/setup");
  if (!setupB.data?.secret) throw new Error("Tenant B admin could not start mandatory 2fa setup");
  const enabledB = await adminB("POST", "/auth/2fa/enable", { code: generateToken(setupB.data.secret) });
  check("cross-tenant: tenant B admin enrols 2fa", enabledB.status === 200, `got ${enabledB.status}`);
  const meB = await adminB("GET", "/auth/me");
  const clientB = meB.data?.user?.clientId ?? meB.data?.client?.id;
  const meA = await adminA("GET", "/auth/me");
  const clientA = meA.data?.user?.clientId ?? meA.data?.client?.id;
  check("cross-tenant: the two fixture tenants are distinct",
    clientA != null && clientB != null && clientA !== clientB, `A=${clientA} B=${clientB}`);

  const targetCreate = await adminB("POST", "/users", {
    email: otherStaffEmail, password: "password-012", name: "Other 2FA Staff", role: "client_staff", clientId: clientB,
  });
  check("cross-tenant: create tenant B staff", [200, 201].includes(targetCreate.status), `got ${targetCreate.status}`);
  const targetId = targetCreate.data?.id;
  if (!Number.isInteger(targetId)) throw new Error("Tenant B staff fixture was not created");
  const target = makeSession();
  const targetLogin = await target("POST", "/auth/login", { email: otherStaffEmail, password: "password-012" });
  check("cross-tenant: tenant B staff signs in", targetLogin.status === 200, `got ${targetLogin.status}`);
  const targetSetup = await target("GET", "/auth/2fa/setup");
  if (!targetSetup.data?.secret) throw new Error("Tenant B staff could not start 2fa setup");
  const targetEnabled = await target("POST", "/auth/2fa/enable", { code: generateToken(targetSetup.data.secret) });
  check("cross-tenant: tenant B staff really enrols TOTP and receives recovery codes",
    targetEnabled.status === 200 && targetEnabled.data?.recoveryCodes?.length === 10, `got ${targetEnabled.status}`);

  async function targetState() {
    const user = (await pool.query(
      `SELECT client_id, totp_enabled, totp_secret, totp_recovery_hash, updated_at::text AS updated_at
       FROM users WHERE id = $1`, [targetId])).rows[0];
    const codes = (await pool.query(
      "SELECT id, code_hash, used_at::text AS used_at FROM totp_recovery_codes WHERE user_id = $1 ORDER BY id",
      [targetId])).rows;
    return { user, codes };
  }
  // The reset alert may be sent inline or queued durably (outbox). Any
  // notification/outbox-style table present in this schema must gain no row
  // mentioning the target; matching the unique fixture email keeps this valid
  // under either delivery design without depending on a specific table.
  const notificationTables = (await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      AND table_name ~ '(outbox|notification|email|mail|deliver|dispatch|queue)'
    ORDER BY table_name`)).rows.map(row => row.table_name);
  async function notificationRowsForTarget() {
    const counts = {};
    for (const table of notificationTables) {
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM public."${table.replace(/"/g, '""')}" t
         WHERE strpos(lower(t::text), lower($1)) > 0`, [otherStaffEmail]);
      counts[table] = result.rows[0].n;
    }
    return counts;
  }

  const before = await targetState();
  check("cross-tenant: target is tenant B staff with TOTP enabled and 10 unused recovery codes",
    before.user?.client_id === clientB && before.user.totp_enabled === true && !!before.user.totp_secret
      && before.codes.length === 10 && before.codes.every(code => code.used_at === null),
    JSON.stringify({ clientId: before.user?.client_id, enabled: before.user?.totp_enabled, codes: before.codes.length }));
  const queuedBefore = await notificationRowsForTarget();
  const mailBefore = capturedEmails().length;
  const noticesBefore = resetNotices().length;

  const withoutCsrf = await adminA("POST", `/users/${targetId}/reset-2fa`, {}, { csrf: false });
  check("cross-tenant: reset without a CSRF token is refused by the CSRF check",
    withoutCsrf.status === 403 && withoutCsrf.data?.error === "CSRF validation failed",
    `got ${withoutCsrf.status} ${JSON.stringify(withoutCsrf.data)}`);

  // Control: the session's (freshly bootstrapped) CSRF token is accepted for a
  // no-op mutation in its own tenant, which sends no mail.
  const csrfControl = await adminA("PUT", `/users/${ownStaffId}`, { active: true });
  check("cross-tenant control: tenant A admin's CSRF token is accepted in its own tenant",
    csrfControl.status === 200, `got ${csrfControl.status} ${JSON.stringify(csrfControl.data)}`);
  // Same session and token: the request passes CSRF and the admin role guard,
  // so a 403 "Forbidden" comes from the route's tenant authorization, not from
  // the CSRF middleware ("CSRF validation failed").
  const crossTenant = await adminA("POST", `/users/${targetId}/reset-2fa`, {});
  check("cross-tenant: tenant A admin's reset of tenant B staff is rejected by authorization",
    crossTenant.status === 403 && crossTenant.data?.error === "Forbidden",
    `got ${crossTenant.status} ${JSON.stringify(crossTenant.data)}`);

  const after = await targetState();
  check("cross-tenant: target TOTP secret, enabled flag and recovery hash are unchanged",
    JSON.stringify(after.user) === JSON.stringify(before.user));
  check("cross-tenant: target recovery-code rows are unchanged",
    JSON.stringify(after.codes) === JSON.stringify(before.codes));
  const newMail = capturedEmails().slice(mailBefore);
  check("cross-tenant: no mail to anyone is captured for the rejected attempts",
    newMail.length === 0, JSON.stringify(newMail.map(mail => [mail.to, mail.subject])));
  check("cross-tenant: no security-reset notice is captured", resetNotices().length === noticesBefore);
  const queuedAfter = await notificationRowsForTarget();
  check("cross-tenant: no queued/outbox notification row is created for the target",
    JSON.stringify(queuedAfter) === JSON.stringify(queuedBefore),
    JSON.stringify({ before: queuedBefore, after: queuedAfter }));

  // The target can still complete 2FA sign-in with its original authenticator.
  const targetAgain = makeSession();
  const challenge = await targetAgain("POST", "/auth/login", { email: otherStaffEmail, password: "password-012" });
  check("cross-tenant: target sign-in still requires 2fa", challenge.data?.requires2fa === true);
  const totpOk = await targetAgain("POST", "/auth/2fa/verify", { code: generateToken(targetSetup.data.secret) });
  check("cross-tenant: target's original authenticator still works", totpOk.status === 200, `got ${totpOk.status}`);
}

// ── Web cookie and mobile bearer race for one unused recovery code ────────────
// Two independent valid pending challenges (a browser session pending 2FA and a
// mobile login challenge) present the same code at the same time. A test-owned
// connection holds the code's row lock until both requests are blocked on it,
// so the overlap is proven rather than left to scheduling luck.
async function raceRecoveryCodeAcrossWebAndMobile({ email, password, userId, recoveryCode, firstChannel, ipBase }) {
  const label = `mixed web/mobile recovery race (${firstChannel} queued first)`;
  const codeHash = createHash("sha256")
    .update(recoveryCode.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
  const challengeHash = token => createHash("sha256").update(token).digest("hex");
  const createdChallengeHashes = [];
  const issuedBearerTokens = [];
  // Test-local deadline for every mobile call; never inherit an open-ended wait.
  async function mobileCall(method, path, body, { token, ipSuffix, signal } = {}) {
    const deadline = AbortSignal.timeout(15000);
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `198.51.100.${ipSuffix}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (typeof data?.token === "string") issuedBearerTokens.push(data.token);
    return { status: res.status, data };
  }
  async function startChallenge(ipSuffix) {
    const started = await mobileCall("POST", "/auth/mobile-login", { email, password }, { ipSuffix });
    if (started.status !== 200 || typeof started.data?.pendingToken !== "string") {
      throw new Error(`${label}: mobile login did not issue a pending challenge (status ${started.status})`);
    }
    createdChallengeHashes.push(challengeHash(started.data.pendingToken));
    return started.data.pendingToken;
  }
  const codeRows = async () => (await pool.query(
    "SELECT id, used_at::text AS used_at FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2",
    [userId, codeHash])).rows;
  const bearerSessions = async () => Number((await pool.query(
    "SELECT count(*)::int AS n FROM mobile_sessions WHERE user_id = $1", [userId])).rows[0].n);

  try {
    const web = makeSession();
    const webLogin = await web("POST", "/auth/login", { email, password });
    check(`${label}: web contender has a valid pending 2FA session`,
      webLogin.status === 200 && webLogin.data?.requires2fa === true, `got ${webLogin.status}`);
    const webBefore = await web("GET", "/auth/me");
    check(`${label}: pending web session is not yet authenticated`, webBefore.status === 401);
    const pendingToken = await startChallenge(ipBase);

    const before = await codeRows();
    check(`${label}: code exists once and starts unused`, before.length === 1 && before[0].used_at === null);
    const sessionsBefore = await bearerSessions();

    // Both entry points end in `UPDATE totp_recovery_codes ...` against this
    // row; the web path queues on its tuple lock and the mobile path on its
    // SELECT ... FOR UPDATE subquery, so holding FOR UPDATE here stalls both.
    const locker = await pool.connect();
    const abort = new AbortController();
    let outcomes;
    let barrierError;
    let waiting = 0;
    try {
      await locker.query("BEGIN");
      await locker.query(
        "SELECT id FROM totp_recovery_codes WHERE user_id = $1 AND code_hash = $2 FOR UPDATE", [userId, codeHash]);
      // Each request gets its settle handler the moment it starts, so a rejection
      // is observed at once and cannot go unhandled while the barrier is held.
      const settle = promise => promise.then(
        value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
      const start = {
        web: () => settle(web("POST", "/auth/2fa/verify", { code: recoveryCode }, { signal: abort.signal })),
        mobile: () => settle(mobileCall("POST", "/auth/mobile-login/verify-totp",
          { pendingToken, code: recoveryCode }, { ipSuffix: ipBase, signal: abort.signal })),
      };
      const secondChannel = firstChannel === "web" ? "mobile" : "web";
      const started = {};
      let finishedEarly = false;
      const waitForQueued = async expected => {
        const deadline = Date.now() + 10000;
        do {
          const blocked = await pool.query(`
            WITH RECURSIVE blocked AS (
              SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
              UNION
              SELECT activity.pid FROM pg_stat_activity activity
              JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
            )
            SELECT count(*)::int AS waiting
            FROM blocked JOIN pg_stat_activity activity USING (pid)
            WHERE activity.query ILIKE '%UPDATE totp_recovery_codes%'
          `, [locker.processID]);
          waiting = blocked.rows[0].waiting;
          // A request that finished (or failed) while the row is locked cannot
          // reach the barrier, so stop waiting instead of running to the deadline.
          if (waiting >= expected || finishedEarly) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
      };
      // Queue the first channel on the row lock before the second starts:
      // Postgres grants queued tuple locks in arrival order, so this fixes which
      // consumer runs first and each round exercises one ordering deterministically.
      started[firstChannel] = start[firstChannel]();
      started[firstChannel].then(() => { finishedEarly = true; });
      await waitForQueued(1);
      if (waiting === 1 && !finishedEarly) {
        started[secondChannel] = start[secondChannel]();
        started[secondChannel].then(() => { finishedEarly = true; });
        await waitForQueued(2);
      }
      outcomes = Promise.all([started.web, started.mobile].map(promise => promise ?? Promise.resolve(
        { status: "rejected", reason: new Error(`${label}: request was never started`) })));
      check(`${label}: web and mobile verifications overlap at recovery-code consumption`,
        waiting === 2, `waiting: ${waiting}`);
      if (waiting !== 2) abort.abort(new Error(`${label}: requests did not reach the barrier`));
    } catch (error) {
      barrierError = error;
      abort.abort(error);
    } finally {
      let rollbackError;
      try {
        await locker.query("ROLLBACK");
      } catch (error) {
        rollbackError = error;
        barrierError ??= error;
      } finally {
        locker.release(rollbackError);
      }
    }
    const settled = outcomes ? await outcomes : [];
    if (barrierError) throw barrierError;
    const transportFailures = settled.filter(result => result.status === "rejected");
    if (transportFailures.length > 0) {
      throw new AggregateError(transportFailures.map(result => result.reason), `${label}: request transport failure`);
    }
    const [webResult, mobileResult] = settled.map(result => result.value);
    const webWon = webResult.status === 200;
    const mobileWon = mobileResult.status === 200 && typeof mobileResult.data?.token === "string";
    check(`${label}: exactly one channel authenticates`, Number(webWon) + Number(mobileWon) === 1,
      `web ${webResult.status}, mobile ${mobileResult.status}`);
    check(`${label}: the channel that reached the lock first is the one that signs in`,
      firstChannel === "web" ? webWon : mobileWon, `web ${webResult.status}, mobile ${mobileResult.status}`);
    check(`${label}: the losing channel is rejected`,
      webWon ? mobileResult.status === 401 && mobileResult.data?.token === undefined
        : webResult.status === 401,
      `web ${webResult.status}, mobile ${mobileResult.status}`);

    const webMe = await web("GET", "/auth/me");
    check(`${label}: web cookie is authenticated only if web won`,
      webWon ? webMe.status === 200 && webMe.data?.user?.id === userId : webMe.status === 401,
      `won ${webWon}, /auth/me ${webMe.status}`);
    if (mobileWon) {
      const bearerMe = await mobileCall("GET", "/auth/me", undefined, { token: mobileResult.data.token, ipSuffix: ipBase });
      check(`${label}: winning bearer token authenticates`,
        bearerMe.status === 200 && bearerMe.data?.user?.id === userId, `got ${bearerMe.status}`);
    }
    check(`${label}: exactly the winner's bearer sessions exist`,
      await bearerSessions() === sessionsBefore + (mobileWon ? 1 : 0));
    const challengeLeft = await pool.query(
      "SELECT count(*)::int AS n FROM mobile_login_challenges WHERE token_hash = $1", [challengeHash(pendingToken)]);
    check(`${label}: mobile challenge is consumed only if mobile won`,
      challengeLeft.rows[0].n === (mobileWon ? 0 : 1));

    const after = await codeRows();
    check(`${label}: exactly one matching recovery-code row is marked used`,
      after.length === 1 && after[0].id === before[0]?.id && typeof after[0].used_at === "string");

    // Replay on fresh, valid challenges for both channels.
    const webReplay = makeSession();
    const replayLogin = await webReplay("POST", "/auth/login", { email, password });
    check(`${label}: web replay starts from a valid pending session`, replayLogin.data?.requires2fa === true);
    const webReplayResult = await webReplay("POST", "/auth/2fa/verify", { code: recoveryCode });
    check(`${label}: replaying the code on web fails`, webReplayResult.status === 401, `got ${webReplayResult.status}`);
    check(`${label}: web replay leaves the session unauthenticated`, (await webReplay("GET", "/auth/me")).status === 401);
    const replayToken = await startChallenge(ipBase + 1);
    const mobileReplay = await mobileCall("POST", "/auth/mobile-login/verify-totp",
      { pendingToken: replayToken, code: recoveryCode }, { ipSuffix: ipBase + 1 });
    check(`${label}: replaying the code on mobile fails without a bearer`,
      mobileReplay.status === 401 && mobileReplay.data?.token === undefined, `got ${mobileReplay.status}`);
    check(`${label}: replays issue no bearer session`,
      await bearerSessions() === sessionsBefore + (mobileWon ? 1 : 0));
    const afterReplay = await codeRows();
    check(`${label}: replays do not change the used timestamp`,
      afterReplay.length === 1 && afterReplay[0].used_at === after[0]?.used_at);
  } finally {
    // Remove exactly the challenges and bearer sessions this race created.
    await pool.query("DELETE FROM mobile_login_challenges WHERE token_hash = ANY($1::text[])", [createdChallengeHashes]);
    await pool.query("DELETE FROM mobile_sessions WHERE token = ANY($1::text[])", [issuedBearerTokens]);
  }
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
    const fixtureClients = await cleanupClient.query("SELECT id FROM clients WHERE name = ANY($1::text[])",
      [fixtureCompanies]);
    const clientIds = fixtureClients.rows.map(row => row.id);
    await cleanupClient.query("DELETE FROM users WHERE email = ANY($1::text[]) OR client_id = ANY($2::int[])",
      [fixtureEmails, clientIds]);
    await cleanupClient.query("DELETE FROM clients WHERE id = ANY($1::int[])", [clientIds]);
    await cleanupClient.query("COMMIT");
    const remaining = await cleanupClient.query(`
      SELECT
        (SELECT count(*)::int FROM users WHERE email = ANY($1::text[])) AS users,
        (SELECT count(*)::int FROM clients WHERE name = ANY($2::text[])) AS clients
    `, [fixtureEmails, fixtureCompanies]);
    check("fixture users and tenants are removed after the run",
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
