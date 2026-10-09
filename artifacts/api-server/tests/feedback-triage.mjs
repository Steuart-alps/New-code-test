import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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

// SQL against the harness's disposable database only (never the app database).
async function psql(statement) {
  const { stdout } = await execFile("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", statement]);
  return stdout.trim();
}

// Current revision of a report as the given manager sees it (optionally in a selected client).
async function revisionOf(request, id, query = "") {
  const list = await request("GET", `/feedback${query}`);
  assert.equal(list.status, 200);
  const row = list.data.find(item => item.id === id);
  assert.ok(row, `report ${id} is visible`);
  return row.revision;
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
      assert.equal(row.updatedByName, null);
      assert.equal(row.revision, 0);
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
      expectedRevision: 0, status: "reviewing", internalNote: "Investigating with the team.",
    });
    assert.equal(review.status, 200);
    assert.equal(review.data.status, "reviewing");
    assert.equal(review.data.revision, 1);
    assert.equal(review.data.updatedBy, a.userId);
    assert.equal(review.data.updatedByName, "Feedback A");
    assert.ok(review.data.updatedAt);
    assert.equal(review.data.summary, "bug report from A");
    assert.equal(review.data.details, "Detailed fixture feedback for manager review.");
    assert.equal(review.data.internalNote, "Investigating with the team.");
    const reviewing = await a.request("GET", "/feedback?category=bug&status=reviewing");
    assert.deepEqual(reviewing.data.map(row => row.id), [reports[0]]);
    const resolve = await a.request("PATCH", `/feedback/${reports[0]}`, { expectedRevision: 1, status: "resolved" });
    assert.equal(resolve.status, 200);
    assert.equal(resolve.data.revision, 2);
    assert.equal(resolve.data.internalNote, "Investigating with the team.", "omitted note is preserved");
    const cleared = await a.request("PATCH", `/feedback/${reports[0]}`, { expectedRevision: 2, internalNote: "" });
    assert.equal(cleared.data.revision, 3);
    assert.equal(cleared.data.status, "resolved", "omitted status is preserved");
    assert.equal(cleared.data.internalNote, "", "explicit empty note clears it");
    const resolved = await a.request("GET", "/feedback?status=resolved");
    assert.deepEqual(resolved.data.map(row => row.id), [reports[0]]);
    assert.equal(resolved.data[0].internalNote, "");
    const reopened = await a.request("PATCH", `/feedback/${reports[0]}`, { expectedRevision: 3, status: "new" });
    assert.equal(reopened.data.status, "new");
    assert.equal(reopened.data.revision, 4);
    const unchanged = await a.request("PATCH", `/feedback/${reports[0]}`, { expectedRevision: 4, status: "new" });
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.data.revision, 4, "re-saving identical values does not create a revision");
  });

  await t.test("interleaved manager saves: the stale draft gets 409 with the latest version and nothing is overwritten", async () => {
    const email = `feedback-second-manager-${stamp}@test.local`;
    const created = await a.request("POST", "/users", { name: "Feedback Second Manager", email, password, role: "client_admin", clientId: a.clientId });
    assert.equal(created.status, 201);
    const second = session();
    assert.equal((await second("POST", "/auth/login", { email, password })).status, 200);
    const id = reports[1];
    // Both managers open the same report at revision 0.
    const firstSeen = await revisionOf(a.request, id);
    const secondSeen = await revisionOf(second, id);
    assert.equal(firstSeen, 0);
    assert.equal(secondSeen, 0);
    const firstSave = await a.request("PATCH", `/feedback/${id}`, {
      expectedRevision: firstSeen, status: "reviewing", internalNote: "First manager: scoping the feature.",
    });
    assert.equal(firstSave.status, 200);
    assert.equal(firstSave.data.revision, 1);
    const stale = await second("PATCH", `/feedback/${id}`, {
      expectedRevision: secondSeen, status: "resolved", internalNote: "Second manager: closing as done.",
    });
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /Another manager saved this report/);
    assert.equal(stale.data.report.id, id);
    assert.equal(stale.data.report.revision, 1);
    assert.equal(stale.data.report.status, "reviewing");
    assert.equal(stale.data.report.internalNote, "First manager: scoping the feature.");
    assert.equal(stale.data.report.updatedByName, "Feedback A");
    const afterConflict = (await a.request("GET", "/feedback")).data.find(row => row.id === id);
    assert.equal(afterConflict.internalNote, "First manager: scoping the feature.", "the stale write did not win");
    assert.equal(afterConflict.revision, 1);
    // The second manager deliberately saves on top of the version they compared.
    const rebased = await second("PATCH", `/feedback/${id}`, {
      expectedRevision: stale.data.report.revision, status: "resolved", internalNote: "Second manager: closing as done.",
    });
    assert.equal(rebased.status, 200);
    assert.equal(rebased.data.revision, 2);
    assert.equal(rebased.data.updatedBy, created.data.id);
    // The first manager's now-stale follow-up is rejected in turn.
    assert.equal((await a.request("PATCH", `/feedback/${id}`, { expectedRevision: 1, internalNote: "Late edit" })).status, 409);

    // Truly concurrent saves from the same revision: exactly one is accepted.
    const racers = await Promise.all([
      a.request("PATCH", `/feedback/${id}`, { expectedRevision: 2, internalNote: "Race: first manager" }),
      second("PATCH", `/feedback/${id}`, { expectedRevision: 2, internalNote: "Race: second manager" }),
    ]);
    assert.deepEqual(racers.map(r => r.status).sort(), [200, 409]);
    const winner = racers.find(r => r.status === 200).data;
    const final = (await a.request("GET", "/feedback")).data.find(row => row.id === id);
    assert.equal(final.revision, 3);
    assert.equal(final.internalNote, winner.internalNote);
    const history = await a.request("GET", `/feedback/${id}/history`);
    assert.deepEqual(history.data.map(entry => entry.revision), [3, 2, 1], "rejected writes leave no history");
    assert.deepEqual(history.data.map(entry => entry.actorId).slice(1), [created.data.id, a.userId]);
  });

  await t.test("review history is append-only, newest first, attributed and records each accepted change", async () => {
    const history = await a.request("GET", `/feedback/${reports[0]}/history`);
    assert.equal(history.status, 200);
    assert.deepEqual(history.data.map(entry => entry.revision), [4, 3, 2, 1]);
    assert.deepEqual(history.data.map(entry => [entry.previousStatus, entry.status]).reverse(), [
      ["new", "reviewing"], ["reviewing", "resolved"], ["resolved", "resolved"], ["resolved", "new"],
    ]);
    assert.deepEqual(history.data.map(entry => entry.internalNote).reverse(), [
      "Investigating with the team.", "Investigating with the team.", "", "",
    ]);
    assert.equal(history.data.at(-1).previousInternalNote, "");
    assert.equal(history.data[1].previousInternalNote, "Investigating with the team.", "the cleared note stays in history");
    for (const entry of history.data) {
      assert.equal(entry.reportId, reports[0]);
      assert.equal(entry.actorId, a.userId);
      assert.equal(entry.actorName, "Feedback A");
      assert.ok(Date.parse(entry.createdAt));
    }
    const timestamps = history.data.map(entry => Date.parse(entry.createdAt));
    assert.deepEqual([...timestamps].sort((x, y) => y - x), timestamps);
    assert.deepEqual((await a.request("GET", `/feedback/${reports[2]}/history`)).data, []);
    assert.equal((await a.request("GET", "/feedback/not-an-id/history")).status, 400);
    assert.equal((await a.request("GET", "/feedback/2147483647/history")).status, 404);
    // The database refuses edits and direct deletes of history rows, and cross-tenant rows.
    await assert.rejects(psql(`UPDATE feedback_report_reviews SET internal_note = 'rewritten' WHERE report_id = ${Number(reports[0])}`), /append-only/);
    await assert.rejects(psql(`DELETE FROM feedback_report_reviews WHERE report_id = ${Number(reports[0])}`), /append-only/);
    await assert.rejects(psql(`INSERT INTO feedback_report_reviews (report_id, client_id, revision, previous_status, status, previous_internal_note, internal_note)
      VALUES (${Number(reports[0])}, ${Number(b.clientId)}, 99, 'new', 'new', '', '')`), /tenant must match/);
    assert.equal((await a.request("GET", `/feedback/${reports[0]}/history`)).data.length, 4);
    // Submitted evidence is never touched by triage.
    const report = (await a.request("GET", "/feedback")).data.find(row => row.id === reports[0]);
    assert.equal(report.summary, "bug report from A");
    assert.equal(report.details, "Detailed fixture feedback for manager review.");
  });

  await t.test("a failed history write rolls back the report update", async () => {
    const id = reports[2];
    const before = (await a.request("GET", "/feedback")).data.find(row => row.id === id);
    // Fault injection in the disposable database: make this report's history insert fail.
    await psql(`CREATE OR REPLACE FUNCTION feedback_test_fail_history() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN IF NEW.report_id = ${Number(id)} THEN RAISE EXCEPTION 'injected history failure'; END IF; RETURN NEW; END; $fn$`);
    await psql(`CREATE TRIGGER feedback_test_fail_history BEFORE INSERT ON feedback_report_reviews
      FOR EACH ROW EXECUTE FUNCTION feedback_test_fail_history()`);
    try {
      const failed = await a.request("PATCH", `/feedback/${id}`, {
        expectedRevision: before.revision, status: "resolved", internalNote: "Must not persist without history.",
      });
      assert.equal(failed.status, 500);
    } finally {
      await psql("DROP TRIGGER IF EXISTS feedback_test_fail_history ON feedback_report_reviews");
      await psql("DROP FUNCTION IF EXISTS feedback_test_fail_history()");
    }
    const after = (await a.request("GET", "/feedback")).data.find(row => row.id === id);
    assert.deepEqual(after, before, "status, note, editor and revision are unchanged");
    assert.deepEqual((await a.request("GET", `/feedback/${id}/history`)).data, []);
    const retried = await a.request("PATCH", `/feedback/${id}`, {
      expectedRevision: before.revision, status: "resolved", internalNote: "Persisted with history.",
    });
    assert.equal(retried.status, 200, "the same draft saves once the fault is cleared");
    assert.deepEqual((await a.request("GET", `/feedback/${id}/history`)).data.map(entry => entry.internalNote), ["Persisted with history."]);
  });

  await t.test("invalid or ownership-changing updates do not mutate a report", async () => {
    const before = (await a.request("GET", "/feedback")).data;
    const historyBefore = (await a.request("GET", `/feedback/${reports[0]}/history`)).data;
    const expectedRevision = before.find(row => row.id === reports[0]).revision;
    for (const body of [{ expectedRevision }, { expectedRevision, status: "closed" }, { expectedRevision, internalNote: null },
      { expectedRevision, internalNote: "x".repeat(5001) }, { status: "resolved" }, { expectedRevision: -1, status: "resolved" },
      { expectedRevision: 1.5, status: "resolved" }, { expectedRevision: "4", status: "resolved" },
      { expectedRevision, status: "resolved", clientId: b.clientId }, { expectedRevision, userId: b.userId },
      { expectedRevision, summary: "Changed evidence" }, { expectedRevision, revision: 99, status: "resolved" }]) {
      assert.equal((await a.request("PATCH", `/feedback/${reports[0]}`, body)).status,
        body.clientId ? 403 : 400, "the tenant middleware rejects spoofed client IDs before body validation");
    }
    assert.equal((await a.request("PATCH", "/feedback/not-an-id", { expectedRevision: 0, status: "resolved" })).status, 400);
    assert.equal((await a.request("PATCH", "/feedback/2147483647", { expectedRevision: 0, status: "resolved" })).status, 404);
    assert.deepEqual((await a.request("GET", "/feedback")).data, before);
    assert.deepEqual((await a.request("GET", `/feedback/${reports[0]}/history`)).data, historyBefore);
  });

  await t.test("foreign IDs and selected-client spoofing cannot read or update another tenant", async () => {
    assert.equal((await a.request("GET", `/feedback?clientId=${b.clientId}`)).status, 403);
    assert.equal((await a.request("PATCH", `/feedback/${foreign.data.id}`, { expectedRevision: 0, status: "resolved" })).status, 404);
    assert.equal((await a.request("PATCH", `/feedback/${foreign.data.id}?clientId=${b.clientId}`,
      { expectedRevision: 0, internalNote: "Unauthorised change" })).status, 403);
    const untouched = await b.request("GET", "/feedback");
    assert.equal(untouched.data[0].internalNote, "");
    assert.equal(untouched.data[0].revision, 0);
    // B records history of its own; A can read it neither by ID nor by spoofing the selected client.
    const foreignSave = await b.request("PATCH", `/feedback/${foreign.data.id}`, { expectedRevision: 0, internalNote: "B's private triage note." });
    assert.equal(foreignSave.status, 200);
    assert.equal((await a.request("GET", `/feedback/${foreign.data.id}/history`)).status, 404);
    assert.equal((await a.request("GET", `/feedback/${foreign.data.id}/history?clientId=${b.clientId}`)).status, 403);
    assert.equal((await b.request("GET", `/feedback/${reports[0]}/history`)).status, 404);
    const foreignHistory = await b.request("GET", `/feedback/${foreign.data.id}/history`);
    assert.deepEqual(foreignHistory.data.map(entry => [entry.actorId, entry.internalNote]), [[b.userId, "B's private triage note."]]);
    const foreignList = await b.request("GET", "/feedback");
    assert.equal(foreignList.data.length, 1);
    assert.equal(foreignList.data[0].status, "new");
    assert.equal(foreignList.data[0].revision, 1);
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
    assert.equal((await a.request("PATCH", `/feedback/${reports[0]}?clientId=${clientId}`, { expectedRevision: 0, status: "resolved" })).status, 404);
    assert.equal((await a.request("GET", `/feedback/${reports[0]}/history?clientId=${clientId}`)).status, 404);
    assert.equal((await a.request("PATCH", `/feedback/${submitted.data.id}?clientId=${clientId}`, { expectedRevision: 0, status: "reviewing" })).status, 200);
    const linkedHistory = await a.request("GET", `/feedback/${submitted.data.id}/history?clientId=${clientId}`);
    assert.deepEqual(linkedHistory.data.map(entry => entry.status), ["reviewing"]);
    assert.equal((await a.request("GET", `/feedback/${submitted.data.id}/history`)).status, 404, "history follows the selected client");
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
      assert.equal((await request("GET", `/feedback/${reports[0]}/history`)).status, allowed ? 200 : 403,
        "historical notes are internal to administrators");
      const expectedRevision = await revisionOf(a.request, reports[0]);
      const updated = await request("PATCH", `/feedback/${reports[0]}`, { expectedRevision, status: "resolved", internalNote: "Manager-only response." });
      assert.equal(updated.status, allowed ? 200 : 403);
      if (allowed) assert.equal(updated.data.updatedBy, created.data.id);
      assert.equal((await request("POST", "/feedback", {
        category: "feedback", summary: `${role} submission`, details: "All authenticated roles can continue submitting feedback.",
      })).status, 201);
      assert.equal((await request("GET", `/feedback?clientId=${b.clientId}`)).status, 403);
    }
    const reloaded = (await a.request("GET", "/feedback")).data.find(row => row.id === reports[0]);
    assert.equal(reloaded.internalNote, "Manager-only response.");
    const latest = (await a.request("GET", `/feedback/${reports[0]}/history`)).data[0];
    assert.equal(latest.actorName, "Feedback client_admin", "history attributes the second administrator");
    assert.equal(latest.status, "resolved");
  });

  await t.test("history follows report retention: actor removal anonymises, report deletion cascades", async () => {
    const c = await tenant("C");
    const submitted = await c.request("POST", "/feedback", {
      category: "bug", summary: "Retention fixture", details: "Report used to check history retention rules.",
    });
    assert.equal(submitted.status, 201);
    const id = Number(submitted.data.id);
    assert.equal((await c.request("PATCH", `/feedback/${id}`, { expectedRevision: 0, status: "resolved" })).status, 200);
    // The same row change the users FK performs (ON DELETE SET NULL) is permitted...
    await psql(`UPDATE feedback_report_reviews SET actor_id = NULL WHERE report_id = ${id}`);
    const anonymised = (await c.request("GET", `/feedback/${id}/history`)).data;
    assert.deepEqual(anonymised.map(entry => [entry.actorId, entry.actorName, entry.status]), [[null, null, "resolved"]]);
    // ...but nothing else may be rewritten alongside it.
    await assert.rejects(psql(`UPDATE feedback_report_reviews SET actor_id = NULL, status = 'new' WHERE report_id = ${id}`), /append-only/);
    // Deleting the report (as the client/report cascade does) removes its history with it.
    await psql(`DELETE FROM feedback_reports WHERE id = ${id}`);
    assert.equal(await psql(`SELECT count(*) FROM feedback_report_reviews WHERE report_id = ${id}`), "0");
  });
});