// Focused regression coverage for the FixTrack contractor-email approval gate.
// Usage: node tests/fix-track-contractor-approval.mjs (with the API running).
//
// This deliberately never calls the post-approval dispatch endpoint: its
// purpose is to prove that a pending request cannot cross the outbound boundary.
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const execFile = promisify(execFileCallback);
const today = new Date().toISOString().slice(0, 10);
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

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
  const email = `fix-email-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: `${label} manager`, email, password: "password-123",
  });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  if (!registered.data?.verificationToken) throw new Error(`${label}: registration returned no verification token`);
  check(`${label}: verify`, (await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
  check(`${label}: login`, (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return request;
}

async function contractorIssue(request, suffix, targetDate) {
  const contractor = await request("POST", "/contractors", {
    name: `Email contractor ${suffix}`, email: `contractor-${suffix}@test.local`,
  });
  check(`${suffix}: create contractor`, contractor.status === 201, String(contractor.status));
  const issue = await request("POST", "/fix-track/issues", {
    title: `Approval-gated work ${suffix}`,
    issueType: "general",
    location: "Plant room",
    reportedBy: "Facilities",
    reportedDate: today,
    contractorId: contractor.data?.id,
    ...(targetDate ? { targetDate } : {}),
  });
  check(`${suffix}: create issue`, issue.status === 201, String(issue.status));
  return issue.data?.id;
}

async function userSession(owner, label, role, clientId) {
  const email = `fix-email-${label}-${Date.now()}-${Math.random()}@test.local`;
  const created = await owner("POST", "/users", {
    name: `${label} user`, email, password: "password-123", role, clientId,
  });
  check(`${label}: create ${role}`, created.status === 201, String(created.status));
  const request = session();
  check(`${label}: login`, (await request("POST", "/auth/login", {
    email, password: "password-123",
  })).status === 200);
  return request;
}

async function main() {
  if (!process.env.FIXTRACK_TEST_EMAIL_OUTBOX) {
    throw new Error("FIXTRACK_TEST_EMAIL_OUTBOX must be set by the self-booting test runner");
  }
  await writeFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "");
  const owner = await tenant("owner");
  const foreign = await tenant("foreign");
  const ownerMe = await owner("GET", "/auth/me");
  const ownerClientId = ownerMe.data?.user?.clientId ?? ownerMe.data?.client?.id;
  const staff = await userSession(owner, "staff", "client_staff", ownerClientId);
  const viewer = await userSession(owner, "viewer", "client_viewer", ownerClientId);
  const quoteId = await contractorIssue(owner, "quote");
  const quoteContractor = (await owner("GET", `/fix-track/issues/${quoteId}`)).data?.contractorId;

  check("legacy direct reminder endpoint is retired",
    (await owner("POST", `/contractors/${quoteContractor}/send-reminder`)).status === 410);
  check("legacy reminder sends nothing",
    (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8")).trim() === "");

  check("quote request is queued, not sent",
    (await owner("POST", `/fix-track/issues/${quoteId}/request-send`, { mode: "quote" })).status === 200);
  check("non-manager cannot approve quote",
    (await staff("POST", `/fix-track/issues/${quoteId}/approve-send`)).status === 403);
  check("non-manager cannot send quote",
    (await staff("POST", `/fix-track/issues/${quoteId}/send-to-contractor`)).status === 403);
  check("viewer cannot request a contractor quote",
    (await viewer("POST", `/fix-track/issues/${quoteId}/request-send`, { mode: "quote" })).status === 403);
  const blocked = await owner("POST", `/fix-track/issues/${quoteId}/send-to-contractor`);
  check("no contractor send before approval", blocked.status === 403, `${blocked.status}: ${blocked.data?.error}`);

  const approved = await owner("POST", `/fix-track/issues/${quoteId}/approve-send`);
  check("manager explicitly approves quote", approved.status === 200 && approved.data?.mode === "quote", JSON.stringify(approved.data));
  check("duplicate approval is idempotently rejected",
    (await owner("POST", `/fix-track/issues/${quoteId}/approve-send`)).status === 409);
  const quote = await owner("GET", `/fix-track/issues/${quoteId}`);
  check("quote state records approval without sending",
    quote.status === 200 &&
      quote.data?.emailRequestMode === "quote" &&
      quote.data?.emailRequestStatus === "approved" &&
      quote.data?.emailApprovedBy != null &&
      quote.data?.emailSentAt == null,
    JSON.stringify(quote.data));

  // Editing email-rendered work after approval must atomically put the request
  // back into review. This is the same protection used when the contractor or
  // target date changes.
  const changed = await owner("PUT", `/fix-track/issues/${quoteId}`, {
    title: "Approval-gated work quote (revised scope)",
    targetDate: "2030-01-15",
  });
  check("approved content mutation invalidates approval", changed.status === 200 &&
    changed.data?.emailRequestStatus === "pending" &&
    changed.data?.emailApprovedBy == null &&
    changed.data?.emailApprovedAt == null, JSON.stringify(changed.data));
  check("changed pending request still cannot dispatch",
    (await owner("POST", `/fix-track/issues/${quoteId}/send-to-contractor`)).status === 403);
  const reapproved = await owner("POST", `/fix-track/issues/${quoteId}/approve-send`);
  check("manager must and can reapprove revised content",
    reapproved.status === 200 && reapproved.data?.mode === "quote", JSON.stringify(reapproved.data));
  const concurrentDispatch = await Promise.all([
    owner("POST", `/fix-track/issues/${quoteId}/send-to-contractor`),
    owner("POST", `/fix-track/issues/${quoteId}/send-to-contractor`),
  ]);
  check("exactly one concurrent approved dispatch succeeds",
    concurrentDispatch.filter((result) => result.status === 200).length === 1,
    JSON.stringify(concurrentDispatch));
  const sentQuote = await owner("GET", `/fix-track/issues/${quoteId}`);
  check("actual fake-boundary dispatch records the sending manager",
    sentQuote.data?.emailRequestStatus === "sent" &&
      sentQuote.data?.emailSentBy != null &&
      sentQuote.data?.emailSentAt != null,
    JSON.stringify(sentQuote.data));
  const outbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8")).trim().split("\n").filter(Boolean);
  check("concurrent dispatch produces one provider submission", outbox.length === 1, JSON.stringify(outbox));
  check("quote dispatch content remains a quote, not assignment",
    outbox[0]?.includes("QUOTE REQUEST") && outbox[0]?.includes("job has not been assigned"));
  const sentQuoteMessage = JSON.parse(outbox[0]);
  const quoteTokenMatch = sentQuoteMessage.html?.match(/\/contractor-quote\/([a-f0-9]{64})/);
  check("quote email contains a high-entropy submission link", !!quoteTokenMatch);
  if (quoteTokenMatch) {
    const quotePage = await fetch(`${BASE}/fix-track/quotes/public/${quoteTokenMatch[1]}`);
    check("hashed quote token resolves before submission", quotePage.status === 200, String(quotePage.status));
    const submittedQuote = await fetch(`${BASE}/fix-track/quotes/public/${quoteTokenMatch[1]}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poundsPrice: 1250, notes: "Route-level one-time submission check" }),
    });
    check("contractor can submit a quote once", submittedQuote.status === 201, String(submittedQuote.status));
    const repeatedQuote = await fetch(`${BASE}/fix-track/quotes/public/${quoteTokenMatch[1]}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poundsPrice: 1250 }),
    });
    check("quote submission link cannot create a second quote", repeatedQuote.status === 409, String(repeatedQuote.status));
  }
  const publicRoute = await readFile(new URL("../src/routes/fix-track-public.ts", import.meta.url), "utf8");
  const notifications = await readFile(new URL("../src/lib/fixTrackNotifications.ts", import.meta.url), "utf8");
  check("quote and action credentials use digests for lookup/storage",
    publicRoute.includes("quote_token_hash") && publicRoute.includes("token_hash") &&
    notifications.includes("token_hash") && notifications.includes("digestBearerToken"));

  const assignId = await contractorIssue(owner, "assign");
  check("assignment request is queued",
    (await owner("POST", `/fix-track/issues/${assignId}/request-send`, { mode: "assign" })).status === 200);
  const assignment = await owner("POST", `/fix-track/issues/${assignId}/approve-send`);
  check("assignment remains distinct approved action",
    assignment.status === 200 && assignment.data?.mode === "assign", JSON.stringify(assignment.data));

  const rejectedId = await contractorIssue(owner, "rejected");
  check("rejection queues assignment request",
    (await owner("POST", `/fix-track/issues/${rejectedId}/request-send`, { mode: "assign" })).status === 200);
  check("manager can reject assignment request",
    (await owner("POST", `/fix-track/issues/${rejectedId}/reject-send`)).status === 200);
  check("rejected request cannot dispatch",
    [403, 409].includes((await owner("POST", `/fix-track/issues/${rejectedId}/send-to-contractor`)).status));
  check("rejected request sent nothing",
    (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8")).trim().split("\n").filter(Boolean).length === 1);

  const retryId = await contractorIssue(owner, "provider-failure");
  check("provider failure test request queues",
    (await owner("POST", `/fix-track/issues/${retryId}/request-send`, { mode: "assign" })).status === 200);
  check("provider failure test approves",
    (await owner("POST", `/fix-track/issues/${retryId}/approve-send`)).status === 200);
  // The test outbox is the provider boundary. Temporarily replace it with a
  // directory so appendFile fails, then restore it for the retry assertion.
  await rm(process.env.FIXTRACK_TEST_EMAIL_OUTBOX);
  await mkdir(process.env.FIXTRACK_TEST_EMAIL_OUTBOX);
  const failedDispatch = await owner("POST", `/fix-track/issues/${retryId}/send-to-contractor`);
  check("provider failure leaves dispatch retryable", failedDispatch.status === 502);
  const retryState = await owner("GET", `/fix-track/issues/${retryId}`);
  check("provider failure restores approved state",
    retryState.data?.emailRequestStatus === "approved", JSON.stringify(retryState.data));
  await rm(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, { recursive: true });
  await writeFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "");
  check("retry after provider failure succeeds",
    (await owner("POST", `/fix-track/issues/${retryId}/send-to-contractor`)).status === 200);
  const retryOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const bookedMatch = retryOutbox[0]?.html?.match(/\/api\/fix-track\/action\/([a-f0-9]{64})/);
  check("assignment without a target date has no calendar attachment",
    retryOutbox[0]?.icsAttachment == null && retryOutbox[0]?.icsFilename == null,
    JSON.stringify(retryOutbox[0]));
  check("assignment email contains a high-entropy contractor action link", !!bookedMatch);
  if (bookedMatch) {
    const firstAction = await fetch(`${BASE}/fix-track/action/${bookedMatch[1]}`);
    check("hashed contractor action token resolves", firstAction.status === 200, String(firstAction.status));
    const repeatedAction = await fetch(`${BASE}/fix-track/action/${bookedMatch[1]}`);
    check("contractor action token remains one-time", repeatedAction.status === 200 &&
      (await repeatedAction.text()).includes("Already recorded"));
  }

  const calendarId = await contractorIssue(owner, "calendar", "2030-02-10");
  check("dated assignment request enters approval queue",
    (await owner("POST", `/fix-track/issues/${calendarId}/request-send`, { mode: "assign" })).status === 200);
  check("manager approves dated assignment",
    (await owner("POST", `/fix-track/issues/${calendarId}/approve-send`)).status === 200);
  check("approved dated assignment dispatches",
    (await owner("POST", `/fix-track/issues/${calendarId}/send-to-contractor`)).status === 200);
  let calendarOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const firstCalendarMessage = calendarOutbox.at(-1);
  const firstCalendarToken = firstCalendarMessage?.html?.match(/\/api\/fix-track\/action\/([a-f0-9]{64})/)?.[1];
  check("dated assignment delivers an all-day ICS attachment",
    firstCalendarMessage?.icsFilename?.endsWith(".ics") &&
      firstCalendarMessage?.icsAttachment?.includes("METHOD:REQUEST") &&
      firstCalendarMessage?.icsAttachment?.includes("DTSTART;VALUE=DATE:20300210") &&
      firstCalendarMessage?.icsAttachment?.includes("DTEND;VALUE=DATE:20300211"),
    JSON.stringify(firstCalendarMessage));
  check("calendar attachment has stable non-secret event identity",
    firstCalendarMessage?.icsAttachment?.includes(`UID:fix-track-${ownerClientId}-${calendarId}@complytrack`) &&
      firstCalendarMessage?.icsAttachment?.includes("SEQUENCE:0") &&
      !firstCalendarMessage?.icsAttachment?.includes("/api/fix-track/action/"),
    firstCalendarMessage?.icsAttachment);

  const directCancellationId = await contractorIssue(owner, "calendar-direct-cancellation", "2030-03-10");
  check("direct cancellation fixture queues its dated assignment",
    (await owner("POST", `/fix-track/issues/${directCancellationId}/request-send`, { mode: "assign" })).status === 200);
  check("direct cancellation fixture approves its assignment",
    (await owner("POST", `/fix-track/issues/${directCancellationId}/approve-send`)).status === 200);
  check("direct cancellation fixture dispatches its assignment",
    (await owner("POST", `/fix-track/issues/${directCancellationId}/send-to-contractor`)).status === 200);
  calendarOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const directAssignmentMessage = calendarOutbox.at(-1);
  check("direct cancellation fixture sends a dated assignment",
    directAssignmentMessage?.icsAttachment?.includes("METHOD:REQUEST") &&
      directAssignmentMessage?.icsAttachment?.includes("DTSTART;VALUE=DATE:20300310"),
    JSON.stringify(directAssignmentMessage));
  check("direct cancellation enters the manager approval queue",
    (await owner("POST", `/fix-track/issues/${directCancellationId}/request-cancellation`)).status === 202);
  const directCancellationQueue = (await owner("GET", "/fix-track/contractor-email-queue")).data?.find(
    (entry) => entry.entityId === directCancellationId && entry.emailType === "cancellation",
  );
  check("unedited cancellation appears in the manager queue",
    !!directCancellationQueue, JSON.stringify(directCancellationQueue));
  const directCancellationApproval = directCancellationQueue
    ? await owner("POST", `/fix-track/contractor-email-queue/${directCancellationQueue.id}/approve-and-send`)
    : { status: 0, data: null };
  check("manager can approve an unedited cancellation",
    directCancellationApproval.status === 200, JSON.stringify(directCancellationApproval));
  calendarOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const directCancellationMessage = calendarOutbox.at(-1);
  check("unedited cancellation keeps its stored subject and removal wording",
    directCancellationMessage?.subject?.startsWith("Cancelled:") &&
      directCancellationMessage?.text?.includes("The attached calendar cancellation removes the previously sent assignment.") &&
      directCancellationMessage?.html?.includes("The attached calendar cancellation removes the previously sent assignment."),
    JSON.stringify(directCancellationMessage));
  check("unedited cancellation keeps the event identity and advances its sequence",
    directCancellationMessage?.icsAttachment?.includes(`UID:fix-track-${ownerClientId}-${directCancellationId}@complytrack`) &&
      directCancellationMessage?.icsAttachment?.includes("METHOD:CANCEL") &&
      directCancellationMessage?.icsAttachment?.includes("STATUS:CANCELLED") &&
      directCancellationMessage?.icsAttachment?.includes("SEQUENCE:1") &&
      directCancellationMessage?.icsAttachment?.includes("DTSTART;VALUE=DATE:20300310"),
    directCancellationMessage?.icsAttachment);
  check("unedited cancellation has no contractor action links",
    !directCancellationMessage?.html?.includes("/api/fix-track/action/") &&
      !directCancellationMessage?.icsAttachment?.includes("/api/fix-track/action/"));

  check("changing a sent assignment target date succeeds",
    (await owner("PUT", `/fix-track/issues/${calendarId}`, { targetDate: "2030-02-12" })).status === 200);
  check("resend still requires explicit force",
    (await owner("POST", `/fix-track/issues/${calendarId}/request-send`, { mode: "assign" })).status === 409);
  const legacyForcedSend = await owner("POST", `/fix-track/issues/${calendarId}/send-to-contractor?force=true`);
  check("legacy forced send cannot bypass renewed manager approval",
    legacyForcedSend.status === 409 && legacyForcedSend.data?.requiresApproval === true,
    JSON.stringify(legacyForcedSend));
  check("force queues the updated assignment for fresh approval",
    (await owner("POST", `/fix-track/issues/${calendarId}/request-send`, { mode: "assign", force: true })).status === 200);
  if (firstCalendarToken) {
    const invalidated = await fetch(`${BASE}/fix-track/action/${firstCalendarToken}`);
    check("forced resend invalidates old contractor action links", invalidated.status === 410, String(invalidated.status));
  } else {
    check("forced resend fixture contains original action token", false);
  }
  check("updated invite still requires manager approval before delivery",
    (await owner("POST", `/fix-track/issues/${calendarId}/send-to-contractor`)).status === 403);
  check("manager approves updated invite",
    (await owner("POST", `/fix-track/issues/${calendarId}/approve-send`)).status === 200);
  check("approved updated invite dispatches",
    (await owner("POST", `/fix-track/issues/${calendarId}/send-to-contractor`)).status === 200);
  calendarOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const updatedCalendarMessage = calendarOutbox.at(-1);
  check("changed-date resend updates the same calendar event",
    updatedCalendarMessage?.icsAttachment?.includes(`UID:fix-track-${ownerClientId}-${calendarId}@complytrack`) &&
      updatedCalendarMessage?.icsAttachment?.includes("SEQUENCE:1") &&
      updatedCalendarMessage?.icsAttachment?.includes("DTSTART;VALUE=DATE:20300212") &&
      !updatedCalendarMessage?.icsAttachment?.includes("DTSTART;VALUE=DATE:20300210"),
    updatedCalendarMessage?.icsAttachment);

  check("calendar cancellation enters the manager approval queue",
    (await owner("POST", `/fix-track/issues/${calendarId}/request-cancellation`)).status === 202);
  const cancellationEdit = await owner("PUT", `/fix-track/issues/${calendarId}`, { targetDate: "2030-02-13" });
  check("pending calendar cancellation rejects contractor-facing edits",
    cancellationEdit.status === 409 &&
      cancellationEdit.data?.error?.includes("calendar cancellation awaits manager approval"),
    JSON.stringify(cancellationEdit));
  const cancellationIssueAfterEdit = await owner("GET", `/fix-track/issues/${calendarId}`);
  check("rejected cancellation edit leaves the calendar date unchanged",
    cancellationIssueAfterEdit.data?.targetDate?.slice(0, 10) === "2030-02-12",
    JSON.stringify(cancellationIssueAfterEdit.data));
  check("non-contractor notes remain editable during cancellation approval",
    (await owner("POST", `/fix-track/issues/${calendarId}/notes`, {
      note: "Internal cancellation review note",
    })).status === 200);
  check("queued calendar cancellation cannot be deleted before delivery",
    (await owner("DELETE", `/fix-track/issues/${calendarId}`)).status === 409);
  const repeatedCancellation = await owner("POST", `/fix-track/issues/${calendarId}/request-cancellation`);
  check("repeated cancellation requests are idempotent",
    repeatedCancellation.status === 409, JSON.stringify(repeatedCancellation));
  check("calendar cancellation cannot bypass manager approval",
    (await owner("POST", `/fix-track/issues/${calendarId}/send-to-contractor`)).status === 403);

  const pendingQueue = await owner("GET", "/fix-track/contractor-email-queue");
  const cancellationQueue = pendingQueue.data?.find(
    (entry) => entry.entityId === calendarId && entry.emailType === "cancellation",
  );
  check("calendar cancellation appears in the manager queue",
    !!cancellationQueue, JSON.stringify(pendingQueue.data));
  const editedCancellationDraft = cancellationQueue
    ? await owner("PUT", `/fix-track/contractor-email-queue/${cancellationQueue.id}`, {
        subject: "Routine assignment update",
        bodyHtml: "<p>Please review this update.</p>",
        bodyText: "Please review this update.",
      })
    : { status: 0, data: null };
  check("editing a cancellation draft keeps cancellation subject and notice",
    editedCancellationDraft.status === 200 &&
      editedCancellationDraft.data?.subject?.startsWith("Calendar cancellation:"),
    JSON.stringify(editedCancellationDraft));
  const editedQueue = await owner("GET", "/fix-track/contractor-email-queue");
  const editedCancellationPreview = editedQueue.data?.find(
    (entry) => entry.id === cancellationQueue?.id,
  )?.emailPreviewJson;
  check("saved cancellation preview keeps calendar removal wording",
    editedCancellationPreview?.text?.includes("The attached calendar cancellation removes the previously sent assignment."),
    JSON.stringify(editedCancellationPreview));
  const editedAndSentCancellation = cancellationQueue
    ? await owner("POST", `/fix-track/contractor-email-queue/${cancellationQueue.id}/edit-and-send`, {
        subject: "Maintenance update",
        bodyText: "Please disregard the old appointment details.",
      })
    : { status: 0, data: null };
  check("manager can send an edited cancellation draft",
    editedAndSentCancellation.status === 200 &&
      editedAndSentCancellation.data?.subject?.startsWith("Calendar cancellation:"),
    JSON.stringify(editedAndSentCancellation));
  calendarOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const cancellationMessage = calendarOutbox.at(-1);
  check("edited cancellation outbound body keeps calendar removal wording",
    cancellationMessage?.text?.includes("The attached calendar cancellation removes the previously sent assignment.") &&
      cancellationMessage?.html?.includes("The attached calendar cancellation removes the previously sent assignment."),
    JSON.stringify(cancellationMessage));
  check("calendar cancellation reuses UID and increments sequence",
    cancellationMessage?.icsAttachment?.includes(`UID:fix-track-${ownerClientId}-${calendarId}@complytrack`) &&
      cancellationMessage?.icsAttachment?.includes("METHOD:CANCEL") &&
      cancellationMessage?.icsAttachment?.includes("STATUS:CANCELLED") &&
      cancellationMessage?.icsAttachment?.includes("SEQUENCE:2") &&
      cancellationMessage?.icsAttachment?.includes("DTSTART;VALUE=DATE:20300212"),
    cancellationMessage?.icsAttachment);
  check("calendar cancellation does not contain contractor action links",
    !cancellationMessage?.html?.includes("/api/fix-track/action/") &&
      !cancellationMessage?.icsAttachment?.includes("/api/fix-track/action/"));
  const repeatedSentCancellation = await owner("POST", `/fix-track/issues/${calendarId}/request-cancellation`);
  check("sent calendar cancellation cannot be dispatched twice",
    repeatedSentCancellation.status === 409, JSON.stringify(repeatedSentCancellation));

  const concurrentForcedRequests = await Promise.all([
    owner("POST", `/fix-track/issues/${calendarId}/request-send`, { mode: "assign", force: true }),
    owner("POST", `/fix-track/issues/${calendarId}/request-send`, { mode: "assign", force: true }),
  ]);
  check("concurrent forced resends serialize into review",
    concurrentForcedRequests.every((result) => result.status === 200),
    JSON.stringify(concurrentForcedRequests));
  check("manager approves surviving concurrent resend",
    (await owner("POST", `/fix-track/issues/${calendarId}/approve-send`)).status === 200);
  check("surviving concurrent resend dispatches",
    (await owner("POST", `/fix-track/issues/${calendarId}/send-to-contractor`)).status === 200);
  calendarOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const concurrentToken = calendarOutbox.at(-1)?.html?.match(/\/api\/fix-track\/action\/([a-f0-9]{64})/)?.[1];
  check("surviving concurrent resend keeps its own action tokens active",
    !!concurrentToken && (await fetch(`${BASE}/fix-track/action/${concurrentToken}`)).status === 200);

  const expiredQuoteId = await contractorIssue(owner, "expired-quote");
  check("expired quote test request queues",
    (await owner("POST", `/fix-track/issues/${expiredQuoteId}/request-send`, { mode: "quote" })).status === 200);
  check("expired quote test request approves",
    (await owner("POST", `/fix-track/issues/${expiredQuoteId}/approve-send`)).status === 200);
  check("expired quote test request dispatches",
    (await owner("POST", `/fix-track/issues/${expiredQuoteId}/send-to-contractor`)).status === 200);
  const expiryOutbox = (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const expiredTokenMatch = expiryOutbox.at(-1)?.html?.match(/\/contractor-quote\/([a-f0-9]{64})/);
  check("expiry fixture contains a quote token", !!expiredTokenMatch);
  if (expiredTokenMatch) {
    const tokenHash = createHash("sha256").update(expiredTokenMatch[1]).digest("hex");
    await execFile("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
      `UPDATE contractor_email_queue SET quote_token_expires_at=now()-interval '1 minute' WHERE quote_token_hash='${tokenHash}'`]);
    const expiredGet = await fetch(`${BASE}/fix-track/quotes/public/${expiredTokenMatch[1]}`);
    check("expired quote link cannot be opened", expiredGet.status === 404, String(expiredGet.status));
    const expiredPost = await fetch(`${BASE}/fix-track/quotes/public/${expiredTokenMatch[1]}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poundsPrice: 100 }),
    });
    check("expired quote link cannot submit", expiredPost.status === 404, String(expiredPost.status));
  }

  check("tenant isolation blocks approval",
    [400, 403, 404, 409].includes((await foreign("POST", `/fix-track/issues/${quoteId}/approve-send`)).status));
  check("tenant isolation blocks outbound dispatch",
    [400, 403, 404].includes((await foreign("POST", `/fix-track/issues/${quoteId}/send-to-contractor`)).status));

  // Template assertions make the legally/materially different outcomes explicit
  // without submitting an email to an external provider.
  const templates = await readFile(new URL("../src/lib/fixTrackNotifications.ts", import.meta.url), "utf8");
  const migrations = await readFile(new URL("../src/lib/runtimeMigrations.ts", import.meta.url), "utf8");
  check("new contractor action credentials are stored only as digests",
    templates.includes("(NULL, ${digestBearerToken(bookedToken)}") &&
    templates.includes("(NULL, ${digestBearerToken(completedToken)}"));
  check("public contractor actions look up the digest, not the raw token",
    publicRoute.includes("t.token_hash = ${digestBearerToken(token)}") &&
    !publicRoute.includes("t.token = ${token}"));
  check("legacy contractor action tokens are backfilled then scrubbed",
    migrations.includes("token_hash=${digestBearerToken(row.token)}, token=NULL"));
  check("quote content says it is not an assignment", templates.includes("This is a request for a quote only — the job has not been assigned."));
  check("assignment content contains contractor action links", templates.includes("Mark as Booked") && templates.includes("Mark as Completed"));
  const route = await readFile(new URL("../src/routes/fix-track.ts", import.meta.url), "utf8");
  check("concurrent dispatches may claim only one pending queue row",
    route.includes("WHERE status='pending' AND id=(SELECT id FROM contractor_email_queue"));
  check("edited quote requests preserve the submission link",
    route.includes("decryptTokenPayload(existingDraft.encrypted_token_payload).quote") &&
    route.includes("/contractor-quote/{{QUOTE_TOKEN}}"));
  check("action token lookup binds issue and client",
    publicRoute.includes("fi.id = t.issue_id AND fi.client_id = t.client_id"));
  check("quote token lookup binds issue and client",
    publicRoute.includes("i.id=q.issue_id AND i.client_id=q.client_id"));
  check("quote decisions enforce active department scope",
    route.includes("AND (i.site_id IS NULL OR s.department_id=${deptId})") &&
    route.includes("'fix_track',${q.issue_id},${q.department_id},${q.contractor_id}"));
  check("updates refuse a row already claimed for sending",
    route.includes('current.emailRequestStatus === "sending"'));
  check("signed site documents require matching private tenant ACL",
    route.includes('acl?.visibility !== "private" || acl.owner !== String(clientId)'));
  check("site document query is scoped to the issue tenant and site",
    route.includes("WHERE client_id = ${clientId} AND site_id = ${siteId}"));
  check("issues without a site omit site documents",
    route.includes("if (siteId == null) return [];"));
  check("assignment drafts receive signed site documents",
    route.includes("siteDocumentsForContractorEmail(draft.site_id, clientId)") &&
    route.includes("baseUrl: getPublicAppUrl(), clientId, siteDocuments") &&
    route.includes("previewOnly: true"));
  check("assignment template renders site documents as clickable links",
    templates.includes("📎 Site Documents") &&
    templates.includes('href="${escapeHtml(d.url)}"') &&
    templates.includes("${escapeHtml(d.name)}"));

  console.log(`${passed} FixTrack contractor approval checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });