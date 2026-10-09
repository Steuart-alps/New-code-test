import assert from "node:assert/strict";
import test from "node:test";

const base = process.env.API_BASE;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1" || !base
    || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error("Run test:feedback-triage with the disposable API/database harness.");
}

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json() };
  };
}

const password = "feedback-fixture-password-123";
const stamp = Date.now();
async function tenant(label) {
  const request = session();
  const email = `feedback-${label}-${stamp}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `Feedback ${label}`, email, password });
  assert.equal(registered.status, 200);
  assert.equal(typeof registered.data.verificationToken, "string");
  assert.equal((await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status, 200);
  assert.equal((await request("POST", "/auth/login", { email, password })).status, 200);
  const me = await request("GET", "/auth/me");
  const user = me.data.user ?? me.data;
  assert.ok(Number.isInteger(user.clientId));
  return { request, clientId: user.clientId, userId: user.id };
}

test("feedback triage persists filtered reports and enforces role and selected-client boundaries", async t => {
  const anonymous = session();
  assert.equal((await anonymous("GET", "/feedback")).status, 401);
  assert.equal((await anonymous("PATCH", "/feedback/1", { status: "resolved" })).status, 401);
  const a = await tenant("A");
  const b = await tenant("B");
  const reports = [];
  for (const category of ["bug", "feature", "feedback"]) {
    const submitted = await a.request("POST", "/feedback", {
      category, summary: `${category} report from A`, details: "Detailed fixture feedback for manager review.",
      pagePath: "/dashboard",
    });
    assert.equal(submitted.status, 201);
    assert.deepEqual(Object.keys(submitted.data).sort(), ["emailSent", "id"]);
    reports.push(submitted.data.id);
  }
  const foreign = await b.request("POST", "/feedback", {
    category: "bug", summary: "Private report from B", details: "This report must not appear in client A's inbox.",
  });
  assert.equal(foreign.status, 201);

  await t.test("existing reports start new, newest first, and filters combine", async () => {
    const list = await a.request("GET", "/feedback");
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.map(row => row.id), [...reports].reverse());
    for (const row of list.data) {
      assert.equal(row.clientId, a.clientId);
      assert.equal(row.status, "new");
      assert.equal(row.internalNote, "");
      assert.equal(row.updatedAt, null);
      assert.equal(row.submitterName, "Feedback A");
    }
    const filtered = await a.request("GET", "/feedback?category=bug&status=new");
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.data.map(row => row.id), [reports[0]]);
    assert.equal((await a.request("GET", "/feedback?category=invalid")).status, 400);
    assert.equal((await a.request("GET", "/feedback?status=invalid")).status, 400);
  });

  await t.test("review, resolve, reopen and note-only edits survive reload without changing submitted evidence", async () => {
    const review = await a.request("PATCH", `/feedback/${reports[0]}`, {
      status: "reviewing", internalNote: "Investigating with the team.",
    });
    assert.equal(review.status, 200);
    assert.equal(review.data.status, "reviewing");
    assert.equal(review.data.updatedBy, a.userId);
    assert.ok(review.data.updatedAt);
    assert.equal(review.data.summary, "bug report from A");
    assert.equal(review.data.details, "Detailed fixture feedback for manager review.");
    assert.equal(review.data.internalNote, "Investigating with the team.");
    const reviewing = await a.request("GET", "/feedback?category=bug&status=reviewing");
    assert.deepEqual(reviewing.data.map(row => row.id), [reports[0]]);
    const resolve = await a.request("PATCH", `/feedback/${reports[0]}`, { status: "resolved" });
    assert.equal(resolve.status, 200);
    assert.equal(resolve.data.internalNote, "Investigating with the team.", "omitted note is preserved");
    const cleared = await a.request("PATCH", `/feedback/${reports[0]}`, { internalNote: "" });
    assert.equal(cleared.data.status, "resolved", "omitted status is preserved");
    assert.equal(cleared.data.internalNote, "", "explicit empty note clears it");
    const resolved = await a.request("GET", "/feedback?status=resolved");
    assert.deepEqual(resolved.data.map(row => row.id), [reports[0]]);
    assert.equal(resolved.data[0].internalNote, "");
    assert.equal((await a.request("PATCH", `/feedback/${reports[0]}`, { status: "new" })).data.status, "new");
  });

  await t.test("invalid or ownership-changing updates do not mutate a report", async () => {
    const before = (await a.request("GET", "/feedback")).data;
    for (const body of [{}, { status: "closed" }, { internalNote: null }, { internalNote: "x".repeat(5001) },
      { status: "resolved", clientId: b.clientId }, { userId: b.userId }, { summary: "Changed evidence" }]) {
      assert.equal((await a.request("PATCH", `/feedback/${reports[0]}`, body)).status,
        body.clientId ? 403 : 400, "the tenant middleware rejects spoofed client IDs before body validation");
    }
    assert.equal((await a.request("PATCH", "/feedback/not-an-id", { status: "resolved" })).status, 400);
    assert.equal((await a.request("PATCH", "/feedback/2147483647", { status: "resolved" })).status, 404);
    assert.deepEqual((await a.request("GET", "/feedback")).data, before);
  });

  await t.test("foreign IDs and selected-client spoofing cannot read or update another tenant", async () => {
    assert.equal((await a.request("GET", `/feedback?clientId=${b.clientId}`)).status, 403);
    assert.equal((await a.request("PATCH", `/feedback/${foreign.data.id}`, { status: "resolved" })).status, 404);
    assert.equal((await a.request("PATCH", `/feedback/${foreign.data.id}?clientId=${b.clientId}`,
      { internalNote: "Unauthorised change" })).status, 403);
    const foreignList = await b.request("GET", "/feedback");
    assert.equal(foreignList.data.length, 1);
    assert.equal(foreignList.data[0].status, "new");
    assert.equal(foreignList.data[0].internalNote, "");
  });

  await t.test("linked consultant clients remain separate inboxes even when both are authorised", async () => {
    const linked = await a.request("POST", "/clients", { name: "Feedback Linked Client", slug: `feedback-linked-${stamp}` });
    assert.equal(linked.status, 201);
    const clientId = linked.data.id;
    const linkedPath = `/feedback?clientId=${clientId}`;
    assert.deepEqual((await a.request("GET", linkedPath)).data, []);
    const submitted = await a.request("POST", linkedPath, {
      category: "feature", summary: "Linked client feedback", details: "Only the selected linked client should see this report.",
    });
    assert.equal(submitted.status, 201);
    assert.equal((await a.request("PATCH", `/feedback/${reports[0]}?clientId=${clientId}`, { status: "resolved" })).status, 404);
    assert.equal((await a.request("PATCH", `/feedback/${submitted.data.id}?clientId=${clientId}`, { status: "reviewing" })).status, 200);
    assert.deepEqual((await a.request("GET", linkedPath)).data.map(row => row.id), [submitted.data.id]);
    assert.ok(!(await a.request("GET", "/feedback")).data.some(row => row.id === submitted.data.id));
  });

  await t.test("client administrators can triage; staff and viewers can submit but cannot read internal notes", async () => {
    for (const role of ["client_admin", "client_staff", "client_viewer"]) {
      const email = `feedback-${role}-${stamp}@test.local`;
      const created = await a.request("POST", "/users", { name: `Feedback ${role}`, email, password, role, clientId: a.clientId });
      assert.equal(created.status, 201);
      const request = session();
      assert.equal((await request("POST", "/auth/login", { email, password })).status, 200);
      const allowed = role === "client_admin";
      assert.equal((await request("GET", "/feedback")).status, allowed ? 200 : 403);
      const updated = await request("PATCH", `/feedback/${reports[0]}`, { status: "resolved", internalNote: "Manager-only response." });
      assert.equal(updated.status, allowed ? 200 : 403);
      if (allowed) assert.equal(updated.data.updatedBy, created.data.id);
      assert.equal((await request("POST", "/feedback", {
        category: "feedback", summary: `${role} submission`, details: "All authenticated roles can continue submitting feedback.",
      })).status, 201);
      assert.equal((await request("GET", `/feedback?clientId=${b.clientId}`)).status, 403);
    }
    const reloaded = (await a.request("GET", "/feedback")).data.find(row => row.id === reports[0]);
    assert.equal(reloaded.internalNote, "Manager-only response.");
  });
});