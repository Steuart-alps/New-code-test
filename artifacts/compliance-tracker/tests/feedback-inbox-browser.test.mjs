import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
};
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test", REPL_ID: undefined },
  stdio: ["ignore", "pipe", "pipe"],
});
let viteLogs = "";
vite.stdout.on("data", chunk => { viteLogs += chunk.toString(); });
vite.stderr.on("data", chunk => { viteLogs += chunk.toString(); });

const REPORT_ID = 4201;
const CLIENT_A = 42;
const CLIENT_B = 43;
const CSRF_TOKEN = "feedback-test-csrf";
const createdAt = "2026-09-23T10:15:00.000Z";
let currentRole = "client_admin";
let listUnavailable = false;
let nextSaveFailure = false;
let nextHeldFeedbackList = null;
let csrfTokenRequests = 0;
const feedbackGets = [];
const feedbackMutations = [];
const csrfHeaders = [];
const unexpectedApiRequests = [];
const deniedFeedbackRequests = [];
const historyGets = [];
// Accepted changes per report id, oldest first (the API returns newest first).
const reviewHistory = new Map();
const TEST_USER_NAME = "Feedback Inbox Browser Test";

function recordReview(report, previous, actorId, actorName) {
  const entries = reviewHistory.get(report.id) ?? [];
  entries.push({
    id: 9000 + entries.length + report.id * 10,
    reportId: report.id,
    revision: report.revision,
    actorId,
    actorName,
    previousStatus: previous.status,
    status: report.status,
    previousInternalNote: previous.internalNote ?? "",
    internalNote: report.internalNote ?? "",
    createdAt: report.updatedAt,
  });
  reviewHistory.set(report.id, entries);
}

// Simulates a second manager saving the report outside this browser.
function otherManagerSaves(report, status, internalNote) {
  const previous = { status: report.status, internalNote: report.internalNote };
  report.status = status;
  report.internalNote = internalNote;
  report.revision += 1;
  report.updatedBy = 157;
  report.updatedByName = "Priya Patel";
  report.updatedAt = `2026-09-25T09:0${report.revision}:00.000Z`;
  recordReview(report, previous, 157, "Priya Patel");
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const reportForClientA = {
  id: REPORT_ID,
  clientId: CLIENT_A,
  category: "bug",
  summary: "Billing page clears my saved payment details",
  details: "After updating the billing address, the saved payment method disappears. I expected it to remain in the account.",
  pagePath: "/settings/billing",
  emailStatus: "not_configured",
  createdAt,
  status: "new",
  internalNote: null,
  updatedBy: null,
  updatedAt: null,
  updatedByName: null,
  revision: 0,
  submitterName: "Mira Chen",
};
const clientAReports = [
  reportForClientA,
  {
    id: 4202,
    clientId: CLIENT_A,
    category: "feedback",
    summary: "Helpful monthly compliance summary",
    details: "The monthly summary is useful.",
    pagePath: "/reports",
    emailStatus: "not_configured",
    createdAt: "2026-09-22T09:00:00.000Z",
    status: "new",
    internalNote: null,
    updatedBy: null,
    updatedAt: null,
    updatedByName: null,
    revision: 0,
    submitterName: "Sam Rivera",
  },
];
const clientBReports = [{
  id: 4301,
  clientId: CLIENT_B,
  category: "feedback",
  summary: "Client B private feedback",
  details: "This report belongs to the second client.",
  pagePath: "/dashboard",
  emailStatus: "not_configured",
  createdAt,
  status: "new",
  internalNote: null,
  updatedBy: null,
  updatedAt: null,
  updatedByName: null,
  revision: 0,
  submitterName: "Alex Green",
}];

const jsonResponse = (route, data, status = 200) => route.fulfill({
  status,
  contentType: "application/json",
  body: JSON.stringify(data),
});

async function waitForVite() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited before startup:\n${viteLogs}`);
    try {
      const response = await fetch(`${baseUrl}/feedback`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteLogs}`);
}

function authFixture() {
  return {
    user: {
      id: 156,
      email: "feedback-inbox@example.test",
      name: TEST_USER_NAME,
      role: currentRole,
      clientId: currentRole === "consultant" ? null : CLIENT_A,
      departmentId: null,
      active: true,
      totpEnabled: true,
    },
    client: {
      id: CLIENT_A,
      name: "Feedback Fixture Client A",
      slug: "feedback-fixture-client-a",
      logoUrl: null,
      primaryColor: "#2F7C8C",
      active: true,
    },
    services: [],
    billingLocked: false,
  };
}

async function routeApi(route, url) {
  const request = route.request();
  const { pathname, searchParams } = url;
  const method = request.method();

  if (pathname === "/api/auth/csrf-token" && method === "GET") {
    csrfTokenRequests += 1;
    return jsonResponse(route, { token: CSRF_TOKEN });
  }
  if (pathname === "/api/auth/me" && method === "GET") return jsonResponse(route, authFixture());
  if (pathname === "/api/billing/cancellation-status" && method === "GET") {
    return jsonResponse(route, { accessEndsAt: null });
  }
  if (pathname === "/api/clients" && method === "GET") {
    return jsonResponse(route, [
      {
        id: CLIENT_A,
        name: "Feedback Fixture Client A",
        slug: "feedback-fixture-client-a",
        logoUrl: null,
        primaryColor: "#2F7C8C",
        active: true,
      },
      {
        id: CLIENT_B,
        name: "Second Switch Client",
        slug: "second-switch-client",
        logoUrl: null,
        primaryColor: "#497B91",
        active: true,
      },
    ]);
  }
  if (pathname === "/api/admin/data-deletion-requests" && method === "GET") return jsonResponse(route, []);

  // Minimal dashboard dependencies for the consultants' real client-switch flow.
  if (pathname === "/api/sites" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/users" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/settings" && method === "GET") return jsonResponse(route, {});
  if (pathname === "/api/fix-track/contractor-email-queue" && method === "GET") return jsonResponse(route, []);
  if (pathname === "/api/dashboard/summary" && method === "GET") {
    return jsonResponse(route, { tracks: [], checklistTotals: null });
  }
  if (pathname === "/api/food-safety/status" && method === "GET") return jsonResponse(route, []);

  if (pathname === "/api/feedback" && method === "GET") {
    const clientId = searchParams.get("clientId");
    const category = searchParams.get("category");
    const status = searchParams.get("status");
    feedbackGets.push({ clientId, category, status, url: url.toString(), role: currentRole });
    if (!["consultant", "client_admin"].includes(currentRole)) {
      deniedFeedbackRequests.push({ method, url: url.toString(), role: currentRole });
      return jsonResponse(route, { error: "Administrators only" }, 403);
    }
    if (nextHeldFeedbackList) {
      const heldList = nextHeldFeedbackList;
      nextHeldFeedbackList = null;
      heldList.started.resolve();
      await heldList.resume.promise;
    }
    if (listUnavailable) return jsonResponse(route, { error: "Feedback list is temporarily unavailable." }, 503);
    const reports = clientId === String(CLIENT_B) ? clientBReports : clientAReports;
    return jsonResponse(route, reports.filter(report =>
      (!category || report.category === category) && (!status || report.status === status),
    ));
  }
  const historyMatch = pathname.match(/^\/api\/feedback\/(\d+)\/history$/);
  if (historyMatch && method === "GET") {
    const clientId = searchParams.get("clientId");
    historyGets.push({ clientId, id: historyMatch[1], role: currentRole });
    if (!["consultant", "client_admin"].includes(currentRole)) {
      deniedFeedbackRequests.push({ method, url: url.toString(), role: currentRole });
      return jsonResponse(route, { error: "Administrators only" }, 403);
    }
    const reports = clientId === String(CLIENT_B) ? clientBReports : clientAReports;
    const report = reports.find(item => String(item.id) === historyMatch[1]);
    if (!report) return jsonResponse(route, { error: "Feedback report not found." }, 404);
    return jsonResponse(route, [...(reviewHistory.get(report.id) ?? [])].reverse());
  }
  if (pathname.startsWith("/api/feedback/") && method === "PATCH") {
    const clientId = searchParams.get("clientId");
    const headers = request.headers();
    const token = headers["x-csrf-token"] ?? null;
    csrfHeaders.push({ token, url: url.toString() });
    const body = request.postDataJSON();
    feedbackMutations.push({ clientId, id: pathname.split("/").at(-1), body, role: currentRole });
    if (!["consultant", "client_admin"].includes(currentRole)) {
      deniedFeedbackRequests.push({ method, url: url.toString(), role: currentRole });
      return jsonResponse(route, { error: "Administrators only" }, 403);
    }
    if (token !== CSRF_TOKEN) return jsonResponse(route, { error: "Missing or invalid CSRF token" }, 403);
    if (nextSaveFailure) {
      nextSaveFailure = false;
      return jsonResponse(route, { error: "The review could not be saved. Try again." }, 503);
    }
    const reports = clientId === String(CLIENT_B) ? clientBReports : clientAReports;
    const report = reports.find(item => String(item.id) === pathname.split("/").at(-1));
    if (!report) return jsonResponse(route, { error: "Feedback report not found." }, 404);
    if (body.expectedRevision !== report.revision) {
      return jsonResponse(route, {
        error: "Another manager saved this report after you opened it. Your draft has not been saved.",
        report,
      }, 409);
    }
    const previous = { status: report.status, internalNote: report.internalNote };
    report.status = body.status;
    report.internalNote = body.internalNote;
    report.updatedBy = 156;
    report.updatedByName = TEST_USER_NAME;
    report.revision += 1;
    report.updatedAt = `2026-09-24T12:3${report.revision}:00.000Z`;
    recordReview(report, previous, 156, TEST_USER_NAME);
    return jsonResponse(route, report);
  }

  unexpectedApiRequests.push({
    method,
    url: url.toString(),
    body: request.postData() ?? null,
  });
  return jsonResponse(route, { error: `Unexpected test API request: ${method} ${pathname}` }, 501);
}

const isFeedbackGet = response => {
  const request = response.request();
  return request.method() === "GET" && new URL(response.url()).pathname === "/api/feedback";
};
const getFeedbackResponse = predicate => response =>
  isFeedbackGet(response) && predicate(new URL(response.url()).searchParams);

try {
  await waitForVite();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    const consoleErrors = [];
    page.on("console", message => {
      if (
        message.type() === "error"
        && message.text() !== "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
        // The browser's own network log for the deliberate stale-draft 409.
        && message.text() !== "Failed to load resource: the server responded with a status of 409 (Conflict)"
      ) consoleErrors.push(message.text());
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/")) return routeApi(route, url);
      return route.continue();
    });

    await page.goto(`${baseUrl}/feedback`, { waitUntil: "domcontentloaded" });
    const inboxLink = page.getByRole("link", { name: "Feedback inbox", exact: true });
    await inboxLink.waitFor({ state: "visible" });
    await inboxLink.click();
    await page.getByTestId(`row-feedback-${REPORT_ID}`).waitFor({ state: "visible" });
    assert.ok(
      feedbackGets.some(get => get.clientId === String(CLIENT_A) && !get.category && !get.status),
      "the administrator inbox must load feedback with the active clientId=42",
    );

    let filteredGet = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "bug",
    ));
    await page.getByTestId("filter-category").click();
    await page.getByRole("option", { name: "Bug", exact: true }).click();
    let response = await filteredGet;
    assert.equal(response.status(), 200);

    filteredGet = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "bug" && params.get("status") === "new",
    ));
    await page.getByTestId("filter-status").click();
    await page.getByRole("option", { name: "New", exact: true }).click();
    response = await filteredGet;
    assert.equal(response.status(), 200, "the list request should include both selected category and status filters");
    assert.ok(
      feedbackGets.some(get => get.clientId === String(CLIENT_A) && get.category === "bug" && get.status === "new"),
      "the category/status filters must be sent to the list API",
    );

    await page.getByTestId("filter-status").click();
    await page.getByRole("option", { name: "All statuses", exact: true }).click();
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    await page.getByTestId("text-feedback-summary").getByText(reportForClientA.summary).waitFor();
    assert.equal(await page.getByTestId("text-feedback-details").innerText(), reportForClientA.details);
    assert.equal(await page.getByTestId("text-feedback-path").innerText(), "/settings/billing");
    await page.getByTestId("panel-feedback-detail").getByText("Mira Chen", { exact: true }).waitFor();

    await page.getByTestId("select-feedback-status").click();
    await page.getByRole("option", { name: "Reviewing", exact: true }).click();
    const savedNote = "Confirmed the billing flow; engineering is reviewing the report.";
    await page.getByTestId("input-feedback-note").fill(savedNote);
    const firstPatch = page.waitForResponse(response =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/feedback/${REPORT_ID}`,
    );
    const heldList = { started: deferred(), resume: deferred() };
    nextHeldFeedbackList = heldList;
    const firstRefresh = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "bug" && !params.has("status"),
    ));
    await page.getByTestId("button-save-feedback").click();
    assert.equal((await firstPatch).status(), 200, "review status and internal note should save successfully");
    await heldList.started.promise;
    await page.getByText("Select a report to read it in full.").waitFor();
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    assert.equal(await page.getByTestId("select-feedback-status").innerText(), "Reviewing");
    assert.equal(
      await page.getByTestId("input-feedback-note").inputValue(),
      savedNote,
      "reopening before the delayed list refetch completes must use the just-saved note",
    );
    heldList.resume.resolve();
    await firstRefresh;
    assert.deepEqual(feedbackMutations.at(-1).body, { expectedRevision: 0, status: "reviewing", internalNote: savedNote });
    assert.equal(feedbackMutations.at(-1).clientId, String(CLIENT_A));
    await page.getByTestId("button-close-feedback").click();
    await page.getByText("Select a report to read it in full.").waitFor();

    // Reopen the refreshed row, close the panel, and verify persisted values again.
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    assert.equal(await page.getByTestId("select-feedback-status").innerText(), "Reviewing");
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), savedNote);
    await page.getByTestId("button-close-feedback").click();
    await page.getByText("Select a report to read it in full.").waitFor();
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    assert.equal(await page.getByTestId("select-feedback-status").innerText(), "Reviewing");
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), savedNote);

    // Resolve the report and persist an explicitly cleared internal note.
    await page.getByTestId("select-feedback-status").click();
    await page.getByRole("option", { name: "Resolved", exact: true }).click();
    await page.getByTestId("input-feedback-note").fill("");
    const resolvePatch = page.waitForResponse(response =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/feedback/${REPORT_ID}`,
    );
    const resolveRefresh = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "bug" && !params.has("status"),
    ));
    await page.getByTestId("button-save-feedback").click();
    assert.equal((await resolvePatch).status(), 200);
    await resolveRefresh;
    assert.deepEqual(feedbackMutations.at(-1).body, { expectedRevision: 1, status: "resolved", internalNote: "" });
    assert.equal(reportForClientA.status, "resolved");
    assert.equal(reportForClientA.internalNote, "");
    await page.getByText("Select a report to read it in full.").waitFor();

    // Failed save must keep the edited values and make the same draft retryable.
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    await page.getByTestId("select-feedback-status").click();
    await page.getByRole("option", { name: "Reviewing", exact: true }).click();
    const retryNote = "Retry this unchanged draft after a temporary failure.";
    await page.getByTestId("input-feedback-note").fill(retryNote);
    nextSaveFailure = true;
    const failedPatch = page.waitForResponse(response =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/feedback/${REPORT_ID}`,
    );
    await page.getByTestId("button-save-feedback").click();
    assert.equal((await failedPatch).status(), 503);
    await page.getByTestId("error-feedback-save").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("select-feedback-status").innerText(), "Reviewing");
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), retryNote);
    await page.getByRole("button", { name: "Retry save", exact: true }).waitFor({ state: "visible" });
    const retriedPatch = page.waitForResponse(response =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/feedback/${REPORT_ID}`,
    );
    const retryRefresh = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "bug" && !params.has("status"),
    ));
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    assert.equal((await retriedPatch).status(), 200);
    await retryRefresh;
    assert.deepEqual(feedbackMutations.at(-1).body, { expectedRevision: 2, status: "reviewing", internalNote: retryNote });
    await page.getByText("Select a report to read it in full.").waitFor();

    assert.deepEqual(
      feedbackMutations.slice(-2).map(mutation => mutation.body),
      [
        { expectedRevision: 2, status: "reviewing", internalNote: retryNote },
        { expectedRevision: 2, status: "reviewing", internalNote: retryNote },
      ],
      "the failed save and its retry send the same draft and revision",
    );

    // Review history: the detail panel lists each accepted change, newest first, with its actor.
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    await page.getByTestId("history-entry-3").waitFor({ state: "visible" });
    assert.deepEqual(
      await page.getByTestId("list-feedback-history").locator("li").evaluateAll(items => items.map(item => item.dataset.testid)),
      ["history-entry-3", "history-entry-2", "history-entry-1"],
    );
    assert.equal(await page.getByTestId("history-entry-3").getByTestId("text-history-actor").innerText(), TEST_USER_NAME);
    assert.equal(await page.getByTestId("history-entry-3").getByTestId("text-history-status").innerText(), "Resolved → Reviewing");
    assert.equal(await page.getByTestId("history-entry-3").getByTestId("text-history-note").innerText(), retryNote);
    assert.equal(await page.getByTestId("history-entry-2").getByTestId("text-history-note").innerText(), "Note cleared");
    assert.equal(await page.getByTestId("history-entry-1").getByTestId("text-history-note").innerText(), savedNote);
    assert.ok(historyGets.every(get => get.clientId === String(CLIENT_A)), "history reads use the active client");

    // A background refresh that brings another manager's save keeps the dirty
    // draft and offers the saved version; "Use saved version" adopts it.
    const refreshDraft = "Draft that a refresh must not erase.";
    await page.getByTestId("input-feedback-note").fill(refreshDraft);
    otherManagerSaves(reportForClientA, "resolved", "Priya: fixed in the September release.");
    const manualRefresh = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "bug",
    ));
    await page.getByTestId("button-refresh-feedback").click();
    await manualRefresh;
    await page.getByTestId("panel-feedback-conflict").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), refreshDraft, "refresh keeps the unsaved note");
    assert.equal(await page.getByTestId("select-feedback-status").innerText(), "Reviewing");
    assert.equal(await page.getByTestId("text-conflict-saved-note").innerText(), "Priya: fixed in the September release.");
    assert.equal(await page.getByTestId("text-conflict-saved-status").innerText(), "Resolved");
    assert.match(await page.getByTestId("panel-feedback-conflict").innerText(), /Priya Patel saved a newer version/);
    assert.equal(await page.getByTestId("button-save-feedback").isDisabled(), true, "a superseded draft cannot be saved blindly");
    await page.getByTestId("history-entry-4").getByText("Priya Patel", { exact: true }).waitFor();
    await page.getByTestId("button-conflict-use-saved").click();
    assert.equal(await page.getByTestId("panel-feedback-conflict").count(), 0);
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), "Priya: fixed in the September release.");
    assert.equal(await page.getByTestId("select-feedback-status").innerText(), "Resolved");
    assert.equal(await page.getByTestId("button-save-feedback").isDisabled(), true, "the adopted version is not a change");

    // Interleaved saves: this manager's draft is based on revision 4 while the
    // other manager saves revision 5. The save gets 409, the draft survives,
    // and keeping it re-saves deliberately against the latest revision.
    const conflictDraft = "Reopening: the customer still sees the issue on mobile.";
    await page.getByTestId("select-feedback-status").click();
    await page.getByRole("option", { name: "Reviewing", exact: true }).click();
    await page.getByTestId("input-feedback-note").fill(conflictDraft);
    otherManagerSaves(reportForClientA, "resolved", "Priya: confirmed fixed with the customer.");
    const mutationsBeforeConflict = feedbackMutations.length;
    const conflictPatch = page.waitForResponse(response =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/feedback/${REPORT_ID}`,
    );
    await page.getByTestId("button-save-feedback").click();
    assert.equal((await conflictPatch).status(), 409);
    assert.deepEqual(feedbackMutations.at(-1).body, { expectedRevision: 4, status: "reviewing", internalNote: conflictDraft });
    await page.getByTestId("panel-feedback-conflict").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), conflictDraft, "the unsaved note is preserved after 409");
    assert.equal(await page.getByTestId("select-feedback-status").innerText(), "Reviewing");
    assert.equal(await page.getByTestId("text-conflict-saved-note").innerText(), "Priya: confirmed fixed with the customer.");
    assert.equal(reportForClientA.internalNote, "Priya: confirmed fixed with the customer.", "the other manager's save was not overwritten");
    assert.equal(await page.getByTestId("button-save-feedback").isDisabled(), true);
    await page.getByTestId("button-conflict-keep-draft").click();
    assert.equal(await page.getByTestId("panel-feedback-conflict").count(), 0);
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), conflictDraft);
    const keptPatch = page.waitForResponse(response =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/feedback/${REPORT_ID}`,
    );
    await page.getByTestId("button-save-feedback").click();
    assert.equal((await keptPatch).status(), 200);
    assert.deepEqual(feedbackMutations.at(-1).body, { expectedRevision: 5, status: "reviewing", internalNote: conflictDraft });
    assert.equal(feedbackMutations.length, mutationsBeforeConflict + 2);
    await page.getByText("Select a report to read it in full.").waitFor();
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    await page.getByTestId("history-entry-6").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("history-entry-6").getByTestId("text-history-actor").innerText(), TEST_USER_NAME);
    assert.equal(await page.getByTestId("history-entry-5").getByTestId("text-history-actor").innerText(), "Priya Patel");
    assert.equal(await page.getByTestId("input-feedback-note").inputValue(), conflictDraft);
    await page.getByTestId("button-close-feedback").click();
    await page.getByText("Select a report to read it in full.").waitFor();

    // A real filter with no matches renders the empty-state feedback.
    filteredGet = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "feature",
    ));
    await page.getByTestId("filter-category").click();
    await page.getByRole("option", { name: "Feature request", exact: true }).click();
    await filteredGet;
    await page.getByTestId("empty-feedback").waitFor({ state: "visible" });
    assert.match(await page.getByTestId("empty-feedback").innerText(), /No reports match these filters/);

    // Keep the failure active through React Query's automatic retries, then use
    // the rendered retry button to prove a fresh list fetch recovers.
    listUnavailable = true;
    filteredGet = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && !params.has("category"),
    ));
    await page.getByTestId("filter-category").click();
    await page.getByRole("option", { name: "All categories", exact: true }).click();
    await filteredGet;
    await page.getByTestId("error-feedback").waitFor({ state: "visible" });
    assert.match(await page.getByTestId("error-feedback").innerText(), /temporarily unavailable/);
    listUnavailable = false;
    const listRetry = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && !params.has("category"),
    ));
    await page.getByTestId("button-retry-feedback").click();
    assert.equal((await listRetry).status(), 200);
    await page.getByTestId(`row-feedback-${REPORT_ID}`).waitFor({ state: "visible" });

    // The consultant's real Clients screen changes the active tenant. Returning
    // to the inbox must query that tenant with clean filters and no stale draft.
    currentRole = "consultant";
    await page.goto(`${baseUrl}/feedback`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Feedback inbox", exact: true }).waitFor({ state: "visible" });
    await page.getByTestId(`row-feedback-${REPORT_ID}`).waitFor({ state: "visible" });
    filteredGet = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_A) && params.get("category") === "bug",
    ));
    await page.getByTestId("filter-category").click();
    await page.getByRole("option", { name: "Bug", exact: true }).click();
    await filteredGet;
    await page.getByTestId(`row-feedback-${REPORT_ID}`).click();
    await page.getByTestId("select-feedback-status").click();
    await page.getByRole("option", { name: "Resolved", exact: true }).click();
    await page.getByTestId("input-feedback-note").fill("Discard this unsaved note on tenant switch.");
    await page.getByRole("link", { name: "Clients", exact: true }).click();
    await page.getByRole("heading", { name: "Second Switch Client", exact: true }).waitFor({ state: "visible" });
    const clientCard = page.getByRole("heading", { name: "Second Switch Client", exact: true }).locator("xpath=../../..");
    await clientCard.getByRole("button", { name: "View", exact: true }).click();
    const clientBInbox = page.waitForResponse(getFeedbackResponse(params =>
      params.get("clientId") === String(CLIENT_B),
    ));
    await page.getByRole("button", { name: "Administration" }).click();
    await page.getByRole("link", { name: "Feedback inbox", exact: true }).click();
    response = await clientBInbox;
    assert.equal(response.status(), 200, "consultant client switching must refetch the active client's inbox");
    await page.getByTestId("row-feedback-4301").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("filter-category").innerText(), "All categories");
    assert.equal(await page.getByTestId("filter-status").innerText(), "All statuses");
    await page.getByText("Select a report to read it in full.").waitFor();
    assert.equal(await page.getByTestId(`row-feedback-${REPORT_ID}`).count(), 0);

    // Both staff and viewer users have no inbox navigation or route, and direct
    // navigation to either the list or a report never issues a feedback read.
    for (const role of ["client_staff", "client_viewer"]) {
      currentRole = role;
      const getsBefore = feedbackGets.length;
      await page.goto(`${baseUrl}/feedback`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: /not found/i }).waitFor({ state: "visible" }).catch(() => {});
      assert.equal(await page.getByRole("link", { name: "Feedback inbox", exact: true }).count(), 0, `${role} must not see the feedback navigation item`);
      assert.equal(feedbackGets.length, getsBefore, `${role} direct navigation must not request the inbox list`);
      assert.equal(await page.getByTestId(`row-feedback-${REPORT_ID}`).count(), 0);
      await page.goto(`${baseUrl}/feedback/${REPORT_ID}`, { waitUntil: "domcontentloaded" });
      assert.equal(await page.getByRole("link", { name: "Feedback inbox", exact: true }).count(), 0);
      assert.equal(feedbackGets.length, getsBefore, `${role} direct report route must not issue a report read`);
      assert.equal(await page.getByTestId("text-feedback-details").count(), 0);
    }

    assert.ok(csrfTokenRequests > 0, "the real API client must bootstrap a CSRF token before mutation");
    assert.ok(feedbackMutations.length >= 4, "the browser should exercise successful, resolve, failed, and retried mutations");
    assert.ok(csrfHeaders.every(({ token }) => token === CSRF_TOKEN), "feedback PATCH requests must carry the bootstrapped CSRF token");
    assert.ok(
      feedbackGets.some(get => get.clientId === String(CLIENT_B) && get.role === "consultant"),
      "the consultant switch must use the selected client id rather than the original tenant",
    );
    assert.deepEqual(deniedFeedbackRequests, [], "non-admin direct routes must never attempt protected feedback API calls");
    assert.deepEqual(unexpectedApiRequests, [], `unexpected API requests must fail this browser test: ${JSON.stringify(unexpectedApiRequests)}`);
    assert.deepEqual(pageErrors, [], `the real app must not throw frontend exceptions: ${pageErrors.join("; ")}`);
    assert.deepEqual(consoleErrors, [], `the real app must not report frontend console errors: ${consoleErrors.join("; ")}`);
    assert.ok(historyGets.every(get => ["consultant", "client_admin"].includes(get.role)), "only administrators read review history");
    console.log("Feedback inbox browser regression checks passed: admin access, filtering, persisted edits, retry/error/empty states, stale-draft conflicts, review history, tenant switching, and staff/viewer denial.");
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error("Feedback inbox browser test failed:", error);
  if (viteLogs) console.error("Vite server logs:\n", viteLogs.slice(-12000));
  throw error;
} finally {
  if (vite.exitCode === null) {
    vite.kill("SIGTERM");
    await new Promise(resolve => {
      const forceKill = setTimeout(() => {
        if (vite.exitCode === null) vite.kill("SIGKILL");
        resolve();
      }, 3000);
      vite.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  }
}