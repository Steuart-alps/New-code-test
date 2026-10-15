// Real-browser coverage of the contractor quote form and the manager approval
// inbox (contractor-quote.tsx, contractor-approvals.tsx, and the FixTrack quote
// actions that feed them).
//
// The real React app is served by Vite; its /api requests are forwarded to a
// private fresh-schema API with production CSRF and mandatory two-factor
// enrolment enforced. Contractor mail goes to the harness's captured outbox
// file and is never sent. Run with:
//   pnpm --filter @workspace/api-server run test:contractor-approval-inbox-browser
// (CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH selects the Chromium binary.)
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import {
  base as apiBase, db, sql, pool, runReminderJob, createTenant, createUser,
  readOutbox, clearOutbox, isoDay,
} from "../../api-server/tests/approval-workflow-fixtures.mjs";

if (process.env.FRESH_SCHEMA_BROWSER_POLICY !== "1") {
  throw new Error("Run through `pnpm --filter @workspace/api-server run test:contractor-approval-inbox-browser` "
    + "so the disposable API enforces CSRF and two-factor enrolment with captured mail.");
}

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const apiOrigin = new URL(apiBase).origin;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const outboxPath = process.env.FIXTRACK_TEST_EMAIL_OUTBOX;

async function freePort() {
  const server = createNetServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

let vite;
let viteCacheDir;
let browser;
let appOrigin;
const contexts = [];

before(async () => {
  const port = await freePort();
  appOrigin = `http://127.0.0.1:${port}`;
  // vite.config.ts requires PORT and BASE_PATH.
  process.env.PORT = String(port);
  process.env.BASE_PATH = "/";
  // The runner loader and a private cache dir keep the dev server from
  // writing temporary files into the workspace.
  viteCacheDir = await mkdtemp(path.join(tmpdir(), "approval-inbox-vite-"));
  vite = await createViteServer({
    configFile: path.join(appRoot, "vite.config.ts"),
    configLoader: "runner",
    cacheDir: viteCacheDir,
    logLevel: "error",
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  });
  await vite.listen();
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  browser = await chromium.launch({ headless: true, executablePath });
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close();
  await vite?.close();
  if (viteCacheDir) await rm(viteCacheDir, { recursive: true, force: true });
  await pool.end();
});

/**
 * A browser context whose /api traffic reaches the private API. The browser
 * sees one origin (as in production, where the API serves the web build); the
 * proxy only rewrites the app origin to the API origin so the server's real
 * same-origin + X-CSRF-Token check still applies. A fixture session (already
 * through two-factor enrolment) can be carried into the browser.
 */
async function browserContext(session) {
  const context = await browser.newContext();
  contexts.push(context);
  await context.route(`${appOrigin}/api/**`, async route => {
    const original = new URL(route.request().url());
    const headers = { ...route.request().headers() };
    if (headers.origin === appOrigin) headers.origin = apiOrigin;
    const response = await route.fetch({ url: `${apiOrigin}${original.pathname}${original.search}`, headers });
    await route.fulfill({ response });
  });
  if (session) {
    const cookie = session.request.cookie();
    const separator = cookie.indexOf("=");
    assert.ok(separator > 0, "fixture session must hold a session cookie");
    await context.addCookies([{
      name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: appOrigin,
    }]);
  }
  const page = await context.newPage();
  return { context, page };
}

async function withDiagnostics(page, label, run) {
  try {
    return await run();
  } catch (error) {
    const text = await page.locator("body").innerText().catch(() => "<no body>");
    console.error(`[${label}] ${page.url()}\n${text.slice(0, 2000)}`);
    throw error;
  }
}

// Same-origin requests made by the signed-in page itself, using the real
// session CSRF token, to show the API (not just hidden UI) enforces the boundary.
async function pageRequest(page, method, apiPath, body, { csrf = true } = {}) {
  return page.evaluate(async ({ method, apiPath, body, csrf }) => {
    const headers = { "Content-Type": "application/json" };
    if (csrf) {
      const issued = await fetch("/api/auth/csrf-token", { credentials: "include" });
      headers["X-CSRF-Token"] = (await issued.json()).token;
    }
    const response = await fetch(`/api${apiPath}`, {
      method, headers, credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }, { method, apiPath, body, csrf });
}

const fixtures = {};
async function contractorEmailCount() {
  return (await readOutbox()).length;
}
function queueCard(page, title) {
  return page.locator("div.p-4.flex.flex-col.gap-4").filter({ hasText: title });
}
function issueCard(page, title) {
  return page.locator("div.cursor-pointer").filter({ hasText: title });
}
async function openIssues(page) {
  await page.goto(`${appOrigin}/fix-track`);
  await page.getByRole("button", { name: /^Issues/ }).click();
}
// Exactly what the inbox shows the manager, read from the rendered preview.
async function displayedPreview(card) {
  const box = card.locator("div.font-mono");
  const subjectLine = await box.locator("div.font-semibold").first().textContent();
  const all = await box.textContent();
  assert.ok(subjectLine.startsWith("Subject: "));
  return { subject: subjectLine.slice("Subject: ".length), text: all.slice(subjectLine.length) };
}
async function queueRow(id) {
  return (await db.execute(sql`
    SELECT id, status, subject, body_text, last_error, approved_by, sent_by, sent_at, requested_by, email_type
    FROM contractor_email_queue WHERE id=${id}
  `)).rows[0];
}

test("setup: tenant, departments and two-factor enrolled users under the production browser policy", async () => {
  const owner = await createTenant("inbox-owner", { browserPolicy: true });
  const ownerCookie = owner.request.cookie();
  // Sanity check the policy: a cookie-authenticated mutation without the
  // browser CSRF proof is refused by this private API.
  const forged = await fetch(`${apiBase}/departments`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ name: "Forged department" }),
  });
  assert.equal(forged.status, 403, "CSRF enforcement must be active");

  const department = await owner.request("POST", "/departments", { name: `Inbox Alpha ${suffix}` });
  const otherDepartment = await owner.request("POST", "/departments", { name: `Inbox Beta ${suffix}` });
  assert.equal(department.status, 201, JSON.stringify(department.data));
  assert.equal(otherDepartment.status, 201);
  const site = await owner.request("POST", "/sites", {
    name: `Inbox Alpha site ${suffix}`, departmentId: department.data.id, seedStarterChecks: false,
  });
  assert.equal(site.status, 201, JSON.stringify(site.data));
  const otherSite = await owner.request("POST", "/sites", {
    name: `Inbox Beta site ${suffix}`, departmentId: otherDepartment.data.id, seedStarterChecks: false,
  });
  assert.equal(otherSite.status, 201);
  const browserPolicy = { browserPolicy: true };
  Object.assign(fixtures, {
    owner,
    departmentId: department.data.id,
    otherDepartmentId: otherDepartment.data.id,
    siteId: site.data.id,
    otherSiteId: otherSite.data.id,
    manager: await createUser(owner, {
      role: "client_staff", departmentId: department.data.id, isMaintenanceManager: true,
    }, browserPolicy),
    otherManager: await createUser(owner, {
      role: "client_staff", departmentId: otherDepartment.data.id, isMaintenanceManager: true,
    }, browserPolicy),
    staff: await createUser(owner, { role: "client_staff", departmentId: department.data.id }, browserPolicy),
  });

  async function quoteIssue(label, siteId = fixtures.siteId) {
    const email = `inbox-${label}-${suffix}@test.local`;
    const contractor = await owner.request("POST", "/contractors", { name: `Inbox contractor ${label}`, email });
    assert.equal(contractor.status, 201, JSON.stringify(contractor.data));
    const title = `Inbox quote ${label} ${suffix}`;
    const issue = await owner.request("POST", "/fix-track/issues", {
      title, issueType: "general", location: "Plant room", reportedBy: "Facilities",
      reportedDate: isoDay(), siteId, contractorId: contractor.data.id,
    });
    assert.equal(issue.status, 201, JSON.stringify(issue.data));
    return { id: issue.data.id, title, email };
  }
  fixtures.acceptIssue = await quoteIssue("accept");
  fixtures.expiredIssue = await quoteIssue("expired");
  fixtures.foreignIssue = await quoteIssue("beta", fixtures.otherSiteId);
  await clearOutbox();
});

test("staff request a quote from FixTrack and cannot reach the approval inbox", async () => {
  const { page } = await browserContext(fixtures.staff);
  fixtures.staffPage = page;
  await withDiagnostics(page, "staff request", async () => {
    await openIssues(page);
    const card = issueCard(page, fixtures.acceptIssue.title);
    await card.getByRole("button", { name: "Request quote" }).click();
    await page.getByText("Approval requested", { exact: true }).first().waitFor();
    await card.getByText("Awaiting manager approval").waitFor();
    assert.equal(await card.getByRole("button", { name: /Approve & send/i }).count(), 0);

    await page.goto(`${appOrigin}/dashboard`);
    await page.getByRole("heading").first().waitFor();
    assert.equal(await page.getByText("Contractor emails await approval").count(), 0,
      "staff dashboard has no approval inbox link");
    await page.goto(`${appOrigin}/contractor-approvals`);
    await page.getByText("404").waitFor();
    assert.equal(await page.getByText("Contractor Email Approvals").count(), 0,
      "direct navigation does not render the inbox for staff");
  });
  const queue = await pageRequest(page, "GET", "/fix-track/contractor-email-queue");
  assert.equal(queue.status, 403, "staff cannot read the queue even by direct request");
  assert.equal(await contractorEmailCount(), 0, "a staff request sends nothing");
});

test("a manager approves the quote request exactly as previewed in the inbox", async () => {
  const { page } = await browserContext(fixtures.manager);
  fixtures.managerPage = page;
  await withDiagnostics(page, "manager quote approval", async () => {
    await page.goto(`${appOrigin}/dashboard`);
    await page.getByText("Contractor emails await approval").click();
    await page.waitForURL(`${appOrigin}/contractor-approvals`);
    const card = queueCard(page, fixtures.acceptIssue.title);
    await card.waitFor();
    await card.getByText("Requesting Quote").waitFor();
    assert.equal(await queueCard(page, fixtures.foreignIssue.title).count(), 0);
    const reviewed = await displayedPreview(card);
    const queueId = (await queueRowsForIssue(fixtures.acceptIssue.id, "quote_request"))[0].id;
    const listed = await pageRequest(page, "GET", "/fix-track/contractor-email-queue?status=pending");
    assert.equal(listed.status, 200);
    const preview = listed.data.find(item => item.id === queueId)?.emailPreviewJson;
    assert.deepEqual({ subject: preview?.subject, text: preview?.text }, reviewed,
      "the inbox renders the authorised preview verbatim");

    // The real CSRF boundary applies to the page: no token, no mutation.
    const tokenless = await pageRequest(page, "POST",
      `/fix-track/contractor-email-queue/${queueId}/approve-and-send`, {}, { csrf: false });
    assert.equal(tokenless.status, 403);
    assert.equal((await queueRow(queueId)).status, "pending");

    await card.getByRole("button", { name: "Approve & Send" }).click();
    await page.getByText("Email approved and sent").first().waitFor();
    await card.waitFor({ state: "detached" });

    const outbox = await readOutbox();
    assert.equal(outbox.length, 1, "one email is dispatched");
    assert.equal(outbox[0].to, fixtures.acceptIssue.email);
    assert.equal(outbox[0].subject, reviewed.subject, "subject matches the reviewed preview exactly");
    assert.equal(outbox[0].text, reviewed.text, "text matches the reviewed preview exactly");
    assert.equal(outbox[0].html, preview.html, "HTML matches the previewed draft exactly");
    fixtures.quoteToken = outbox[0].html.match(/\/contractor-quote\/([a-f0-9]{64})/)?.[1];
    assert.ok(fixtures.quoteToken, "the sent email carries the working quote link");
    const row = await queueRow(queueId);
    assert.equal(row.status, "sent");
    assert.equal(row.approved_by, fixtures.manager.userId);
  });
});

async function queueRowsForIssue(issueId, emailType) {
  return (await db.execute(sql`
    SELECT id, status, requested_by, approved_by, department_id FROM contractor_email_queue
    WHERE issue_id=${issueId} AND email_type=${emailType} ORDER BY id
  `)).rows;
}
async function submissionsFor(issueId) {
  return (await db.execute(sql`
    SELECT qs.id, qs.status, qs.price_pence, qs.notes FROM fix_track_quote_submissions qs
    JOIN contractor_email_queue q ON q.id=qs.queue_id
    WHERE q.issue_id=${issueId} AND qs.client_id=${fixtures.owner.clientId} ORDER BY qs.id
  `)).rows;
}

test("the contractor submits the public quote form once; the link then shows a receipt", async () => {
  const { page } = await browserContext(null);
  await withDiagnostics(page, "public quote", async () => {
    await page.goto(`${appOrigin}/contractor-quote/${fixtures.quoteToken}`);
    await page.getByRole("heading", { name: "Submit Quote" }).waitFor();
    await page.getByText(fixtures.acceptIssue.title).waitFor();
    await page.getByPlaceholder("0.00").fill("1250.75");
    const notes = `Includes access equipment <${suffix}> & disposal.`;
    await page.getByPlaceholder(/Include any conditions/).fill(notes);
    await page.getByRole("button", { name: "Submit Quote" }).click();
    await page.getByRole("heading", { name: "Quote Submitted" }).waitFor();

    const rows = await submissionsFor(fixtures.acceptIssue.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].price_pence, 125075);
    assert.equal(rows[0].notes, notes);
    assert.equal(rows[0].status, "submitted");

    await page.reload();
    await page.getByRole("heading", { name: "Quote Submitted" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Submit Quote" }).count(), 0,
      "an already-submitted link offers no second form");
    const resubmit = await page.evaluate(async token => (await fetch(`/api/fix-track/quotes/public/${token}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poundsPrice: 1, notes: "Replacement attempt" }),
    })).status, fixtures.quoteToken);
    assert.equal(resubmit, 409);
    assert.deepEqual(await submissionsFor(fixtures.acceptIssue.id), rows, "the original quote evidence is unchanged");

    await page.goto(`${appOrigin}/contractor-quote/${"f".repeat(64)}`);
    await page.getByRole("heading", { name: "Quote Link Invalid" }).waitFor();
  });
});

test("an expired quote link shows the invalid state and accepts nothing", async () => {
  const requested = await fixtures.owner.request("POST", `/fix-track/issues/${fixtures.expiredIssue.id}/request-send`, { mode: "quote" });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
  const [queued] = await queueRowsForIssue(fixtures.expiredIssue.id, "quote_request");
  const sent = await fixtures.manager.request("POST", `/fix-track/contractor-email-queue/${queued.id}/approve-and-send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const token = (await readOutbox()).at(-1).html.match(/\/contractor-quote\/([a-f0-9]{64})/)?.[1];
  assert.ok(token);
  await db.execute(sql`UPDATE contractor_email_queue SET quote_token_expires_at=now()-interval '1 minute'
    WHERE id=${queued.id} AND client_id=${fixtures.owner.clientId}`);
  const { page } = await browserContext(null);
  await withDiagnostics(page, "expired quote", async () => {
    await page.goto(`${appOrigin}/contractor-quote/${token}`);
    await page.getByRole("heading", { name: "Quote Link Invalid" }).waitFor();
    assert.equal(await page.getByPlaceholder("0.00").count(), 0);
    const submit = await page.evaluate(async token => (await fetch(`/api/fix-track/quotes/public/${token}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poundsPrice: 5 }),
    })).status, token);
    assert.equal(submit, 404);
  });
  assert.equal((await submissionsFor(fixtures.expiredIssue.id)).length, 0);
});

test("accepting the quote creates a pending assignment that still awaits inbox review", async () => {
  const staffPage = fixtures.staffPage;
  await withDiagnostics(staffPage, "staff quote view", async () => {
    await openIssues(staffPage);
    await issueCard(staffPage, fixtures.acceptIssue.title).waitFor();
    assert.equal(await issueCard(staffPage, fixtures.acceptIssue.title)
      .getByRole("button", { name: "Accept & Assign" }).count(), 0, "staff cannot accept quotes");
  });
  const page = fixtures.managerPage;
  const before = await contractorEmailCount();
  await withDiagnostics(page, "manager accept", async () => {
    await openIssues(page);
    const card = issueCard(page, fixtures.acceptIssue.title);
    await card.getByRole("button", { name: "Accept & Assign" }).click();
    await page.getByText("Quote accepted", { exact: true }).first().waitFor();
    await card.getByText("Quote accepted", { exact: true }).waitFor();

    const drafts = await queueRowsForIssue(fixtures.acceptIssue.id, "assignment");
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].status, "pending", "acceptance never dispatches without review");
    assert.equal(drafts[0].requested_by, fixtures.manager.userId);
    assert.equal(drafts[0].approved_by, null);
    assert.equal(Number(drafts[0].department_id), fixtures.departmentId);
    assert.equal((await submissionsFor(fixtures.acceptIssue.id))[0].status, "accepted");
    assert.equal(await contractorEmailCount(), before, "accepting sends nothing");
    fixtures.assignmentQueueId = drafts[0].id;

    await page.goto(`${appOrigin}/contractor-approvals`);
    const draftCard = queueCard(page, fixtures.acceptIssue.title);
    await draftCard.getByText("Assigning Job").waitFor();
    const preview = await displayedPreview(draftCard);
    assert.equal(preview.subject, `Job Assigned: ${fixtures.acceptIssue.title}`);
  });
});

test("staff and foreign-department managers cannot see or act on the pending draft", async () => {
  const draftId = fixtures.assignmentQueueId;
  const before = await contractorEmailCount();
  const staffPage = fixtures.staffPage;
  for (const action of ["approve-and-send", "edit-and-send", "cancel"]) {
    const result = await pageRequest(staffPage, "POST", `/fix-track/contractor-email-queue/${draftId}/${action}`,
      action === "edit-and-send" ? { subject: "Forbidden", bodyText: "Forbidden" } : {});
    assert.equal(result.status, 403, `staff ${action}`);
  }

  const { page } = await browserContext(fixtures.otherManager);
  await withDiagnostics(page, "foreign department manager", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    await page.getByText("Contractor Email Approvals").waitFor();
    await page.getByText("No pending emails").waitFor();
    assert.equal(await queueCard(page, fixtures.acceptIssue.title).count(), 0);
    await openIssues(page);
    await page.getByText(fixtures.foreignIssue.title).waitFor();
    assert.equal(await page.getByText(fixtures.acceptIssue.title).count(), 0,
      "another department's FixTrack issue is not listed");
  });
  assert.equal((await pageRequest(page, "POST", `/fix-track/contractor-email-queue/${draftId}/approve-and-send`, {})).status, 409);
  assert.equal((await pageRequest(page, "POST", `/fix-track/contractor-email-queue/${draftId}/edit-and-send`,
    { subject: "Cross-department edit", bodyText: "Cross-department body" })).status, 409);
  assert.equal((await pageRequest(page, "PUT", `/fix-track/contractor-email-queue/${draftId}`,
    { subject: "Cross-department edit", bodyHtml: "<p>Cross-department body</p>" })).status, 404);
  assert.equal((await pageRequest(page, "POST", `/fix-track/contractor-email-queue/${draftId}/cancel`, {})).status, 404);

  const row = await queueRow(draftId);
  assert.equal(row.status, "pending");
  assert.equal(row.subject, `Job Assigned: ${fixtures.acceptIssue.title}`);
  assert.equal(await contractorEmailCount(), before, "denied requests send nothing");
});

test("a rejected approval or dismissal keeps the pending row, shows the error toast and re-enables its actions", async () => {
  const draftId = fixtures.assignmentQueueId;
  const before = await contractorEmailCount();
  const page = fixtures.managerPage;
  await withDiagnostics(page, "rejected approval and dismissal", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    const card = queueCard(page, fixtures.acceptIssue.title);
    await card.getByText("Assigning Job").waitFor();
    const approve = card.getByRole("button", { name: "Approve & Send" });
    const dismiss = card.getByRole("button", { name: "Cancel", exact: true });
    const edit = card.getByRole("button", { name: "Edit" });

    // The server's rejection is held until the row's submitting state has been
    // observed, then answered with a failed response. The request never
    // reaches the API, so the draft stays pending for the later tests.
    async function rejectOnce(action, status, trigger) {
      let release;
      const held = new Promise(resolve => { release = resolve; });
      let arrived;
      const intercepted = new Promise(resolve => { arrived = resolve; });
      let fulfilled;
      const answered = new Promise(resolve => { fulfilled = resolve; });
      let requests = 0;
      // The page may append ?clientId=…, so match on the path alone.
      const actionPath = `/api/fix-track/contractor-email-queue/${draftId}/${action}`;
      const pattern = url => url.origin === appOrigin && url.pathname === actionPath;
      const handler = async route => {
        requests++;
        arrived();
        await held;
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "Rejected by server" }) });
        fulfilled();
      };
      await page.route(pattern, handler);
      try {
        await trigger();
        await intercepted;
        // While the request is in flight the row's actions are disabled.
        for (const button of [approve, dismiss, edit]) await button.and(page.locator(":disabled")).waitFor();
        release();
        // Unrouting before the handler answers would hand the request on to
        // the real API, so wait for the rejection to be sent first.
        await answered;
        return requests;
      } finally {
        release();
        await page.unroute(pattern, handler);
      }
    }

    assert.equal(await rejectOnce("approve-and-send", 502, () => approve.click()), 1);
    // The page's only toast slot holds the destructive error toast.
    await page.locator("li.destructive").filter({ hasText: "Failed to approve email" }).waitFor();
    await card.waitFor();
    for (const button of [approve, dismiss, edit]) await button.and(page.locator(":enabled")).waitFor();

    page.once("dialog", dialog => dialog.accept());
    assert.equal(await rejectOnce("cancel", 409, () => dismiss.click()), 1);
    await page.locator("li.destructive").filter({ hasText: "Failed to cancel email" }).waitFor();
    await card.waitFor();
    for (const button of [approve, dismiss, edit]) await button.and(page.locator(":enabled")).waitFor();

    assert.equal(await queueCard(page, fixtures.acceptIssue.title).count(), 1, "the pending row is still listed once");
    await page.reload();
    await queueCard(page, fixtures.acceptIssue.title).getByText("Assigning Job").waitFor();
  });
  const row = await queueRow(draftId);
  assert.equal(row.status, "pending", "the draft is still pending after both rejections");
  assert.equal(row.approved_by, null);
  assert.equal(await contractorEmailCount(), before, "rejected actions send nothing");
});

test("reminder Edit & Send keeps the reviewed draft through a failed send and dispatches it exactly on retry", async () => {
  const contractor = await db.execute(sql`
    INSERT INTO contractors (client_id, name, email)
    VALUES (${fixtures.owner.clientId}, ${`Reminder contractor ${suffix}`}, ${`inbox-reminder-${suffix}@test.local`})
    RETURNING id`);
  const title = `Inbox reminder ${suffix}`;
  const item = await db.execute(sql`
    INSERT INTO compliance_items (client_id, department_id, site_id, title, status, contractor_id, due_date, lead_time_days)
    VALUES (${fixtures.owner.clientId}, ${fixtures.departmentId}, ${fixtures.siteId}, ${title}, 'pending',
      ${contractor.rows[0].id}, ${isoDay(0)}::date, 0)
    RETURNING id`);
  const itemId = Number(item.rows[0].id);
  // The real scheduler queues the reminder for manager approval.
  const run = await runReminderJob();
  assert.ok(run.queued >= 1, JSON.stringify(run));
  const [reminder] = (await db.execute(sql`
    SELECT id FROM contractor_email_queue WHERE entity_type='compliance' AND entity_id=${itemId} AND status='pending'
  `)).rows;
  assert.ok(reminder, "the scheduler queued a pending reminder");
  await clearOutbox();

  const page = fixtures.managerPage;
  await withDiagnostics(page, "reminder edit and send", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    const card = queueCard(page, title);
    await card.getByText("Reminder", { exact: true }).waitFor();
    const original = await displayedPreview(card);
    const scheduleLink = original.text.match(/\S*\/schedule\/[A-Za-z0-9_-]+/)?.[0];
    assert.ok(scheduleLink, "the reviewed reminder shows the working schedule link");

    await card.getByRole("button", { name: "Edit" }).click();
    const subjectInput = card.getByRole("textbox").first();
    const bodyInput = card.locator("textarea");
    assert.equal(await subjectInput.inputValue(), original.subject, "editor opens on the previewed subject");
    assert.equal(await bodyInput.inputValue(), original.text, "editor opens on the previewed text");
    const edited = {
      subject: `Reviewed reminder ${suffix}`,
      text: `Please confirm the reviewed <scope & access> details.\nArrange the visit: ${scheduleLink}`,
    };
    await subjectInput.fill(edited.subject);
    await bodyInput.fill(edited.text);

    // Make the captured-mail boundary fail: the outbox path becomes a directory.
    await rm(outboxPath, { force: true });
    await mkdir(outboxPath);
    try {
      await card.getByRole("button", { name: "Save & Send" }).click();
      await page.getByText("Failed to approve email").first().waitFor();
    } finally {
      await rm(outboxPath, { recursive: true, force: true });
      await writeFile(outboxPath, "");
    }
    assert.equal(await subjectInput.inputValue(), edited.subject, "the editor keeps the reviewed subject after failure");
    assert.equal(await bodyInput.inputValue(), edited.text, "the editor keeps the reviewed text after failure");
    let row = await queueRow(reminder.id);
    assert.equal(row.status, "pending", "a failed send rolls back to a retryable draft");
    assert.ok(row.last_error, "the failure is recorded");
    assert.equal(row.subject, edited.subject, "the reviewed edit is saved");
    assert.equal(row.sent_at, null);
    assert.equal(await contractorEmailCount(), 0, "nothing was captured for the failed send");

    // After a reload the saved draft is what the inbox previews.
    await page.reload();
    const savedCard = queueCard(page, title);
    await savedCard.waitFor();
    assert.deepEqual(await displayedPreview(savedCard), edited, "the inbox previews the saved reviewed draft");

    await savedCard.getByRole("button", { name: "Edit" }).click();
    assert.equal(await savedCard.getByRole("textbox").first().inputValue(), edited.subject);
    assert.equal(await savedCard.locator("textarea").inputValue(), edited.text);
    await savedCard.getByRole("button", { name: "Save & Send" }).click();
    await page.getByText("Email approved and sent").first().waitFor();
    await savedCard.waitFor({ state: "detached" });

    const outbox = await readOutbox();
    assert.equal(outbox.length, 1, "the retry dispatches exactly one email");
    assert.equal(outbox[0].subject, edited.subject);
    assert.equal(outbox[0].text, edited.text, "the dispatched text is exactly the reviewed text");
    assert.ok(outbox[0].html.includes("&lt;scope &amp; access&gt;"), "edited text is escaped, not interpreted as HTML");
    assert.ok(outbox[0].html.includes(scheduleLink.replace(/^\S*?(\/schedule\/)/, "$1")));
    row = await queueRow(reminder.id);
    assert.equal(row.status, "sent");
    assert.equal(row.approved_by, fixtures.manager.userId);
    assert.equal(row.sent_by, fixtures.manager.userId);

    // A double-submitted retry cannot send it again.
    const repeat = await pageRequest(page, "POST", `/fix-track/contractor-email-queue/${reminder.id}/edit-and-send`,
      { subject: edited.subject, bodyText: edited.text });
    assert.equal(repeat.status, 409);
    assert.equal(await contractorEmailCount(), 1);
  });
});

// A sent, dated assignment whose calendar cancellation now awaits review.
async function queuedCalendarCancellation(label, targetDate) {
  const owner = fixtures.owner;
  const contractor = await owner.request("POST", "/contractors", {
    name: `${label} contractor ${suffix}`, email: `inbox-${label}-${suffix}@test.local`,
  });
  assert.equal(contractor.status, 201, JSON.stringify(contractor.data));
  const title = `Inbox ${label} ${suffix}`;
  const issue = await owner.request("POST", "/fix-track/issues", {
    title, issueType: "general", location: "Plant room", reportedBy: "Facilities",
    reportedDate: isoDay(0), siteId: fixtures.siteId, contractorId: contractor.data.id, targetDate,
  });
  assert.equal(issue.status, 201, JSON.stringify(issue.data));
  const id = issue.data.id;
  for (const [step, expected] of [["request-send", 200], ["approve-send", 200], ["send-to-contractor", 200]]) {
    const result = await owner.request("POST", `/fix-track/issues/${id}/${step}`, step === "request-send" ? { mode: "assign" } : undefined);
    assert.equal(result.status, expected, `${step}: ${JSON.stringify(result.data)}`);
  }
  const requested = await owner.request("POST", `/fix-track/issues/${id}/request-cancellation`);
  assert.equal(requested.status, 202, JSON.stringify(requested.data));
  const [row] = await queueRowsForIssue(id, "cancellation");
  assert.equal(row?.status, "pending");
  return { id, title, queueId: row.id };
}

// Every queue action the page sends, by path, so a test can show a dialog
// dismissal sent nothing and a confirmation sent exactly one request.
function recordQueueActions(page) {
  const actions = [];
  page.on("request", request => {
    const { pathname } = new URL(request.url());
    if (request.method() === "POST" && /^\/api\/fix-track\/contractor-email-queue\/\d+\//.test(pathname)) {
      actions.push(pathname.replace(/^\/api/, ""));
    }
  });
  return actions;
}

async function focusedElement(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    return {
      text: element?.textContent?.trim() ?? "",
      inDialog: !!element?.closest('[role="alertdialog"]'),
    };
  });
}

// The dialog is announced as an alert dialog named by its title and described
// by its consequence, and it takes focus on its safe "Keep reviewing" action.
async function expectAccessibleDialog(page, name, description) {
  const dialog = page.getByRole("alertdialog", { name });
  await dialog.waitFor();
  const described = await dialog.evaluate(element => element.getAttribute("aria-describedby")
    ?.split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim()).join(" "));
  assert.equal(described, description, `${name} is described by its consequence`);
  assert.deepEqual(await focusedElement(page), { text: "Keep reviewing", inDialog: true },
    `${name} opens with focus on Keep reviewing`);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    assert.equal((await focusedElement(page)).inDialog, true, `${name} keeps keyboard focus inside the dialog`);
  }
  return dialog;
}

test("calendar cancellation approval dialog works by keyboard and is announced to screen readers", async () => {
  const cancellation = await queuedCalendarCancellation("approve-dialog", isoDay(30));
  await clearOutbox();
  const page = fixtures.managerPage;
  const actions = recordQueueActions(page);
  await withDiagnostics(page, "cancellation approval dialog", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    const card = queueCard(page, cancellation.title);
    await card.getByText("Calendar Cancellation", { exact: true }).waitFor();
    const approve = card.getByRole("button", { name: "Approve Cancellation" });
    const name = "Approve calendar cancellation?";
    const description = "This will send the contractor a cancellation notice and remove the previously sent calendar event.";

    // Opened from the keyboard, Escape closes it and returns focus to the row.
    await approve.focus();
    await page.keyboard.press("Enter");
    await expectAccessibleDialog(page, name, description);
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.deepEqual(await focusedElement(page), { text: "Approve Cancellation", inDialog: false },
      "closing the dialog returns focus to Approve Cancellation");

    // Keep reviewing, chosen with the keyboard, also closes it without sending.
    await page.keyboard.press("Enter");
    await expectAccessibleDialog(page, name, description);
    await page.getByRole("button", { name: "Keep reviewing" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.deepEqual(actions, [], "dismissing the dialog sends nothing");
    assert.equal((await queueRow(cancellation.queueId)).status, "pending");
    await card.waitFor();

    // Confirming sends exactly one approval of this cancellation.
    await approve.click();
    const dialog = await expectAccessibleDialog(page, name, description);
    await dialog.getByRole("button", { name: "Approve Cancellation" }).click();
    await page.getByText("Calendar cancellation approved and sent").first().waitFor();
    await dialog.waitFor({ state: "detached" });
    await card.waitFor({ state: "detached" });
    assert.deepEqual(actions, [`/fix-track/contractor-email-queue/${cancellation.queueId}/approve-and-send`]);
  });
  const row = await queueRow(cancellation.queueId);
  assert.equal(row.status, "sent");
  assert.equal(row.approved_by, fixtures.manager.userId);
  const outbox = await readOutbox();
  assert.equal(outbox.length, 1, "one cancellation is sent");
  assert.match(outbox[0].icsAttachment ?? "", /METHOD:CANCEL/);
});

test("dismissing a calendar cancellation keeps the event and calls the cancel endpoint only after confirmation", async () => {
  const cancellation = await queuedCalendarCancellation("dismiss-dialog", isoDay(31));
  await clearOutbox();
  const page = fixtures.managerPage;
  const actions = recordQueueActions(page);
  await withDiagnostics(page, "cancellation dismissal dialog", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    const card = queueCard(page, cancellation.title);
    await card.getByText("Calendar Cancellation", { exact: true }).waitFor();
    const dismiss = card.getByRole("button", { name: "Dismiss" });
    const name = "Dismiss calendar cancellation?";
    const description = "Nothing will be sent and the existing calendar event will remain in place.";

    await dismiss.focus();
    await page.keyboard.press("Enter");
    await expectAccessibleDialog(page, name, description);
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.deepEqual(await focusedElement(page), { text: "Dismiss", inDialog: false },
      "closing the dialog returns focus to Dismiss");

    await dismiss.click();
    const keep = await expectAccessibleDialog(page, name, description);
    await keep.getByRole("button", { name: "Keep reviewing" }).click();
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    assert.deepEqual(actions, [], "keeping the request sends nothing");
    assert.equal((await queueRow(cancellation.queueId)).status, "pending");

    await dismiss.click();
    const dialog = await expectAccessibleDialog(page, name, description);
    await dialog.getByRole("button", { name: "Dismiss" }).click();
    await page.getByText("Calendar cancellation dismissed").first().waitFor();
    await dialog.waitFor({ state: "detached" });
    await card.waitFor({ state: "detached" });
    assert.deepEqual(actions, [`/fix-track/contractor-email-queue/${cancellation.queueId}/cancel`]);
  });
  assert.equal((await queueRow(cancellation.queueId)).status, "cancelled");
  assert.equal(await contractorEmailCount(), 0, "dismissal sends nothing, so the calendar event stays");
  const [issue] = (await db.execute(sql`
    SELECT email_request_status FROM fix_track_issues WHERE id=${cancellation.id}
  `)).rows;
  assert.equal(issue.email_request_status, "rejected");
});

test("managers see sent and failed calendar cancellations on the approvals page and the contractor's page", async () => {
  const cancellation = await queuedCalendarCancellation("history", isoDay(32));
  const [{ contractor_id: contractorId }] = (await db.execute(sql`
    SELECT contractor_id FROM contractor_email_queue WHERE id=${cancellation.queueId}
  `)).rows;
  await clearOutbox();
  const page = fixtures.managerPage;
  const historyEntry = () => page.getByRole("region", { name: "Calendar cancellations" })
    .getByRole("listitem").filter({ hasText: cancellation.title });
  await withDiagnostics(page, "calendar cancellation history", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    const card = queueCard(page, cancellation.title);
    await card.getByText("Calendar Cancellation", { exact: true }).waitFor();
    assert.equal(await historyEntry().count(), 0, "a cancellation awaiting first approval is not history yet");

    // The provider boundary fails: the outbox path becomes a directory.
    await rm(outboxPath, { force: true });
    await mkdir(outboxPath);
    try {
      await card.getByRole("button", { name: "Approve Cancellation" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Approve Cancellation" }).click();
      await page.getByText("Failed to approve email").first().waitFor();
    } finally {
      await rm(outboxPath, { recursive: true, force: true });
      await writeFile(outboxPath, "");
    }
    await page.getByRole("button", { name: "Keep reviewing" }).click();
    const failed = historyEntry();
    await failed.getByText("Send failed").waitFor();
    assert.match(await failed.innerText(), /Not sent, awaiting a retry/);
    assert.equal(await failed.getByText("Sent", { exact: true }).count(), 0, "a failed send is not shown as sent");

    await page.reload();
    await card.getByText("Last send failed").waitFor();
    await card.getByRole("button", { name: "Approve Cancellation" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Approve Cancellation" }).click();
    await page.getByText("Calendar cancellation approved and sent").first().waitFor();
    await card.waitFor({ state: "detached" });
    const sent = historyEntry();
    await sent.getByText("Sent", { exact: true }).waitFor();
    const sentText = await sent.innerText();
    assert.match(sentText, /by Approval fixture user/, "the record names the manager who sent it");
    assert.match(sentText, /After 1 failed attempt/);
    assert.match(sentText, new RegExp(`inbox-history-${suffix}@test\\.local`), "the record names the contractor's address");
    assert.equal(await sent.getByText("Send failed").count(), 0);

    await page.goto(`${appOrigin}/contractors/${contractorId}`);
    const onContractor = historyEntry();
    await onContractor.getByText("Sent", { exact: true }).waitFor();
    assert.match(await onContractor.innerText(), /by Approval fixture user/);
  });
  const row = await queueRow(cancellation.queueId);
  assert.equal(row.status, "sent");
  assert.equal((await readOutbox()).length, 1, "the retry sends the cancellation once");
});

test("an open approvals page drops requests reviewed elsewhere without disturbing the manager's own review", async () => {
  const approvedElsewhere = await queuedCalendarCancellation("fresh-approved", isoDay(33));
  const editing = await queuedCalendarCancellation("fresh-editing", isoDay(34));
  const confirming = await queuedCalendarCancellation("fresh-confirming", isoDay(35));
  const { page } = await browserContext(fixtures.manager);
  // The page's minute timer runs on a controlled clock.
  await page.clock.install();
  const siteHeader = () => page.getByRole("button", { name: new RegExp(`Inbox Alpha site ${suffix}`) });
  const siteCount = async () => Number((await siteHeader().locator("span.tabular-nums").textContent())?.trim());
  const anotherManager = (path) => fixtures.owner.request("POST", `/fix-track/contractor-email-queue/${path}`, {});
  await withDiagnostics(page, "approvals freshness", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    await queueCard(page, approvedElsewhere.title).waitFor();
    const search = page.getByPlaceholder(/search/i);
    await search.fill(`fresh-`);
    await queueCard(page, confirming.title).waitFor();
    assert.equal(await siteCount(), 3);

    // Collapsed site and search survive a timed refresh that drops a request
    // another manager approved.
    await siteHeader().click();
    assert.equal(await queueCard(page, approvedElsewhere.title).count(), 0, "the site is collapsed");
    assert.equal((await anotherManager(`${approvedElsewhere.queueId}/approve-and-send`)).status, 200);
    await page.clock.fastForward(61_000);
    for (let waited = 0; (await siteCount()) !== 2 && waited < 10_000; waited += 100) await page.waitForTimeout(100);
    assert.equal(await siteCount(), 2, "the request approved elsewhere is gone");
    assert.equal(await search.inputValue(), "fresh-", "the search is kept");
    assert.equal(await queueCard(page, editing.title).count(), 0, "the site stays collapsed");
    await siteHeader().click();
    await queueCard(page, editing.title).waitFor();
    assert.equal(await queueCard(page, approvedElsewhere.title).count(), 0);

    // An open editor is not replaced, even when its request is dismissed elsewhere.
    const editingCard = queueCard(page, editing.title);
    await editingCard.getByRole("button", { name: "Edit" }).click();
    const subject = editingCard.getByRole("textbox").first();
    await subject.fill("Manager's unsaved subject");
    assert.equal((await anotherManager(`${editing.queueId}/cancel`)).status, 200);
    await page.clock.fastForward(61_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(500);
    assert.equal(await subject.inputValue(), "Manager's unsaved subject", "the editor keeps its text");
    await editingCard.getByRole("button", { name: "Cancel Edit" }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await editingCard.waitFor({ state: "detached" });

    // An open cancellation dialog is not closed or emptied by a refresh.
    const confirmingCard = queueCard(page, confirming.title);
    await confirmingCard.getByRole("button", { name: "Approve Cancellation" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Approve calendar cancellation?" });
    await dialog.waitFor();
    assert.equal((await anotherManager(`${confirming.queueId}/cancel`)).status, 200);
    await page.clock.fastForward(61_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(500);
    assert.equal(await dialog.isVisible(), true, "the dialog stays open");
    assert.equal(await confirmingCard.count(), 1, "the row under the dialog stays");
    await dialog.getByRole("button", { name: "Keep reviewing" }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await confirmingCard.waitFor({ state: "detached" });
    assert.equal(await search.inputValue(), "fresh-");
  });
  assert.equal((await queueRow(editing.queueId)).status, "cancelled");
  assert.equal((await queueRow(confirming.queueId)).status, "cancelled");
});

// Fails every queue load until restored; counts the loads either way.
async function failQueueLoads(page) {
  const state = { failing: true, loads: 0 };
  await page.route(
    url => url.origin === appOrigin && url.pathname === "/api/fix-track/contractor-email-queue",
    async route => {
      state.loads++;
      if (state.failing) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) });
      } else {
        await route.fallback();
      }
    },
  );
  return state;
}

test("a failed approvals load shows the error state, not an empty queue, and Try again recovers", async () => {
  for (const [label, session, restored] of [
    ["pending", fixtures.manager, "pending"],
    ["empty", fixtures.otherManager, "empty"],
  ]) {
    const { page } = await browserContext(session);
    const queueLoads = await failQueueLoads(page);
    await withDiagnostics(page, `failed approvals load (${label})`, async () => {
      await page.goto(`${appOrigin}/contractor-approvals`);
      await page.getByText("Unable to load approvals").waitFor();
      await page.getByText("We couldn't load pending contractor emails. Please try again.", { exact: true }).waitFor();
      assert.equal(await page.getByText("Approvals may be out of date").count(), 0,
        `${label}: with nothing loaded there is no stale list to warn about`);
      assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 1, `${label}: one retry control`);
      assert.equal(await page.getByText("No pending emails").count(), 0,
        `${label}: a failed load is not shown as an empty queue`);
      assert.equal(await page.getByRole("button", { name: /^(Approve & Send|Approve Cancellation)$/ }).count(), 0,
        `${label}: no approval rows are shown`);

      queueLoads.failing = false;
      const loadsBeforeRetry = queueLoads.loads;
      await page.getByRole("button", { name: "Try again" }).click();
      if (restored === "pending") {
        await queueCard(page, fixtures.acceptIssue.title).waitFor();
        assert.equal(await page.getByText("No pending emails").count(), 0);
      } else {
        await page.getByText("No pending emails").waitFor();
      }
      assert.ok(queueLoads.loads > loadsBeforeRetry, `${label}: Try again requests the queue again`);
      assert.equal(await page.getByText("Unable to load approvals").count(), 0, `${label}: the error state clears`);

      const lastUpdated = page.getByTestId("approvals-last-updated").locator("time");
      await lastUpdated.waitFor();
      const recoveredAt = await lastUpdated.getAttribute("datetime");
      assert.ok(Date.parse(recoveredAt) > 0, `${label}: the successful retry shows when the list was updated`);

      if (restored === "pending") {
        // A later failed refresh keeps the last list and its time, and says
        // the list may be stale and how old it is.
        await page.waitForTimeout(1100);
        queueLoads.failing = true;
        await page.getByRole("button", { name: "Refresh approvals" }).click();
        const warning = page.getByText("Approvals may be out of date").locator("..");
        await warning.waitFor();
        await queueCard(page, fixtures.acceptIssue.title).waitFor();
        assert.equal(await page.getByText("Unable to load approvals").count(), 0);
        assert.equal(await lastUpdated.getAttribute("datetime"), recoveredAt,
          "a failed refresh does not move the last-updated time");
        assert.equal(await warning.locator("time").getAttribute("datetime"), recoveredAt,
          "the stale-list warning shows when the list was last updated");
        assert.match(await warning.innerText(), /It was last updated at \d{2}:\d{2}:\d{2}\./);

        queueLoads.failing = false;
        await page.getByRole("button", { name: "Refresh approvals" }).click();
        await page.getByText("Refreshing approvals…").waitFor({ state: "detached" });
        let refreshedAt = await lastUpdated.getAttribute("datetime");
        for (let waited = 0; refreshedAt === recoveredAt && waited < 10_000; waited += 100) {
          await page.waitForTimeout(100);
          refreshedAt = await lastUpdated.getAttribute("datetime");
        }
        assert.ok(Date.parse(refreshedAt) > Date.parse(recoveredAt),
          "a successful refresh moves the last-updated time forward");
        assert.equal(await page.getByText("Approvals may be out of date").count(), 0,
          "a successful refresh removes the stale-list warning");
      }
    });
  }
});

test("Refresh approvals makes one request and keeps the search, site sections and rows until the new list arrives", async () => {
  const existing = await queuedCalendarCancellation("refresh-existing", isoDay(36));
  const { page } = await browserContext(fixtures.manager);
  const queuePath = "/api/fix-track/contractor-email-queue";
  let queueRequests = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === queuePath) queueRequests++;
  });
  const siteHeader = () => page.getByRole("button", { name: new RegExp(`Inbox Alpha site ${suffix}`) });
  const refreshButton = () => page.getByRole("button", { name: /^(Refresh approvals|Refreshing…)$/ });

  // Holds the next queue response until released, so the pending state can be checked.
  async function holdNextQueueLoad() {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let arrived;
    const intercepted = new Promise(resolve => { arrived = resolve; });
    let answered;
    const done = new Promise(resolve => { answered = resolve; });
    const matcher = url => url.origin === appOrigin && url.pathname === queuePath;
    const handler = async route => {
      arrived();
      await held;
      // Forwarded to the private API as browserContext does, once released.
      const original = new URL(route.request().url());
      const headers = { ...route.request().headers() };
      if (headers.origin === appOrigin) headers.origin = apiOrigin;
      const response = await route.fetch({ url: `${apiOrigin}${original.pathname}${original.search}`, headers });
      await route.fulfill({ response });
      answered();
    };
    await page.route(matcher, handler, { times: 1 });
    return { intercepted, release: async () => { release(); await done; } };
  }

  await withDiagnostics(page, "manual refresh", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    const search = page.getByPlaceholder("Search emails...");
    await search.fill("refresh-");
    const existingCard = queueCard(page, existing.title);
    await existingCard.waitFor();

    // Expanded site: rows stay visible while the refresh is pending.
    const firstHold = await holdNextQueueLoad();
    let added;
    const before = queueRequests;
    await refreshButton().click();
    await firstHold.intercepted;
    await page.getByRole("button", { name: "Refreshing…" }).and(page.locator(":disabled")).waitFor();
    await page.getByText("Refreshing approvals…").waitFor();
    assert.equal(await existingCard.isVisible(), true, "existing rows stay visible during the refresh");
    assert.equal(await search.inputValue(), "refresh-");
    // A request queued meanwhile shows that the response, not the old list, is what replaces the rows.
    added = await queuedCalendarCancellation("refresh-added", isoDay(37));
    assert.equal(await queueCard(page, added.title).count(), 0, "the new request is not shown before the response");
    await firstHold.release();
    await queueCard(page, added.title).waitFor();
    await page.getByRole("button", { name: "Refresh approvals" }).and(page.locator(":enabled")).waitFor();
    assert.equal(queueRequests - before, 1, "one refresh makes one queue request");
    assert.equal(await page.getByText("Refreshing approvals…").count(), 0);
    assert.equal(await search.inputValue(), "refresh-", "the search is kept after the refresh");
    assert.equal(await existingCard.isVisible(), true);

    // Collapsed site: it stays collapsed through a refresh.
    await siteHeader().click();
    await existingCard.waitFor({ state: "detached" });
    const secondHold = await holdNextQueueLoad();
    const beforeSecond = queueRequests;
    await refreshButton().click();
    await secondHold.intercepted;
    await page.getByText("Refreshing approvals…").waitFor();
    assert.equal(await existingCard.count(), 0, "the collapsed site stays collapsed while refreshing");
    await secondHold.release();
    await page.getByRole("button", { name: "Refresh approvals" }).and(page.locator(":enabled")).waitFor();
    assert.equal(queueRequests - beforeSecond, 1);
    assert.equal(await existingCard.count(), 0, "the collapsed site stays collapsed after refreshing");
    assert.equal(Number((await siteHeader().locator("span.tabular-nums").textContent())?.trim()), 2,
      "the collapsed site's count reflects the refreshed list");
    assert.equal(await search.inputValue(), "refresh-");
    await siteHeader().click();
    await queueCard(page, added.title).waitFor();
  });
});

test("the new-request notice stays quiet on first load, counts new requests, and clears when reviewed", async () => {
  // A fresh browser context has no saved baseline, as on a manager's first visit.
  const { page } = await browserContext(fixtures.manager);
  const notice = () => page.getByText(/^\d+ new approval requests? found$/);
  const newBadge = (title) => queueCard(page, title).getByLabel("New approval request");
  async function refreshTo(title) {
    await page.getByRole("button", { name: "Refresh approvals" }).click();
    await queueCard(page, title).waitFor();
  }
  await withDiagnostics(page, "new-request notice", async () => {
    await page.goto(`${appOrigin}/contractor-approvals`);
    await queueCard(page, fixtures.acceptIssue.title).waitFor();
    await page.getByTestId("approvals-last-updated").waitFor();
    assert.equal(await notice().count(), 0, "the first load does not call existing requests new");
    assert.equal(await page.getByLabel("New approval request").count(), 0);

    const first = await queuedCalendarCancellation("notice-first", isoDay(38));
    await refreshTo(first.title);
    await page.getByText("1 new approval request found", { exact: true }).waitFor();
    await newBadge(first.title).waitFor();
    assert.equal(await newBadge(fixtures.acceptIssue.title).count(), 0, "requests already listed are not marked new");

    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    await notice().waitFor({ state: "detached" });
    assert.equal(await page.getByLabel("New approval request").count(), 0, "Mark as reviewed clears every New marker");

    const second = await queuedCalendarCancellation("notice-second", isoDay(39));
    const third = await queuedCalendarCancellation("notice-third", isoDay(40));
    await refreshTo(third.title);
    await page.getByText("2 new approval requests found", { exact: true }).waitFor();
    await newBadge(second.title).waitFor();
    await newBadge(third.title).waitFor();
    assert.equal(await newBadge(first.title).count(), 0, "a reviewed request does not become new again");

    // The notice survives a reload, and an unchanged refresh adds nothing.
    await page.reload();
    await page.getByText("2 new approval requests found", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh approvals" }).click();
    await page.getByRole("button", { name: "Refresh approvals" }).and(page.locator(":enabled")).waitFor();
    assert.equal(await page.getByText("2 new approval requests found", { exact: true }).count(), 1);
    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    await notice().waitFor({ state: "detached" });
  });
});
