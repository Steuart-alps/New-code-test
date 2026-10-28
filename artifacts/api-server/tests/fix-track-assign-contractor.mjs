// A manager assigns a FixTrack job to a contractor from the issue and it is
// emailed straight away; the contractor picks a visit date and marks it done
// from the email, and the manager sees both on the issue and the bell.
// Usage: npm run test:fix-track-assign-contractor (boots its own API and database).
import { readFile, writeFile } from "node:fs/promises";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
const today = new Date().toISOString().slice(0, 10);
const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
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
  const email = `fix-assign-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await request("POST", "/auth/register", { name: `${label} owner`, email, password: "password-123" });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  if (!registered.data?.verificationToken) throw new Error(`${label}: registration returned no verification token`);
  check(`${label}: verify`, (await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
  check(`${label}: login`, (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return request;
}

async function userSession(owner, label, role, clientId) {
  const email = `fix-assign-${label}-${Date.now()}-${Math.random()}@test.local`;
  const created = await owner("POST", "/users", { name: `${label} user`, email, password: "password-123", role, clientId });
  check(`${label}: create ${role}`, created.status === 201, String(created.status));
  const request = session();
  check(`${label}: login`, (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  return request;
}

async function newIssue(request, title) {
  const issue = await request("POST", "/fix-track/issues", {
    title, issueType: "general", location: "Boiler room", reportedBy: "Facilities", reportedDate: today,
  });
  check(`${title}: create issue`, issue.status === 201, String(issue.status));
  return issue.data?.id;
}

const outboxLines = async () => (await readFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const actionTokens = (html) => [...String(html ?? "").matchAll(/\/api\/fix-track\/action\/([A-Za-z0-9-]{32,})/g)].map((m) => m[1]);

async function main() {
  if (!process.env.FIXTRACK_TEST_EMAIL_OUTBOX) {
    throw new Error("FIXTRACK_TEST_EMAIL_OUTBOX must be set by the self-booting test runner");
  }
  await writeFile(process.env.FIXTRACK_TEST_EMAIL_OUTBOX, "");
  const owner = await tenant("owner");
  const foreign = await tenant("foreign");
  const ownerMe = await owner("GET", "/auth/me");
  const clientId = ownerMe.data?.user?.clientId ?? ownerMe.data?.client?.id;
  const staff = await userSession(owner, "staff", "client_staff", clientId);
  const viewer = await userSession(owner, "viewer", "client_viewer", clientId);

  const plumber = await owner("POST", "/contractors", { name: "Pat Plumber", email: "pat-plumber@test.local" });
  check("create contractor", plumber.status === 201, String(plumber.status));
  const foreignContractor = await foreign("POST", "/contractors", { name: "Other business", email: "other@test.local" });
  const issueId = await newIssue(owner, "Leaking radiator");

  // Who may assign directly
  check("staff cannot assign a contractor directly",
    (await staff("POST", `/fix-track/issues/${issueId}/assign-contractor`, { contractorId: plumber.data.id })).status === 403);
  check("viewer cannot assign a contractor",
    (await viewer("POST", `/fix-track/issues/${issueId}/assign-contractor`, { contractorId: plumber.data.id })).status === 403);
  check("another business's contractor is refused",
    (await owner("POST", `/fix-track/issues/${issueId}/assign-contractor`, { contractorId: foreignContractor.data?.id })).status === 400);
  check("another business cannot assign this issue",
    (await foreign("POST", `/fix-track/issues/${issueId}/assign-contractor`, { contractorId: foreignContractor.data?.id })).status === 404);
  check("a contractor or a new one is required",
    (await owner("POST", `/fix-track/issues/${issueId}/assign-contractor`, {})).status === 400);
  check("nothing was emailed by refused requests", (await outboxLines()).length === 0);

  // Manager assigns: emailed straight away, nothing left waiting for approval
  const target = inDays(10);
  const assigned = await owner("POST", `/fix-track/issues/${issueId}/assign-contractor`, { contractorId: plumber.data.id, targetDate: target });
  check("manager assigns and the job is emailed", assigned.status === 200 && assigned.data?.contractorName === "Pat Plumber",
    `${assigned.status}: ${JSON.stringify(assigned.data)}`);
  let sent = await outboxLines();
  check("one job email to the contractor", sent.length === 1 && sent[0].to === "pat-plumber@test.local", JSON.stringify(sent.map((m) => m.to)));
  check("job email has a visit-date link and a done link",
    sent[0]?.html?.includes("Pick a visit date") && sent[0]?.html?.includes("Job done") && actionTokens(sent[0]?.html).length === 2);
  check("job email says when it is needed by", sent[0]?.html?.includes("Needed by"));
  check("job email carries a calendar invite for the target date", String(sent[0]?.icsAttachment ?? "").includes(target.replaceAll("-", "")));
  let issue = (await owner("GET", `/fix-track/issues/${issueId}`)).data;
  check("issue shows the contractor and the email as sent",
    issue?.contractorId === plumber.data.id && issue?.emailRequestStatus === "sent" && issue?.emailRequestMode === "assign"
      && issue?.emailSentAt != null && issue?.targetDate?.slice(0, 10) === target, JSON.stringify(issue));
  check("issue history records the assignment",
    issue?.notes?.some((n) => n.note?.startsWith("Assigned to contractor Pat Plumber")));
  const queue = (await owner("GET", "/fix-track/contractor-email-queue")).data ?? [];
  check("nothing waits in Contractor Approvals", !queue.some((q) => q.entityType === "fix_track" && q.entityId === issueId), JSON.stringify(queue));

  // Re-assigning needs confirmation
  const again = await owner("POST", `/fix-track/issues/${issueId}/assign-contractor`, { contractorId: plumber.data.id });
  check("re-assigning a sent job asks for confirmation", again.status === 409 && again.data?.alreadySent === true
    && again.data?.contractorName === "Pat Plumber", JSON.stringify(again.data));
  check("no second email without confirmation", (await outboxLines()).length === 1);

  // Replace with a new contractor added from FixTrack
  const [oldBooked] = actionTokens(sent[0].html);
  const replaced = await owner("POST", `/fix-track/issues/${issueId}/assign-contractor`, {
    newContractor: { name: "Hannah Heating", company: "Hannah Heating Ltd", email: "hannah@test.local", phone: "01234 567890" },
    replace: true,
  });
  check("manager adds a new contractor and gives them the job", replaced.status === 200 && replaced.data?.contractorName === "Hannah Heating",
    `${replaced.status}: ${JSON.stringify(replaced.data)}`);
  const contractors = (await owner("GET", "/contractors")).data ?? [];
  const hannah = contractors.find((c) => c.email === "hannah@test.local");
  check("new contractor is on the Contractors list", !!hannah && hannah.company === "Hannah Heating Ltd" && hannah.phone === "01234 567890");
  check("new contractor gets the job's trade", Array.isArray(hannah?.trades) && hannah.trades.includes("general"), JSON.stringify(hannah?.trades));
  sent = await outboxLines();
  check("the new contractor is emailed", sent.length === 2 && sent[1].to === "hannah@test.local");
  check("the first contractor's links stop working", (await fetch(`${BASE}/fix-track/action/${oldBooked}`)).status === 404);
  check("new contractor with a bad email is refused",
    (await owner("POST", `/fix-track/issues/${issueId}/assign-contractor`, { newContractor: { name: "No email", email: "not-an-email" }, replace: true })).status === 400);

  // Contractor picks a visit date
  const [booked, completed] = actionTokens(sent[1].html);
  const page = await fetch(`${BASE}/fix-track/action/${booked}`);
  const pageHtml = await page.text();
  check("visit-date page opens without changing anything", page.status === 200 && pageHtml.includes("Pick your visit date") && pageHtml.includes('type="date"'));
  check("issue is unchanged by opening the page", (await owner("GET", `/fix-track/issues/${issueId}`)).data?.status === "reported");
  const past = await fetch(`${BASE}/fix-track/action/${booked}/booked`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visitDate: inDays(-5) }),
  });
  // The record-lock rule (423) or the route itself (400) refuses it.
  check("a visit date in the past is refused", [400, 423].includes(past.status), String(past.status));
  const visit = inDays(3);
  const picked = await fetch(`${BASE}/fix-track/action/${booked}/booked`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visitDate: visit }),
  });
  check("contractor picks a visit date", picked.status === 200, `${picked.status}: ${await picked.text()}`);
  issue = (await owner("GET", `/fix-track/issues/${issueId}`)).data;
  check("issue shows the visit date and is in progress",
    issue?.contractorVisitDate?.slice(0, 10) === visit && issue?.status === "in_progress", JSON.stringify(issue));
  check("issue history records the visit date", issue?.notes?.some((n) => n.note?.startsWith("Visit date picked by Hannah Heating")));
  let bell = (await owner("GET", "/notifications")).data?.notifications ?? [];
  check("the manager who sent the job gets a bell notice", bell.some((n) => n.kind === "fixtrack_contractor_booked" && n.linkPath === `/fix-track/${issueId}`), JSON.stringify(bell));
  const staffBell = (await staff("GET", "/notifications")).data?.notifications ?? [];
  check("nobody else is notified", !staffBell.some((n) => String(n.kind).startsWith("fixtrack_contractor")));

  // Contractor marks it done
  const done = await fetch(`${BASE}/fix-track/action/${completed}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: "Valve replaced" }),
  });
  check("contractor marks the job done", done.status === 200, String(done.status));
  issue = (await owner("GET", `/fix-track/issues/${issueId}`)).data;
  check("issue shows when the contractor finished", issue?.status === "resolved" && issue?.contractorCompletedAt != null, JSON.stringify(issue));
  bell = (await owner("GET", "/notifications")).data?.notifications ?? [];
  check("the manager gets a bell notice that the job is done", bell.some((n) => n.kind === "fixtrack_contractor_completed"));
  check("no extra emails are sent for booking or completion", (await outboxLines()).length === 2);
  check("a resolved issue cannot be sent again",
    (await owner("POST", `/fix-track/issues/${issueId}/assign-contractor`, { contractorId: plumber.data.id, replace: true })).status === 409);

  // Older links that post no date still book the job
  const legacyIssue = await newIssue(owner, "Broken door closer");
  check("assign second job", (await owner("POST", `/fix-track/issues/${legacyIssue}/assign-contractor`, { contractorId: plumber.data.id })).status === 200);
  sent = await outboxLines();
  const [legacyBooked, legacyCompleted] = actionTokens(sent.at(-1)?.html);
  const earlyDone = await fetch(`${BASE}/fix-track/action/${legacyCompleted}`);
  check("the done link asks for a visit date first", earlyDone.status === 200 && (await earlyDone.text()).includes("Please pick your visit date first"));
  check("booking without a date still works", (await fetch(`${BASE}/fix-track/action/${legacyBooked}/booked`, { method: "POST" })).status === 200);
  issue = (await owner("GET", `/fix-track/issues/${legacyIssue}`)).data;
  check("no visit date is invented", issue?.status === "in_progress" && issue?.contractorVisitDate == null, JSON.stringify(issue));

  // A manager can ask for a quote the same way (the AI certificate reader does)
  const quoteIssue = await newIssue(owner, "EICR remedial work: 1 × C2");
  const before = (await outboxLines()).length;
  const quoted = await owner("POST", `/fix-track/issues/${quoteIssue}/assign-contractor`, { contractorId: plumber.data.id, mode: "quote" });
  check("manager asks for a quote and it is emailed", quoted.status === 200 && quoted.data?.message === "Quote request emailed to Pat Plumber",
    `${quoted.status}: ${JSON.stringify(quoted.data)}`);
  sent = await outboxLines();
  check("one quote email with a link to send the price and no job links",
    sent.length === before + 1 && sent.at(-1)?.to === "pat-plumber@test.local"
      && /\/contractor-quote\/[A-Za-z0-9-]{32,}/.test(sent.at(-1)?.html ?? "") && actionTokens(sent.at(-1)?.html).length === 0,
    JSON.stringify(sent.at(-1)?.subject));
  issue = (await owner("GET", `/fix-track/issues/${quoteIssue}`)).data;
  check("issue shows the quote request as sent", issue?.emailRequestMode === "quote" && issue?.emailRequestStatus === "sent"
    && issue?.notes?.some((n) => n.note?.startsWith("Quote asked of contractor Pat Plumber")), JSON.stringify(issue));
  check("staff cannot ask for a quote directly",
    (await staff("POST", `/fix-track/issues/${quoteIssue}/assign-contractor`, { contractorId: plumber.data.id, mode: "quote" })).status === 403);
  check("an unknown mode is refused",
    (await owner("POST", `/fix-track/issues/${quoteIssue}/assign-contractor`, { contractorId: plumber.data.id, mode: "bribe" })).status === 400);
  check("the job can follow the quote without confirming a replacement",
    (await owner("POST", `/fix-track/issues/${quoteIssue}/assign-contractor`, { contractorId: plumber.data.id })).status === 200);
  sent = await outboxLines();

  // A quote can go to a contractor added in the same step (the certificate reader with no contractors yet)
  const newQuoteIssue = await newIssue(owner, "EICR remedial work: 1 × C1");
  const newQuote = await owner("POST", `/fix-track/issues/${newQuoteIssue}/assign-contractor`, {
    newContractor: { name: "Sands Electrical", company: "Sands Electrical", email: "sands@test.local" }, mode: "quote",
  });
  check("a quote can be asked of a contractor added in the same step",
    newQuote.status === 200 && newQuote.data?.message === "Quote request emailed to Sands Electrical", `${newQuote.status}: ${JSON.stringify(newQuote.data)}`);
  sent = await outboxLines();
  check("the new contractor gets the quote email", sent.at(-1)?.to === "sands@test.local"
    && /\/contractor-quote\/[A-Za-z0-9-]{32,}/.test(sent.at(-1)?.html ?? ""), JSON.stringify(sent.at(-1)?.to));
  check("and is saved to the Contractors list",
    (await owner("GET", "/contractors")).data?.some?.((c) => c.email === "sands@test.local"));

  // Staff still go through approval
  const staffIssue = await newIssue(owner, "Flickering light");
  check("owner sets a contractor on the staff issue",
    (await owner("PUT", `/fix-track/issues/${staffIssue}`, { contractorId: plumber.data.id })).status === 200);
  check("staff request still waits for approval",
    (await staff("POST", `/fix-track/issues/${staffIssue}/request-send`, { mode: "assign" })).status === 200);
  check("staff request is not emailed", (await outboxLines()).length === sent.length);
  check("a manager's direct assignment approves and sends the waiting request",
    (await owner("POST", `/fix-track/issues/${staffIssue}/assign-contractor`, { contractorId: plumber.data.id })).status === 200);
  check("exactly one email for the staff issue", (await outboxLines()).length === sent.length + 1);
  const leftover = (await owner("GET", "/fix-track/contractor-email-queue")).data ?? [];
  check("the staff request no longer waits", !leftover.some((q) => q.entityType === "fix_track" && q.entityId === staffIssue));

  console.log(`${passed} FixTrack assign-contractor checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
