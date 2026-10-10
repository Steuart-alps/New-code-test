import crypto from "node:crypto";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// One cookie jar per signed-in person.
function session() {
  let cookie = "";
  return async function request(method, path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
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

async function enrol(request) {
  const setup = await request("GET", "/auth/2fa/setup");
  const enabled = await request("POST", "/auth/2fa/enable", { code: currentTotp(setup.data.secret) });
  return enabled.status === 200 ? setup.data.secret : null;
}

async function main() {
  const suffix = Date.now();
  const password = "password-123";
  const managerEmail = `two-factor-policy-${suffix}@test.local`;
  const staffEmail = `two-factor-policy-staff-${suffix}@test.local`;

  const manager = session();
  const registered = await manager("POST", "/auth/register", { name: "2FA Policy Manager", email: managerEmail, password });
  check("manager registration succeeds", registered.status === 200);
  await manager("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const firstLogin = await manager("POST", "/auth/login", { email: managerEmail, password });
  check("2FA is required by default", firstLogin.data?.requires2faSetup === true);
  check("manager can enrol", await enrol(manager) !== null);

  const defaults = await manager("GET", "/settings");
  check("setting is unset by default", defaults.status === 200 && defaults.data?.requireTwoFactor === null);
  const me = await manager("GET", "/auth/me");
  check("/auth/me reports 2FA as required by default", me.data?.twoFactorRequired === true);

  const created = await manager("POST", "/users", { name: "Policy Staff", email: staffEmail, password, role: "client_staff", active: true, clientId: me.data?.user?.clientId });
  check("manager can create a staff account", created.status === 201, JSON.stringify(created.data));

  const staff = session();
  const staffLogin = await staff("POST", "/auth/login", { email: staffEmail, password });
  check("staff must set up 2FA while required", staffLogin.data?.requires2faSetup === true);
  check("staff mobile login also requires setup", (await staff("POST", "/auth/mobile-login", { email: staffEmail, password })).data?.requires2faSetup === true);

  check("invalid setting values are rejected", (await manager("PUT", "/settings", { requireTwoFactor: "maybe" })).status === 400);
  const turnedOff = await manager("PUT", "/settings", { requireTwoFactor: "false" });
  check("manager can make 2FA optional", turnedOff.status === 200 && turnedOff.data?.requireTwoFactor === "false");

  const staffPasswordOnly = await staff("POST", "/auth/login", { email: staffEmail, password });
  check("staff sign in with just a password when optional", staffPasswordOnly.status === 200 && staffPasswordOnly.data?.user?.email === staffEmail && staffPasswordOnly.data?.twoFactorRequired === false, JSON.stringify(staffPasswordOnly.data));
  const staffMe = await staff("GET", "/auth/me");
  check("staff /auth/me is a full session", staffMe.status === 200 && !staffMe.data?.requires2faSetup && staffMe.data?.twoFactorRequired === false);
  check("staff can use the app without 2FA", (await staff("GET", "/sites")).status === 200);
  const staffMobile = await staff("POST", "/auth/mobile-login", { email: staffEmail, password });
  check("staff mobile login issues a token when optional", typeof staffMobile.data?.token === "string");
  check("staff cannot change the requirement", (await staff("PUT", "/settings", { requireTwoFactor: "true" })).status === 403);

  const staffSecret = await enrol(staff);
  check("staff can still enrol voluntarily", staffSecret !== null);
  check("disabling needs the password", (await staff("POST", "/auth/2fa/disable", { password: "wrong" })).status === 401);
  check("staff can turn their own 2FA off when optional", (await staff("POST", "/auth/2fa/disable", { password })).status === 200);
  check("2FA is off after disabling", (await staff("GET", "/auth/me")).data?.user?.totpEnabled === false);

  const turnedOn = await manager("PUT", "/settings", { requireTwoFactor: "true" });
  check("manager can require 2FA again", turnedOn.status === 200 && turnedOn.data?.requireTwoFactor === "true");
  const blocked = await staff("GET", "/sites");
  check("existing staff session is blocked until enrolment", blocked.status === 403 && blocked.data?.requires2faSetup === true);
  check("staff /auth/me asks for setup", (await staff("GET", "/auth/me")).data?.requires2faSetup === true);
  check("staff can enrol from the blocked session", await enrol(staff) !== null);
  check("staff can use the app after enrolling", (await staff("GET", "/sites")).status === 200);
  check("disabling is refused while required", (await staff("POST", "/auth/2fa/disable", { password })).status === 403);

  console.log(`${passed} checks passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
