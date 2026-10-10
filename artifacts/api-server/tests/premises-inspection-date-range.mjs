import assert from "node:assert/strict";

const BASE = process.env.API_BASE || "http://localhost:8080/api";

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
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function tenant(label) {
  const request = session();
  const email = `premises-range-${label}-${Date.now()}@test.local`;
  const registration = await request("POST", "/auth/register", {
    name: `Premises range ${label}`, email, password: "password-123",
  });
  assert.ok([200, 201].includes(registration.status));
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registration.data.verificationToken)}`)).status, 200);
  assert.equal((await request("POST", "/auth/login", { email, password: "password-123" })).status, 200);
  return request;
}

async function inspection(request, date, area) {
  const response = await request("POST", "/premises-track", {
    inspectionDate: date, inspectionType: "routine", area, status: "open",
  });
  assert.equal(response.status, 201);
}

const firstTenant = await tenant("first");
const otherTenant = await tenant("other");
// Intentionally historical: inclusive range boundaries (and the non-leap
// 2026-02-29 rejection below) are the subject. Owners create these rows and
// only read them back, so keep the dates fixed rather than relative to today.
await inspection(firstTenant, "2026-01-31", "before range");
await inspection(firstTenant, "2026-02-01", "inclusive first day");
await inspection(firstTenant, "2026-02-28", "inclusive last day");
await inspection(firstTenant, "2026-03-01", "after range");
await inspection(otherTenant, "2026-02-15", "other tenant");

const range = await firstTenant("GET", "/premises-track?from=2026-02-01&to=2026-02-28");
assert.equal(range.status, 200);
assert.deepEqual(range.data.map(row => row.area).sort(), ["inclusive first day", "inclusive last day"]);

assert.equal((await firstTenant("GET", "/premises-track?from=2026-02-29")).status, 400);
assert.equal((await firstTenant("GET", "/premises-track?from=2026-02-28&to=2026-02-01")).status, 400);
assert.equal((await firstTenant("GET", "/premises-track?siteId=not-a-site")).status, 400);

console.log("Premises inspection date range tests passed.");