import crypto from "node:crypto";

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

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function currentTotp(secret) {
  const counter = Math.floor(Date.now() / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

async function main() {
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

  await request("POST", "/auth/logout");
  const secondLogin = await request("POST", "/auth/login", { email, password: "password-123" });
  check("later login requires an authenticator code", secondLogin.status === 200 && secondLogin.data?.requires2fa === true);
  const verified = await request("POST", "/auth/2fa/verify", { code: currentTotp(setup.data.secret) });
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