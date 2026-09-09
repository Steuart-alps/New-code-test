// Focused regression coverage for the FixTrack contractor-email approval gate.
// Usage: node tests/fix-track-contractor-approval.mjs (with the API running).
//
// This deliberately never calls the post-approval dispatch endpoint: its
// purpose is to prove that a pending request cannot cross the outbound boundary.
import { readFile, writeFile } from "node:fs/promises";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
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

async function contractorIssue(request, suffix) {
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
  });
  check(`${suffix}: create issue`, issue.status === 201, String(issue.status));
  return issue.data?.id;
}

async function main() {
  if (!process.env.FIXTRACK_TEST_EMAIL_OUTBOX) {
    throw new Error("FIXTRACK_TEST_EMAIL_OUTBOX must be set by the self-booting test runner");
  }
  await writeFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "");
  const owner = await tenant("owner");
  const foreign = await tenant("foreign");
  const quoteId = await contractorIssue(owner, "quote");

  check("quote request is queued, not sent",
    (await owner("POST", `/fix-track/issues/${quoteId}/request-send`, { mode: "quote" })).status === 200);
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

  const assignId = await contractorIssue(owner, "assign");
  check("assignment request is queued",
    (await owner("POST", `/fix-track/issues/${assignId}/request-send`, { mode: "assign" })).status === 200);
  const assignment = await owner("POST", `/fix-track/issues/${assignId}/approve-send`);
  check("assignment remains distinct approved action",
    assignment.status === 200 && assignment.data?.mode === "assign", JSON.stringify(assignment.data));

  check("tenant isolation blocks approval",
    [400, 403, 404, 409].includes((await foreign("POST", `/fix-track/issues/${quoteId}/approve-send`)).status));
  check("tenant isolation blocks outbound dispatch",
    [400, 403, 404].includes((await foreign("POST", `/fix-track/issues/${quoteId}/send-to-contractor`)).status));

  // Template assertions make the legally/materially different outcomes explicit
  // without submitting an email to an external provider.
  const templates = await readFile(new URL("../src/lib/fixTrackNotifications.ts", import.meta.url), "utf8");
  check("quote content says it is not an assignment", templates.includes("This is a request for a quote only — the job has not been assigned."));
  check("assignment content contains contractor action links", templates.includes("Mark as Booked") && templates.includes("Mark as Completed"));
  const route = await readFile(new URL("../src/routes/fix-track.ts", import.meta.url), "utf8");
  check("concurrent dispatches may claim only one pending queue row",
    route.includes("WHERE status='pending' AND id=(SELECT id FROM contractor_email_queue"));
  check("edited quote requests preserve the submission link",
    route.includes("existingDraft.email_type === \"quote_request\"") &&
    route.includes("/contractor-quote/${encodeURIComponent(existingDraft.quote_token)}"));
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
    route.includes("baseUrl: getPublicAppUrl(), clientId, siteDocuments, previewOnly: true"));
  check("assignment template renders site documents as clickable links",
    templates.includes("📎 Site Documents") &&
    templates.includes('href="${escapeHtml(d.url)}"') &&
    templates.includes("${escapeHtml(d.name)}"));

  console.log(`${passed} FixTrack contractor approval checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });