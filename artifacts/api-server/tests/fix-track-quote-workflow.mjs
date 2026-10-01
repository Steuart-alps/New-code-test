import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  db, sql, pool, createTenant, createUser, requestSession,
  readOutbox, clearOutbox, isoDay,
} from "./approval-workflow-fixtures.mjs";

after(() => pool.end());

test("public quote submission and manager decisions exercise the real approval queue", async t => {
  const owner = await createTenant("quote-owner");
  const foreign = await createTenant("quote-foreign");
  const department = await owner.request("POST", "/departments", { name: "Quote Alpha" });
  const otherDepartment = await owner.request("POST", "/departments", { name: "Quote Beta" });
  assert.equal(department.status, 201);
  assert.equal(otherDepartment.status, 201);
  const departmentId = department.data.id;
  const otherDepartmentId = otherDepartment.data.id;
  const site = await owner.request("POST", "/sites", {
    name: "Quote Alpha site", departmentId, seedStarterChecks: false,
  });
  assert.equal(site.status, 201);
  const manager = await createUser(owner, {
    role: "client_staff", departmentId, isMaintenanceManager: true,
  });
  const otherManager = await createUser(owner, {
    role: "client_staff", departmentId: otherDepartmentId, isMaintenanceManager: true,
  });
  const staff = await createUser(owner, { role: "client_staff", departmentId });
  const viewer = await createUser(owner, { role: "client_viewer", departmentId });
  const anonymous = requestSession();
  await clearOutbox();

  async function pendingQuote(label) {
    const contractor = await owner.request("POST", "/contractors", {
      name: `Quote contractor ${label}`, email: `quote-${label}@test.local`,
    });
    assert.equal(contractor.status, 201);
    const issue = await owner.request("POST", "/fix-track/issues", {
      title: `Quoted work ${label}`, issueType: "general", location: "Plant room",
      reportedBy: "Facilities", reportedDate: isoDay(), siteId: site.data.id,
      contractorId: contractor.data.id,
    });
    assert.equal(issue.status, 201, JSON.stringify(issue.data));
    const requested = await owner.request("POST", `/fix-track/issues/${issue.data.id}/request-send`, { mode: "quote" });
    assert.equal(requested.status, 200, JSON.stringify(requested.data));
    const list = await manager.request("GET", "/fix-track/contractor-email-queue");
    assert.equal(list.status, 200);
    const queue = list.data.find(row => row.entityId === issue.data.id);
    assert.ok(queue);
    const token = queue.emailPreviewJson.html.match(/\/contractor-quote\/([a-f0-9]{64})/)?.[1];
    assert.ok(token, "the authorised preview hydrates the original quote link");
    return { queue, token, issueId: issue.data.id, contractorId: contractor.data.id, title: issue.data.title };
  }
  async function submissions(fixture) {
    return (await db.execute(sql`
      SELECT id, status, price_pence, notes FROM fix_track_quote_submissions
      WHERE queue_id=${fixture.queue.id} AND client_id=${owner.clientId}
    `)).rows;
  }
  async function assignmentDrafts(fixture) {
    return (await db.execute(sql`
      SELECT id, status, department_id, requested_by, approved_by FROM contractor_email_queue
      WHERE client_id=${owner.clientId} AND issue_id=${fixture.issueId} AND email_type='assignment'
    `)).rows;
  }

  const quote = await pendingQuote("accept");
  await t.test("staff, viewers, other departments and foreign tenants cannot read or change a draft", async () => {
    for (const denied of [staff, viewer]) {
      assert.equal((await denied.request("GET", "/fix-track/contractor-email-queue")).status, 403);
      for (const action of ["approve-and-send", "edit-and-send", "cancel"]) {
        assert.equal((await denied.request("POST", `/fix-track/contractor-email-queue/${quote.queue.id}/${action}`,
          action === "edit-and-send" ? { subject: "Forbidden edit", bodyText: "Forbidden body" } : undefined)).status, 403);
      }
      assert.equal((await denied.request("PUT", `/fix-track/contractor-email-queue/${quote.queue.id}`, {
        subject: "Forbidden edit", bodyHtml: "<p>Forbidden body</p>",
      })).status, 403);
    }
    for (const denied of [foreign, otherManager]) {
      const list = await denied.request("GET", "/fix-track/contractor-email-queue");
      assert.equal(list.status, 200);
      assert.ok(!list.data.some(row => row.id === quote.queue.id));
      assert.equal((await denied.request("PUT", `/fix-track/contractor-email-queue/${quote.queue.id}`, {
        subject: "Forbidden edit", bodyHtml: "<p>Forbidden body</p>",
      })).status, 404);
      assert.equal((await denied.request("POST", `/fix-track/contractor-email-queue/${quote.queue.id}/cancel`)).status, 404);
      assert.equal((await denied.request("POST", `/fix-track/contractor-email-queue/${quote.queue.id}/approve-and-send`)).status, 409);
      assert.equal((await denied.request("POST", `/fix-track/contractor-email-queue/${quote.queue.id}/edit-and-send`, {
        subject: "Forbidden edit", bodyText: "Forbidden body",
      })).status, 409);
    }
    const state = (await db.execute(sql`
      SELECT status, subject FROM contractor_email_queue WHERE id=${quote.queue.id}
    `)).rows[0];
    assert.equal(state.status, "pending");
    assert.equal(state.subject, quote.queue.emailPreviewJson.subject);
    assert.equal((await readOutbox()).length, 0);
  });

  await t.test("an edited quote preview dispatches exactly once and retains the working submission link", async () => {
    const edited = {
      subject: "Reviewed quote request: exact preview",
      bodyHtml: `<p>Reviewed scope &amp; access requirements.</p>${quote.queue.emailPreviewJson.html}`,
      bodyText: `Reviewed scope & access requirements.\nSubmit at /contractor-quote/${quote.token}`,
    };
    assert.equal((await manager.request("PUT", `/fix-track/contractor-email-queue/${quote.queue.id}`, edited)).status, 200);
    const updatedList = await manager.request("GET", "/fix-track/contractor-email-queue");
    const preview = updatedList.data.find(row => row.id === quote.queue.id).emailPreviewJson;
    assert.deepEqual(preview, { subject: edited.subject, html: edited.bodyHtml, text: edited.bodyText });
    const sends = await Promise.all([
      manager.request("POST", `/fix-track/contractor-email-queue/${quote.queue.id}/approve-and-send`),
      manager.request("POST", `/fix-track/contractor-email-queue/${quote.queue.id}/approve-and-send`),
    ]);
    assert.deepEqual(sends.map(result => result.status).sort(), [200, 409]);
    const outbox = await readOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].subject, preview.subject);
    assert.equal(outbox[0].html, preview.html);
    assert.equal(outbox[0].text, preview.text);
    assert.ok(outbox[0].html.includes(`/contractor-quote/${quote.token}`));
    const state = (await db.execute(sql`
      SELECT status, approved_by, sent_by, sent_at FROM contractor_email_queue WHERE id=${quote.queue.id}
    `)).rows[0];
    assert.equal(state.status, "sent");
    assert.equal(state.approved_by, manager.userId);
    assert.equal(state.sent_by, manager.userId);
    assert.ok(state.sent_at);
    const publicJob = await anonymous("GET", `/fix-track/quotes/public/${quote.token}`);
    assert.equal(publicJob.status, 200);
    assert.equal(publicJob.data.job.title, quote.title);
    assert.equal(publicJob.data.submitted, false);
  });

  await t.test("anonymous duplicate submissions create one quote and preserve the original submitted evidence", async () => {
    assert.equal((await anonymous("GET", `/fix-track/quotes/public/${"f".repeat(64)}`)).status, 404);
    assert.equal((await anonymous("POST", `/fix-track/quotes/public/${quote.token}`, { poundsPrice: -1 })).status, 400);
    assert.equal((await anonymous("POST", `/fix-track/quotes/public/${quote.token}`, { poundsPrice: "invalid" })).status, 400);
    const body = { poundsPrice: 1250.75, notes: "Original contractor estimate <not editable by reviewers>." };
    const attempts = await Promise.all([
      anonymous("POST", `/fix-track/quotes/public/${quote.token}`, body),
      anonymous("POST", `/fix-track/quotes/public/${quote.token}`, body),
    ]);
    assert.deepEqual(attempts.map(result => result.status).sort(), [201, 409]);
    const rows = await submissions(quote);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].price_pence, 125075);
    assert.equal(rows[0].notes, body.notes);
    assert.equal(rows[0].status, "submitted");
    const repeated = await anonymous("POST", `/fix-track/quotes/public/${quote.token}`, {
      poundsPrice: 1, notes: "Attempt to replace the estimate",
    });
    assert.equal(repeated.status, 409);
    assert.deepEqual(await submissions(quote), rows);
    assert.equal((await anonymous("GET", `/fix-track/quotes/public/${quote.token}`)).data.submitted, true,
      "a used link shows a receipt, not another usable quote form");
    const notices = (await db.execute(sql`
      SELECT id FROM fix_track_manager_notifications
      WHERE issue_id=${quote.issueId} AND kind='quote_submitted'
    `)).rows;
    assert.equal(notices.length, 1, "duplicate submission does not duplicate the manager notification");
  });

  await t.test("acceptance is manager-scoped and duplicate requests queue exactly one reviewed assignment", async () => {
    const quoteId = (await submissions(quote))[0].id;
    for (const denied of [staff, viewer]) {
      assert.equal((await denied.request("POST", `/fix-track/quotes/${quoteId}/accept`)).status, 403);
      assert.equal((await denied.request("POST", `/fix-track/quotes/${quoteId}/decline`)).status, 403);
    }
    for (const denied of [foreign, otherManager]) {
      assert.equal((await denied.request("POST", `/fix-track/quotes/${quoteId}/accept`)).status, 404);
      assert.equal((await denied.request("POST", `/fix-track/quotes/${quoteId}/decline`)).status, 404);
    }
    assert.equal((await assignmentDrafts(quote)).length, 0);
    const before = (await readOutbox()).length;
    const accepted = await Promise.all([
      manager.request("POST", `/fix-track/quotes/${quoteId}/accept`),
      manager.request("POST", `/fix-track/quotes/${quoteId}/accept`),
    ]);
    assert.deepEqual(accepted.map(result => result.status).sort(), [200, 404]);
    assert.equal(accepted.find(result => result.status === 200).data.assignmentQueued, true);
    const drafts = await assignmentDrafts(quote);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].status, "pending", "accepting still requires a separate dispatch review");
    assert.equal(drafts[0].department_id, departmentId);
    assert.equal(drafts[0].requested_by, manager.userId);
    assert.equal(drafts[0].approved_by, null);
    assert.equal((await readOutbox()).length, before, "acceptance never sends without draft approval");
    assert.equal((await submissions(quote))[0].status, "accepted");
    const issue = await owner.request("GET", `/fix-track/issues/${quote.issueId}`);
    assert.equal(issue.data.emailRequestMode, "assign");
    assert.equal(issue.data.emailRequestStatus, "pending");
    assert.equal((await manager.request("POST", `/fix-track/quotes/${quoteId}/decline`)).status, 404);
  });

  await t.test("declining a quote is final and queues no assignment", async () => {
    const rejected = await pendingQuote("decline");
    const sent = await manager.request("POST", `/fix-track/contractor-email-queue/${rejected.queue.id}/edit-and-send`, {
      subject: "Edited quote request", bodyText: "Please quote for the reviewed scope & access.\nNo work is assigned.",
    });
    assert.equal(sent.status, 200);
    const delivered = (await readOutbox()).at(-1);
    assert.equal(delivered.subject, sent.data.subject);
    assert.equal(delivered.text, sent.data.bodyText);
    assert.equal(delivered.html, sent.data.bodyHtml);
    assert.ok(delivered.html.includes(`/contractor-quote/${rejected.token}`));
    assert.equal((await anonymous("POST", `/fix-track/quotes/public/${rejected.token}`, { poundsPrice: 99.99 })).status, 201);
    const quoteId = (await submissions(rejected))[0].id;
    assert.equal((await manager.request("POST", `/fix-track/quotes/${quoteId}/decline`)).status, 200);
    assert.equal((await submissions(rejected))[0].status, "declined");
    assert.equal((await assignmentDrafts(rejected)).length, 0);
    assert.equal((await manager.request("POST", `/fix-track/quotes/${quoteId}/accept`)).status, 404);
    assert.equal((await manager.request("POST", `/fix-track/quotes/${quoteId}/decline`)).status, 404);
  });

  await t.test("expired quote links cannot open or submit and create no evidence", async () => {
    const expired = await pendingQuote("expiry");
    assert.equal((await manager.request("POST", `/fix-track/contractor-email-queue/${expired.queue.id}/approve-and-send`)).status, 200);
    await db.execute(sql`
      UPDATE contractor_email_queue SET quote_token_expires_at=now()-interval '1 minute'
      WHERE id=${expired.queue.id} AND client_id=${owner.clientId}
    `);
    assert.equal((await anonymous("GET", `/fix-track/quotes/public/${expired.token}`)).status, 404);
    assert.equal((await anonymous("POST", `/fix-track/quotes/public/${expired.token}`, { poundsPrice: 5 })).status, 404);
    assert.equal((await submissions(expired)).length, 0);
  });
});