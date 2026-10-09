import assert from "node:assert/strict";

// Run against a NODE_ENV=test API, after its normal migrations. Does not start
// or restart the app. Test accounts intentionally retain their audit evidence.
const base = process.env.API_BASE ?? "http://localhost:80/api";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}
async function tenant(label) {
  const request = session();
  const email = `audit-log-${label}-${suffix}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `Audit ${label}`, email, password: "password-123" });
  assert.ok([200, 201].includes(registered.status));
  assert.ok(registered.data.verificationToken, "Requires NODE_ENV=test verification tokens");
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
  const login = await request("POST", "/auth/login", { email, password: "password-123" });
  assert.equal(login.status, 200);
  const me = await request("GET", "/auth/me");
  return { request, user: me.data.user ?? me.data };
}
const anon = session();
assert.equal((await anon("GET", "/audit-log?module=fire")).status, 401);
const a = await tenant("a");
const b = await tenant("b");
assert.equal((await a.request("GET", "/audit-log?module=invalid")).status, 400);
assert.equal((await a.request("GET", "/audit-log")).status, 400);
assert.equal((await a.request("GET", `/audit-log?module=fire&clientId=${b.user.clientId}`)).status, 403);
const created = await a.request("POST", "/fire-safety", {
  checkType: "alarm", checkDate: new Date().toISOString().slice(0, 10),
  result: "pass", notes: "Audit endpoint fixture",
  changedBy: b.user.id, actorId: b.user.id,
});
assert.equal(created.status, 201, JSON.stringify(created.data));
const own = await a.request("GET", "/audit-log?module=fire");
assert.equal(own.status, 200);
assert.ok(Array.isArray(own.data) && own.data.length <= 50);
const event = own.data.find((e) => e.rowId === created.data.id && e.action === "create");
assert.ok(event, "create appears in tenant history");
assert.equal(event.changedBy, a.user.id, "submitted actor spoof must be ignored");
assert.ok(event.actorName && event.changedAt && event.diff);
const foreign = await b.request("GET", "/audit-log?module=fire");
assert.equal(foreign.status, 200);
assert.ok(!foreign.data.some((e) => e.id === event.id));
for (const role of ["client_staff", "client_viewer", "client_admin"]) {
  const email = `audit-${role}-${suffix}@test.local`;
  const createdUser = await a.request("POST", "/users", {
    name: `Audit ${role}`, email, password: "password-123", role, clientId: a.user.clientId,
  });
  assert.ok([200, 201].includes(createdUser.status), JSON.stringify(createdUser.data));
  const request = session();
  assert.equal((await request("POST", "/auth/login", { email, password: "password-123" })).status, 200);
  assert.equal((await request("GET", "/audit-log?module=fire")).status, role === "client_admin" ? 200 : 403);
  assert.equal((await request("GET", `/audit-log?module=fire&clientId=${b.user.clientId}`)).status, 403);
}
console.info("Audit endpoint role, tenant, module validation and trusted-actor checks passed.");