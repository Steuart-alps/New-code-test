// E2E test: 2FA recovery code + admin 2FA reset.
// Usage: node tests/twofa-recovery.mjs  (API must be running on API_BASE)
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
let testIpSequence = 10;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; } else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); }
}

// Bundle the server's TOTP lib so we can generate valid codes.
const tmp = mkdtempSync(join(tmpdir(), "twofa-"));
const entry = join(tmp, "entry.mjs");
execSync(`npx esbuild src/lib/totp.ts --bundle --format=esm --platform=node --outfile=${entry}`, { stdio: "pipe" });
const { generateToken } = await import(entry);

function makeSession() {
  let cookie = "";
  const testIp = `203.0.113.${testIpSequence++}`;
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": testIp,
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
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
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  const ts = Date.now();
  const admin = makeSession();
  const reg = await admin("POST", "/auth/register", {
    email: `twofa-admin-${ts}@test.local`,
    password: "password-123",
    name: "2FA Admin",
    companyName: `TwoFA Co ${ts}`,
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

  // ── Login with recovery code ────────────────────────────────────────────────
  const s2 = makeSession();
  const login2 = await s2("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  check("login requires 2fa", login2.data?.requires2fa === true);
  const badVerify = await s2("POST", "/auth/2fa/verify", { code: "AAAA-BBBB-CCCC" });
  check("wrong recovery code rejected", badVerify.status === 401, `got ${badVerify.status}`);
  const verify = await s2("POST", "/auth/2fa/verify", { code: recoveryCode });
  check("recovery code accepted", verify.status === 200, JSON.stringify(verify.data));
  check("2fa remains enabled after recovery", verify.data?.user?.totpEnabled === true);

  // Recovery code is single-use; 2FA remains active and another code still works.
  const s3 = makeSession();
  const login3 = await s3("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  check("login still requires 2fa after recovery", login3.data?.requires2fa === true);
  const reused = await s3("POST", "/auth/2fa/verify", { code: recoveryCode });
  check("used recovery code is rejected", reused.status === 401, `got ${reused.status}`);
  const secondCode = await s3("POST", "/auth/2fa/verify", { code: recoveryCodes?.[1] });
  check("a different recovery code still works", secondCode.status === 200, JSON.stringify(secondCode.data));

  // ── Admin reset: re-enable 2FA, then admin clears it ───────────────────────
  const regenerated = await s3("POST", "/auth/2fa/recovery-codes/regenerate", { password: "password-456" });
  check("10 replacement codes issued", regenerated.data?.recoveryCodes?.length === 10, JSON.stringify(regenerated.data));
  const sRegenerated = makeSession();
  await sRegenerated("POST", "/auth/login", { email: staffEmail, password: "password-456" });
  const oldCode = await sRegenerated("POST", "/auth/2fa/verify", { code: recoveryCodes?.[2] });
  check("regeneration invalidates previous codes", oldCode.status === 401, `got ${oldCode.status}`);
  const newCode = await sRegenerated("POST", "/auth/2fa/verify", { code: regenerated.data?.recoveryCodes?.[0] });
  check("replacement recovery code works", newCode.status === 200, JSON.stringify(newCode.data));

  // ── Mobile login challenge ──────────────────────────────────────────────────
  const mobileLogin = await fetch(`${BASE}/auth/mobile-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.200" },
    body: JSON.stringify({ email: staffEmail, password: "password-456" }),
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

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error("Test run crashed:", err); process.exit(1); });
