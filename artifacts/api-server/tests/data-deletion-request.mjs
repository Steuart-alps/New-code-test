import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const base = process.env.API_BASE;
const emails = process.env.TEST_EMAIL_CAPTURE_PATH;
if (!base || !emails) throw new Error("Test API and email capture path required");
const tag = `erasure-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const accounts = [];

function session() {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.headers.get("set-cookie")) cookie = res.headers.get("set-cookie").split(";")[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}

async function register(label) {
  const request = session();
  const email = `${tag}-${label}@test.local`;
  const created = await request("POST", "/auth/register", { name: label, email, password: "password-123" });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created));
  if (created.data.verificationToken) {
    assert.equal((await request("GET", `/auth/verify-email?token=${created.data.verificationToken}`)).status, 200);
    assert.equal((await request("POST", "/auth/login", { email, password: "password-123" })).status, 200);
  }
  const me = await request("GET", "/auth/me");
  assert.equal(me.status, 200);
  const user = me.data.user ?? me.data;
  accounts.push({ userId: user.id, clientId: user.clientId });
  return { request, userId: user.id, clientId: user.clientId };
}

try {
  const first = await register("First");
  const second = await register("Second");
  const initial = await first.request("GET", `/data-deletion/request?clientId=${first.clientId}`);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.eligible, true, "consultants may request for their linked client");
  assert.equal(initial.data.request, null);
  const denied = await first.request("POST", "/data-deletion/request", { clientId: second.clientId });
  assert.equal(denied.status, 403, "consultants cannot request for unrelated tenants");

  const created = await first.request("POST", "/data-deletion/request", { clientId: first.clientId });
  assert.equal(created.status, 200, JSON.stringify(created));
  assert.equal(created.data.notificationPending, false);
  const requestId = created.data.request.id;
  const earliest = new Date(created.data.request.earliestDeletionAt).getTime();
  assert.ok(earliest - Date.now() > 29 * 86_400_000 && earliest - Date.now() < 31 * 86_400_000);
  const again = await first.request("POST", "/data-deletion/request", { clientId: first.clientId });
  assert.equal(again.status, 200);
  assert.equal(again.data.request.id, requestId);
  assert.equal(again.data.request.earliestDeletionAt, created.data.request.earliestDeletionAt);
  const mail = (await readFile(emails, "utf8")).trim().split("\n").map(JSON.parse)
    .filter(message => message.subject?.startsWith("Data deletion requested:"));
  assert.equal(mail.length, 1, "repeated submission must not email twice");
  assert.match(mail[0].text, new RegExp(`ID ${first.clientId}`));
  assert.match(mail[0].text, /requested permanent data deletion on/);
  const panel = await first.request("GET", "/admin/data-deletion-requests");
  assert.equal(panel.status, 200);
  assert.ok(panel.data.some(row => row.id === requestId));
  assert.equal(
    (await first.request("DELETE", `/clients/${first.clientId}`)).status, 409,
    "manual client deletion must not bypass a pending review",
  );
  const otherPanel = await second.request("GET", "/admin/data-deletion-requests");
  assert.equal(otherPanel.status, 200);
  assert.ok(!otherPanel.data.some(row => row.id === requestId));
  assert.equal((await second.request("PATCH", `/admin/data-deletion-requests/${requestId}/review`, {
    decision: "approved", note: "Reviewed client request and retention obligations",
  })).status, 404);
  assert.equal((await first.request("PATCH", `/admin/data-deletion-requests/${requestId}/review`, {
    decision: "approved", note: "Self approval must not be allowed",
  })).status, 404);
  await db.execute(sql`
    INSERT INTO consultant_clients (user_id, client_id)
    VALUES (${second.userId}, ${first.clientId})
  `);
  const reviewed = await second.request("PATCH", `/admin/data-deletion-requests/${requestId}/review`, {
    decision: "approved", note: "Reviewed client request and retention obligations",
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed));
  assert.equal(reviewed.data.status, "approved");
  assert.equal((await first.request("GET", `/data-deletion/request?clientId=${first.clientId}`)).data.request.status, "approved");
  assert.equal((await first.request("POST", "/data-deletion/request", { clientId: first.clientId })).data.request.id, requestId);
  assert.equal((await first.request("DELETE", `/clients/${first.clientId}`)).status, 409, "approval does not shorten the 30-day window");

  await db.execute(sql`UPDATE users SET role = 'client_admin' WHERE id = ${second.userId}`);
  const beforeCancellation = await second.request("GET", `/data-deletion/request?clientId=${second.clientId}`);
  assert.equal(beforeCancellation.data.eligible, false);
  assert.equal((await second.request("POST", "/data-deletion/request", { clientId: second.clientId })).status, 403);
  await db.execute(sql`UPDATE clients SET cancelled_at = now() WHERE id = ${second.clientId}`);
  const afterCancellation = await second.request("GET", `/data-deletion/request?clientId=${second.clientId}`);
  assert.equal(afterCancellation.data.eligible, true);
  const secondRequest = await second.request("POST", "/data-deletion/request", { clientId: second.clientId });
  assert.equal(secondRequest.status, 200);
  await db.execute(sql`
    INSERT INTO privacy_retention_schedules (client_id, record_category, scope_description,
      retention_period, retention_trigger, justification, legal_hold_active)
    VALUES (${second.clientId}, 'legal', 'Test hold', 'until cleared', 'review', 'Test', true)
  `);
  assert.equal((await first.request("PATCH", `/admin/data-deletion-requests/${secondRequest.data.request.id}/review`, {
    decision: "approved", note: "Reviewed client request and retention obligations",
  })).status, 404);
  await db.execute(sql`
    INSERT INTO consultant_clients (user_id, client_id)
    VALUES (${first.userId}, ${second.clientId})
  `);
  assert.equal((await first.request("PATCH", `/admin/data-deletion-requests/${secondRequest.data.request.id}/review`, {
    decision: "approved", note: "Reviewed client request and retention obligations",
  })).status, 409, "legal holds prevent approval");
  await db.execute(sql`DELETE FROM privacy_retention_schedules WHERE client_id = ${second.clientId}`);
  assert.equal((await first.request("PATCH", `/admin/data-deletion-requests/${secondRequest.data.request.id}/review`, {
    decision: "refused", note: "Records must be retained under another obligation",
  })).status, 200);
  assert.equal((await second.request("GET", `/data-deletion/request?clientId=${second.clientId}`)).data.request, null);
  await db.execute(sql`UPDATE users SET role = 'client_staff' WHERE id = ${second.userId}`);
  assert.equal((await second.request("POST", "/data-deletion/request", { clientId: second.clientId })).status, 403);
  assert.equal((await second.request("GET", "/admin/data-deletion-requests")).status, 403);

  // Model the worker owning this client's lock and finishing deletion while
  // a request waits. The POST must recheck deletion state after acquiring it.
  const racing = await register("Race");
  let delayedPost;
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(106, ${racing.clientId})`);
    delayedPost = racing.request("POST", "/data-deletion/request", { clientId: racing.clientId });
    await new Promise(resolve => setTimeout(resolve, 150));
    await tx.execute(sql`UPDATE clients SET data_deleted_at = now() WHERE id = ${racing.clientId}`);
  });
  const lostRace = await delayedPost;
  assert.equal(lostRace.status, 409, JSON.stringify(lostRace));
  const notRecorded = await db.execute(sql`SELECT id FROM client_data_deletion_requests WHERE client_id = ${racing.clientId}`);
  assert.equal(notRecorded.rows.length, 0, "request must not be accepted during completed deletion");
  console.log("Data deletion request checks passed.");
} finally {
  for (const account of accounts) {
    await db.execute(sql`DELETE FROM privacy_retention_schedules WHERE client_id = ${account.clientId}`);
    await db.execute(sql`DELETE FROM client_data_deletion_requests WHERE client_id = ${account.clientId}`);
    await db.execute(sql`DELETE FROM consultant_clients WHERE client_id = ${account.clientId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${account.userId}`);
    await db.execute(sql`DELETE FROM clients WHERE id = ${account.clientId}`);
  }
}