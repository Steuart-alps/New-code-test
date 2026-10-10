import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const BASE = process.env.API_BASE;
assert.ok(BASE, "Run through test:daily-track-month-history to start a test-mode API");

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = await response.json().catch(() => null);
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
}

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function enrol(request) {
  const { secret } = await request("GET", "/auth/2fa/setup");
  await request("POST", "/auth/2fa/enable", { code: totp(secret) });
}

async function register(suffix) {
  const request = session();
  const email = `month-history-${suffix}@test.local`;
  const { verificationToken } = await request("POST", "/auth/register", {
    name: "Month History Admin", email, password: "password-123",
  });
  assert.ok(verificationToken, "test-mode email verification token required");
  await request("GET", `/auth/verify-email?token=${encodeURIComponent(verificationToken)}`);
  await request("POST", "/auth/login", { email, password: "password-123" });
  await enrol(request);
  const { user } = await request("GET", "/auth/me");
  return { request, clientId: user.clientId };
}

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const first = await register(`${suffix}-a`);
const second = await register(`${suffix}-b`);
assert.notEqual(first.clientId, second.clientId);

const alphaDept = await first.request("POST", "/departments", { name: `Alpha ${suffix}` });
const betaDept = await first.request("POST", "/departments", { name: `Beta ${suffix}` });
const alphaSite = await first.request("POST", "/sites", { name: `Alpha ${suffix}`, departmentId: alphaDept.id });
const betaSite = await first.request("POST", "/sites", { name: `Beta ${suffix}`, departmentId: betaDept.id });
const otherSite = await second.request("POST", "/sites", { name: `Other ${suffix}` });
// Intentionally historical: the month-history view over a past date range is
// what this suite tests. The owner (a client admin, exempt from the 24-hour
// record lock) creates every record and staff only read them, so these fixed
// dates never age into lock results. Do not make them relative to today.
const submittedAt = "2025-04-10T12:00:00.000Z";
const checklist = (siteId, checkDate, checklistType, submitted = false) => ({
  siteId, checkDate, checklistType, items: [],
  ...(submitted ? { submittedAt } : {}),
});
const signoff = (siteId, signoffDate, submitted = false) => ({
  siteId, signoffDate, managerName: "Test Manager",
  ...(submitted ? { submittedAt } : {}),
});
await first.request("POST", "/daily-track-am", checklist(alphaSite.id, "2025-04-10", "kitchen_opening"));
await first.request("POST", "/daily-track-am", checklist(betaSite.id, "2025-04-11", "premises_opening", true));
await first.request("POST", "/daily-track-am", checklist(null, "2025-04-10", "premises_opening"));
await first.request("POST", "/daily-track-am", checklist(alphaSite.id, "2025-04-09", "premises_opening"));
await first.request("POST", "/daily-track-am", checklist(alphaSite.id, "2025-04-12", "premises_opening"));
await first.request("POST", "/daily-track-pm/signoffs", signoff(alphaSite.id, "2025-04-10", true));
await first.request("POST", "/daily-track-pm/signoffs", signoff(betaSite.id, "2025-04-11"));
await first.request("POST", "/daily-track-pm/signoffs", signoff(betaSite.id, "2025-04-12", true));
await second.request("POST", "/daily-track-am", checklist(otherSite.id, "2025-04-10", "kitchen_opening", true));
await second.request("POST", "/daily-track-pm/signoffs", signoff(otherSite.id, "2025-04-10", true));

const range = "/daily-track-am/history?from=2025-04-10&to=2025-04-11";
const adminHistory = await first.request("GET", range);
assert.deepEqual(
  adminHistory.checklists.map(row => [row.siteId, row.checkDate, !!row.submittedAt])
    .sort((a, b) => String(a).localeCompare(String(b))),
  [[alphaSite.id, "2025-04-10", false], [betaSite.id, "2025-04-11", true], [null, "2025-04-10", false]]
    .sort((a, b) => String(a).localeCompare(String(b))),
  "admin history must include drafts, submitted records, and unassigned rows only within the range",
);
assert.deepEqual(adminHistory.signoffs.map(row => [row.siteId, !!row.submittedAt])
  .sort((a, b) => a[0] - b[0]), [[alphaSite.id, true], [betaSite.id, false]]);

const staffEmail = `month-history-staff-${suffix}@test.local`;
await first.request("POST", "/users", {
  name: "Alpha staff", email: staffEmail, password: "password-456",
  role: "client_staff", clientId: first.clientId, departmentId: alphaDept.id,
});
const staff = session();
await staff("POST", "/auth/login", { email: staffEmail, password: "password-456" });
await enrol(staff);
const staffHistory = await staff("GET", range);
assert.deepEqual(staffHistory.checklists.map(row => row.siteId).sort(), [alphaSite.id, null].sort(),
  "department history must include Alpha and shared rows, not Beta");
assert.deepEqual(staffHistory.signoffs.map(row => row.siteId), [alphaSite.id],
  "department history must exclude Beta sign-offs");
const otherHistory = await second.request("GET", range);
assert.deepEqual(otherHistory.checklists.map(row => row.siteId), [otherSite.id],
  "other tenant must not see first tenant checklists");
assert.deepEqual(otherHistory.signoffs.map(row => row.siteId), [otherSite.id],
  "other tenant must not see first tenant sign-offs");
console.log("DailyTrack history range, tenant and department isolation checks passed.");