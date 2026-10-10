import { totpCode as currentTotp } from "./two-factor-fixture.mjs";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let cookie = "";
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function main() {
  // The shared fixture's generator matches the RFC 6238 SHA-1 test vectors, so
  // every suite that enrols through it computes the same codes as a real app.
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
  check("fixture TOTP matches RFC 6238 at T=59", currentTotp(rfcSecret, 59_000) === "287082");
  check("fixture TOTP matches RFC 6238 at T=1111111109", currentTotp(rfcSecret, 1_111_111_109_000) === "081804");
  check("fixture TOTP matches RFC 6238 at T=1234567890", currentTotp(rfcSecret, 1_234_567_890_000) === "005924");

  const suffix = Date.now();
  const email = `mandatory-2fa-${suffix}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: "Mandatory 2FA Test",
    email,
    password: "password-123",
  });
  check("registration succeeds", registered.status === 200);
  check("verification token is available in test mode", typeof registered.data?.verificationToken === "string");
  check("email verification succeeds", (await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);

  const firstLogin = await request("POST", "/auth/login", { email, password: "password-123" });
  check("first login requires setup", firstLogin.status === 200 && firstLogin.data?.requires2faSetup === true);
  const mobileBeforeSetup = await request("POST", "/auth/mobile-login", { email, password: "password-123" });
  check("mobile first login also requires setup", mobileBeforeSetup.status === 200 && mobileBeforeSetup.data?.requires2faSetup === true);
  check("setup requirement survives auth refresh", (await request("GET", "/auth/me")).status === 200);
  check("protected route is not accessible during setup", (await request("GET", "/sites")).status === 401);

  const setup = await request("GET", "/auth/2fa/setup");
  check("setup QR is issued to the pending session", setup.status === 200 && typeof setup.data?.secret === "string");
  const enabled = await request("POST", "/auth/2fa/enable", { code: currentTotp(setup.data.secret) });
  check("setup code enables 2FA", enabled.status === 200 && enabled.data?.recoveryCodes?.length === 10);
  const me = await request("GET", "/auth/me");
  check("enabled user receives an authenticated session", me.status === 200 && me.data?.user?.totpEnabled === true);
  check("protected route is usable after enrollment", (await request("GET", "/sites")).status === 200);

  // A live session whose authenticator is reset (here by the account's own
  // admin action) is held at setup until a new authenticator is enrolled.
  const reset = await request("POST", `/users/${me.data.user.id}/reset-2fa`);
  check("admin 2FA reset succeeds", reset.status === 200, JSON.stringify(reset.data));
  const blocked = await request("GET", "/sites");
  check("existing session is blocked after its authenticator is reset",
    blocked.status === 403 && blocked.data?.requires2faSetup === true, `status ${blocked.status}`);
  check("mutations are blocked too", (await request("POST", "/sites", { name: "Blocked site" })).status === 403);
  const reSetup = await request("GET", "/auth/2fa/setup");
  check("reset session can start enrollment", reSetup.status === 200 && typeof reSetup.data?.secret === "string");
  const reEnabled = await request("POST", "/auth/2fa/enable", { code: currentTotp(reSetup.data.secret) });
  check("re-enrollment succeeds", reEnabled.status === 200);
  check("protected route is usable after re-enrollment", (await request("GET", "/sites")).status === 200);
  const totpSecret = reSetup.data.secret;

  await request("POST", "/auth/logout");
  const secondLogin = await request("POST", "/auth/login", { email, password: "password-123" });
  check("later login requires an authenticator code", secondLogin.status === 200 && secondLogin.data?.requires2fa === true);
  const verified = await request("POST", "/auth/2fa/verify", { code: currentTotp(totpSecret) });
  check("authenticator code completes login", verified.status === 200 && verified.data?.user?.totpEnabled === true);

  await request("POST", "/auth/logout");
  const mobileSetup = await request("POST", "/auth/mobile-login", { email, password: "password-123" });
  check("mobile login also requires the configured second factor", mobileSetup.status === 200 && mobileSetup.data?.pendingToken);

  console.log(`${passed} checks passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});