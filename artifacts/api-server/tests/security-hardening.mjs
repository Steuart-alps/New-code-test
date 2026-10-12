// Regression coverage for account, session and settings hardening:
// owner accounts protected from client admins, other users' sign-in details,
// write-only provider keys and sender domains, sign-out on password reset,
// hashed and capped mobile tokens, session id rotation at sign-in, staff
// roster responses and sites, platform-operator routes, trials on new
// businesses, deletion via erasure review and injury details by role.
//
//   bash tests/run-fresh-schema.sh tests/security-hardening.mjs
//
// Uses the harness's private API, database and captured system mail.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = process.env.API_BASE;
const outbox = process.env.TEST_EMAIL_CAPTURE_PATH;
const databaseUrl = process.env.DATABASE_URL;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname) || !outbox || !databaseUrl) {
  throw new Error("Run via tests/run-fresh-schema.sh: needs the disposable API, database and captured mail.");
}

const password = "password-123";
const digest = (token) => `sha256:${createHash("sha256").update(token).digest("hex")}`;

function sql(query) {
  return execFileSync("psql", [databaseUrl, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], { encoding: "utf8" }).trim();
}
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Each client gets its own forwarded address so per-IP sign-in limits do not
// trip across the many accounts this suite creates (the API trusts one proxy).
let addresses = 0;
const nextIp = () => { addresses += 1; return `10.77.${(addresses >> 8) & 255}.${addresses & 255}`; };

function session() {
  let cookie = "";
  const ip = nextIp();
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  request.cookie = () => cookie;
  return request;
}

async function bearer(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp(), Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function mobileLogin(email) {
  const response = await fetch(`${base}/auth/mobile-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp() },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

async function mailTo(email) {
  let content = "";
  try { content = await readFile(outbox, "utf8"); } catch { /* not created yet */ }
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((m) => m.to === email);
}

async function registerOwner(label) {
  const owner = session();
  const email = `${label}-${randomUUID()}@test.local`;
  const registered = await owner("POST", "/auth/register", { name: `${label} Owner`, orgName: `${label} Ltd`, email, password });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal((await owner("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
  assert.equal((await owner("POST", "/auth/login", { email, password })).status, 200);
  const me = await owner("GET", "/auth/me");
  const user = me.data.user ?? me.data;
  return { request: owner, email, id: user.id, clientId: user.clientId };
}

async function addUser(owner, role, label) {
  const email = `${label}-${randomUUID()}@test.local`;
  const created = await owner.request("POST", "/users", { name: label, email, password, role, clientId: owner.clientId });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const request = session();
  assert.equal((await request("POST", "/auth/login", { email, password })).status, 200);
  return { request, email, id: created.data.id };
}

test("a client admin cannot take over the owner or set another user's sign-in details", async () => {
  const owner = await registerOwner("takeover");
  const admin = await addUser(owner, "client_admin", "admin");
  const staff = await addUser(owner, "client_staff", "staff");

  assert.equal((await admin.request("PUT", `/users/${owner.id}`, { email: `attacker-${randomUUID()}@test.local` })).status, 403);
  assert.equal((await admin.request("PUT", `/users/${owner.id}`, { password: "attacker-pass-1" })).status, 403);
  assert.equal((await admin.request("PUT", `/users/${owner.id}`, { active: false })).status, 403);
  assert.equal((await admin.request("POST", `/users/${owner.id}/reset-2fa`, {})).status, 403);
  assert.equal((await admin.request("DELETE", `/users/${owner.id}`)).status, 403);
  assert.equal(sql(`SELECT email || '|' || active FROM users WHERE id = ${owner.id}`), `${owner.email}|true`);

  // Other users' email and password are not set directly, by anyone.
  for (const actor of [admin, owner]) {
    const changedEmail = await actor.request("PUT", `/users/${staff.id}`, { email: `moved-${randomUUID()}@test.local` });
    assert.equal(changedEmail.status, 400, JSON.stringify(changedEmail.data));
    assert.equal((await actor.request("PUT", `/users/${staff.id}`, { password: "replaced-pass-1" })).status, 400);
  }
  // The edit form re-sends the unchanged email; ordinary edits still work.
  const renamed = await admin.request("PUT", `/users/${staff.id}`, { name: "Renamed Staff", email: staff.email.toUpperCase(), role: "client_staff" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.name, "Renamed Staff");
  assert.equal(renamed.data.email, staff.email);
  assert.equal((await staff.request("POST", "/auth/login", { email: staff.email, password })).status, 200);
});

test("a clientId in the body must match the one in the URL", async () => {
  const owner = await registerOwner("mismatch");
  const other = await registerOwner("mismatch-other");
  const email = `smuggled-${randomUUID()}@test.local`;
  const body = { name: "Smuggled", email, password, role: "client_admin", clientId: other.clientId };

  const mixed = await owner.request("POST", `/users?clientId=${owner.clientId}`, body);
  assert.equal(mixed.status, 400, JSON.stringify(mixed.data));
  assert.equal((await owner.request("POST", "/users", body)).status, 403);
  assert.equal((await owner.request("POST", `/users?clientId=${other.clientId}`, { ...body, clientId: owner.clientId })).status, 400);
  assert.equal(sql(`SELECT count(*) FROM users WHERE email = ${literal(email)}`), "0", "nothing was written");

  // The same business in both places is the normal web client shape.
  const same = await owner.request("POST", `/users?clientId=${owner.clientId}`, { ...body, clientId: owner.clientId });
  assert.equal(same.status, 201, JSON.stringify(same.data));
  assert.equal(sql(`SELECT client_id FROM users WHERE email = ${literal(email)}`), String(owner.clientId));
});

test("the provider key is write-only and senders must use the business's own domain", async () => {
  const owner = await registerOwner("settings");
  const staff = await addUser(owner, "client_staff", "settings-staff");
  const secret = `re_${randomUUID().replace(/-/g, "")}`;

  const saved = await owner.request("PUT", "/settings", { resendApiKey: secret, companyName: "Settings Ltd", smtpFromName: "Settings Team" });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(JSON.stringify(saved.data).includes(secret), false, "PUT response must not echo the key");
  assert.equal(saved.data.resendApiKeySet, true);

  const ownerView = await owner.request("GET", "/settings");
  assert.equal(ownerView.status, 200);
  assert.equal(JSON.stringify(ownerView.data).includes(secret), false);
  assert.equal(ownerView.data.resendApiKey, null);
  assert.equal(ownerView.data.resendApiKeySet, true);
  assert.equal(ownerView.data.smtpFromName, "Settings Team");

  const staffView = await staff.request("GET", "/settings");
  assert.equal(staffView.status, 200);
  assert.equal(JSON.stringify(staffView.data).includes(secret), false);
  assert.equal(staffView.data.resendApiKeySet, false);
  assert.equal(staffView.data.companyName, "Settings Ltd");
  assert.equal(staffView.data.smtpFromName, null, "manager-only settings are not shown to staff");

  // The form submits an empty key when left untouched: the stored key stays.
  assert.equal((await owner.request("PUT", "/settings", { resendApiKey: "", companyName: "Settings Ltd" })).status, 200);
  assert.equal(sql(`SELECT value FROM app_settings WHERE client_id = ${owner.clientId} AND key = 'resendApiKey'`), secret);
  assert.equal((await owner.request("PUT", "/settings", { resendApiKey: null })).status, 200);

  // Without its own provider key, a business may only send from its own domain.
  const foreign = await owner.request("PUT", "/settings", { smtpFrom: "alerts@another-business.example" });
  assert.equal(foreign.status, 400, JSON.stringify(foreign.data));
  sql(`INSERT INTO app_settings (client_id, key, value) VALUES (${owner.clientId}, 'resendDomainName', 'settings-ltd.example')`);
  assert.equal((await owner.request("PUT", "/settings", { smtpFrom: "alerts@another-business.example" })).status, 400);
  assert.equal((await owner.request("PUT", "/settings", { smtpFrom: "alerts@settings-ltd.example" })).status, 200);
  assert.equal((await owner.request("PUT", "/settings", { smtpFromName: "Evil\r\nBcc: x@y.example" })).status, 400);
});

test("password reset signs out every session and phone; mobile tokens are stored hashed", async () => {
  const owner = await registerOwner("signout");
  const staff = await addUser(owner, "client_staff", "signout-staff");
  const otherBrowser = session();
  assert.equal((await otherBrowser("POST", "/auth/login", { email: staff.email, password })).status, 200);

  const mobile = await mobileLogin(staff.email);
  assert.match(mobile.token, /^[0-9a-f]{64}$/);
  const stored = sql(`SELECT token FROM mobile_sessions WHERE user_id = ${staff.id}`);
  assert.equal(stored, digest(mobile.token), "only a digest of the bearer is stored");
  assert.equal((await bearer("GET", "/auth/me", mobile.token)).status, 200);
  assert.equal((await bearer("GET", "/auth/me", stored)).status, 401, "the stored digest is not a credential");

  // A plaintext row left by an older instance keeps working until hashed.
  const legacy = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  sql(`INSERT INTO mobile_sessions (user_id, token, expires_at) VALUES (${staff.id}, ${literal(legacy)}, now() + interval '30 days')`);
  assert.equal((await bearer("GET", "/auth/me", legacy)).status, 200);

  assert.equal((await session()("POST", "/auth/forgot-password", { email: staff.email })).status, 200);
  const mail = await mailTo(staff.email);
  assert.equal(mail.length, 1);
  const token = /reset-password\?token=([0-9a-f]{64})/.exec(mail[0].text)?.[1];
  assert.ok(token);
  assert.equal(sql(`SELECT count(*) FROM password_reset_tokens WHERE token = ${literal(token)}`), "0", "the reset link is not stored in plaintext");
  assert.equal(sql(`SELECT count(*) FROM password_reset_tokens WHERE token = ${literal(digest(token))}`), "1");

  const newPassword = "brand-new-pass-1";
  const [first, second] = await Promise.all([
    session()("POST", "/auth/reset-password", { token, password: newPassword }),
    session()("POST", "/auth/reset-password", { token, password: "other-new-pass-1" }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 400], "a reset link works exactly once");

  assert.equal((await staff.request("GET", "/auth/me")).status, 401, "existing browser sessions are signed out");
  assert.equal((await otherBrowser("GET", "/auth/me")).status, 401);
  assert.equal((await bearer("GET", "/auth/me", mobile.token)).status, 401, "phones are signed out");
  assert.equal((await bearer("GET", "/auth/me", legacy)).status, 401);
  assert.equal(sql(`SELECT count(*) FROM mobile_sessions WHERE user_id = ${staff.id}`), "0");
});

test("signing in issues a new session id and mobile renewal is capped from sign-in", async () => {
  const owner = await registerOwner("rotation");
  const browser = session();
  assert.equal((await browser("GET", "/auth/csrf-token")).status, 200);
  const before = browser.cookie();
  assert.ok(before, "an anonymous session cookie was issued");
  assert.equal((await browser("POST", "/auth/login", { email: owner.email, password })).status, 200);
  assert.notEqual(browser.cookie(), before, "the pre-login session id is not reused");
  assert.equal((await browser("GET", "/auth/me")).status, 200);

  const mobile = await mobileLogin(owner.email);
  // Signed in 179 days ago and due for renewal: only one more day is granted.
  sql(`UPDATE mobile_sessions SET authenticated_at = now() - interval '179 days', expires_at = now() + interval '1 day'
       WHERE token = ${literal(digest(mobile.token))}`);
  const refreshed = await bearer("POST", "/auth/mobile-refresh", mobile.token);
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  const limit = Date.now() + 2 * 24 * 60 * 60 * 1000;
  assert.ok(new Date(refreshed.data.expiresAt).getTime() < limit, `renewal capped, got ${refreshed.data.expiresAt}`);
});

test("roster responses never include PIN data and sites must belong to the business", async () => {
  const owner = await registerOwner("roster");
  const other = await registerOwner("roster-other");
  const ownSite = await owner.request("POST", "/sites", { name: "Own Site" });
  assert.equal(ownSite.status, 201, JSON.stringify(ownSite.data));
  const foreignSite = await other.request("POST", "/sites", { name: "Foreign Site" });
  assert.equal(foreignSite.status, 201, JSON.stringify(foreignSite.data));

  assert.equal((await owner.request("POST", "/staff-roster", { name: "Foreign Placement", siteId: foreignSite.data.id })).status, 403);
  const created = await owner.request("POST", "/staff-roster", { name: "Roster Person", siteId: ownSite.data.id });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  for (const key of ["pin_hash", "pin_attempts", "pin_locked_until", "pin_setup_attempts", "pin_setup_locked_until"]) {
    assert.equal(key in created.data, false, `POST response has no ${key}`);
  }
  sql(`UPDATE staff_roster SET pin_hash = '$2b$10$fakehashfakehashfakehashfakehashfakehashfakehashfake', pin_attempts = 2 WHERE id = ${created.data.id}`);

  assert.equal((await owner.request("PATCH", `/staff-roster/${created.data.id}`, { siteId: foreignSite.data.id })).status, 403);
  const patched = await owner.request("PATCH", `/staff-roster/${created.data.id}`, { jobTitle: "Lifeguard" });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal(patched.data.job_title, "Lifeguard");
  assert.equal(patched.data.site_name, "Own Site");
  for (const key of ["pin_hash", "pin_attempts", "pin_locked_until", "pin_setup_attempts", "pin_setup_locked_until"]) {
    assert.equal(key in patched.data, false, `PATCH response has no ${key}`);
  }
  assert.equal(JSON.stringify(patched.data).includes("fakehash"), false);
  assert.equal(sql(`SELECT site_id FROM staff_roster WHERE id = ${created.data.id}`), String(ownSite.data.id));

  // A roster row pointed at another business's site (legacy data) never shows its name.
  sql(`UPDATE staff_roster SET site_id = ${foreignSite.data.id} WHERE id = ${created.data.id}`);
  const listed = await owner.request("GET", "/staff-roster");
  const row = listed.data.find((item) => item.id === created.data.id);
  assert.equal(row.site_name, null);
});

test("platform routes, new-business trials and permanent deletion", async () => {
  const owner = await registerOwner("platform");
  assert.equal((await owner.request("POST", "/billing/discount-code", {})).status, 403, "owners cannot issue ALPS codes");
  assert.equal((await owner.request("POST", "/admin/ensure-service-prices", {})).status, 403);
  assert.equal((await owner.request("GET", "/admin/service-price-preflight")).status, 403, "served at /api/admin, not /api/api/admin");

  const slug = `extra-${randomUUID().slice(0, 8)}`;
  const created = await owner.request("POST", "/clients", { name: "Second Business", slug });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.ok(created.data.trialEndsAt, "a new business starts on a trial");
  const trialDays = (new Date(created.data.trialEndsAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(trialDays > 13 && trialDays <= 14.01, `14-day trial, got ${trialDays}`);

  const deleted = await owner.request("DELETE", `/clients/${created.data.id}`);
  assert.equal(deleted.status, 409, "no immediate hard delete without an approved, matured erasure request");
  assert.equal(sql(`SELECT count(*) FROM clients WHERE id = ${created.data.id}`), "1");
});

test("injury details are only returned to managers", async () => {
  const owner = await registerOwner("injury");
  const staff = await addUser(owner, "client_staff", "injury-staff");
  const viewer = await addUser(owner, "client_viewer", "injury-viewer");
  const reported = await owner.request("POST", "/incidents", {
    incidentDate: new Date().toISOString().slice(0, 10), location: "Kitchen", description: "Slip", involvedName: "A Person",
    injuriesSustained: "Fractured wrist", reportedBy: "Owner", riddorRationale: "Not reportable: no absence",
  });
  assert.equal(reported.status, 201, JSON.stringify(reported.data));

  const managerList = await owner.request("GET", "/incidents");
  assert.equal(managerList.data.find((row) => row.id === reported.data.id).injuriesSustained, "Fractured wrist");
  for (const reader of [staff, viewer]) {
    const list = await reader.request("GET", "/incidents");
    assert.equal(list.status, 200);
    assert.equal(list.data.find((row) => row.id === reported.data.id).injuriesSustained, null);
  }
  // Staff saving the form with the redacted (empty) field keeps the record.
  const edited = await staff.request("PUT", `/incidents/${reported.data.id}`, { location: "Kitchen store", injuriesSustained: null });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.injuriesSustained, null);
  assert.equal(sql(`SELECT injuries_sustained FROM incidents WHERE id = ${reported.data.id}`), "Fractured wrist");

  sql(`UPDATE users SET is_department_manager = true WHERE id = ${staff.id}`);
  const managerStaff = await staff.request("GET", "/incidents");
  assert.equal(managerStaff.data.find((row) => row.id === reported.data.id).injuriesSustained, "Fractured wrist");
});
