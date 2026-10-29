// Certificate outcomes, defects and dated completion of compliance checks.
// Run: pnpm --filter @workspace/api-server run test:certificate-outcomes
// (a disposable database built like production: drizzle-kit push, then the
// API's runtime migrations). Also runs against any API_BASE whose database
// you can write to; every fixture is a fresh, uniquely named business.
//  - An unsatisfactory certificate never moves the due date and keeps the
//    check needing action (list, detail, stats, calendar, inspection pack).
//  - Defects open FixTrack jobs with the right priority and target date,
//    scoped to the check's own business.
//  - With remedialJob (the AI certificate reader) the work shares one job and
//    C3s open none.
//  - Resolving the C1/C2 jobs, or adding a newer satisfactory certificate,
//    clears the needs-action state; deleting a certificate recalculates.
//  - Completion takes the date done: a past date sets the next due date, a
//    future date is rejected.
//  - Starter EICR interval: 12 months for leisure centres / pools and holiday
//    parks, 60 for a pub.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required");
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const request = async (method, path, body, raw = false) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    if (raw) return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return request;
}

async function tenant(label, businessType) {
  const request = session();
  const email = `cert-outcomes-${label}-${RUN}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: `${label} Manager`, email, password: "password-123", ...(businessType ? { businessType } : {}),
  });
  if (!registered.data?.verificationToken) throw new Error(`${label}: register failed ${registered.status} ${JSON.stringify(registered.data)}`);
  await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  const loggedIn = await request("POST", "/auth/login", { email, password: "password-123" });
  if (loggedIn.status !== 200) throw new Error(`${label}: login failed ${loggedIn.status}`);
  const me = await request("GET", "/auth/me");
  request.clientId = (me.data?.user ?? me.data)?.clientId ?? me.data?.client?.id;
  return request;
}

const DAY = 86_400_000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const plusMonths = (day, months) => {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
};

async function resolveIssue(owner, issueId) {
  const started = await owner("PUT", `/fix-track/issues/${issueId}`, { status: "in_progress" });
  const resolved = await owner("PUT", `/fix-track/issues/${issueId}`, { status: "resolved", resolverSignature: SIGNATURE, solutionNotes: "Remedial work completed" });
  return started.status === 200 && resolved.status === 200 ? resolved : { status: resolved.status === 200 ? started.status : resolved.status, data: resolved.data };
}

function pdfText(bytes) {
  const dir = mkdtempSync(join(tmpdir(), "cert-outcomes-pack-"));
  try {
    writeFileSync(join(dir, "pack.pdf"), bytes);
    execFileSync("pdftotext", ["-layout", join(dir, "pack.pdf"), join(dir, "pack.txt")]);
    return readFileSync(join(dir, "pack.txt"), "utf8").replace(/\s+/g, " ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function outcomesAndDefects(owner, other) {
  const today = londonToday();
  const dueSoon = plusDays(today, 10);
  const eicr = await owner("POST", "/compliance-items", {
    title: "Electrical Installation Condition Report (EICR)", frequencyMonths: 60,
    dueDate: `${dueSoon}T00:00:00.000Z`,
  });
  const itemId = eicr.data?.id;
  check("setup: EICR check created", eicr.status === 201 && Number.isInteger(itemId), JSON.stringify(eicr.data));
  check("setup: a check without certificates does not need action", eicr.data?.needsAction === false);

  // Unsatisfactory EICR with a five-year expiry and C1/C2/C3 defects.
  const fiveYears = `${plusMonths(today, 60)}T00:00:00.000Z`;
  const cert = await owner("POST", `/items/${itemId}/certificates`, {
    name: "EICR 2026", issueDate: `${today}T09:00:00.000Z`, expiryDate: fiveYears, outcome: "unsatisfactory",
    defects: [
      { code: "C1", description: "Exposed live conductors at kitchen socket", location: "Kitchen" },
      { code: "C2", description: "No RCD protection to socket circuits" },
      { code: "C3", description: "Circuit chart not up to date" },
    ],
  });
  const certId = cert.data?.id;
  check("unsatisfactory: certificate saved with outcome and three defects",
    cert.status === 201 && cert.data?.outcome === "unsatisfactory" && cert.data?.defects?.length === 3, JSON.stringify(cert.data));
  const defects = Object.fromEntries((cert.data?.defects ?? []).map((d) => [d.code, d]));
  check("defects: every defect is linked to a FixTrack job",
    ["C1", "C2", "C3"].every((code) => Number.isInteger(defects[code]?.fixTrackIssueId)), JSON.stringify(cert.data?.defects));
  check("defects: C1/C2 block, C3 does not",
    defects.C1?.blocking === true && defects.C2?.blocking === true && defects.C3?.blocking === false);

  const item = await owner("GET", `/compliance-items/${itemId}`);
  check("unsatisfactory: due date not moved to the certificate expiry",
    item.status === 200 && isoDay(item.data?.dueDate) === dueSoon, JSON.stringify(item.data?.dueDate));
  check("unsatisfactory: item detail needs action with two open defects",
    item.data?.needsAction === true && item.data?.needsActionReason === "unsatisfactory" && item.data?.openDefectCount === 2,
    JSON.stringify(item.data));
  const list = await owner("GET", "/compliance-items");
  check("unsatisfactory: list shows the check needing action",
    list.data?.find((i) => i.id === itemId)?.needsAction === true);
  const stats = await owner("GET", "/dashboard/stats");
  check("unsatisfactory: stats count it as action required and not in date",
    stats.data?.actionRequired === 1 && stats.data?.complianceRate < 100, JSON.stringify(stats.data));
  const cal = await owner("GET", `/calendar?from=${today}&to=${plusDays(today, 30)}`);
  const calEntry = (cal.data?.entries ?? cal.data ?? []).find?.((e) => e.id === `compliance-${itemId}`);
  check("unsatisfactory: calendar shows the check red with the reason",
    calEntry?.status === "overdue" && /Unsatisfactory/.test(calEntry?.detail ?? ""), JSON.stringify(calEntry ?? cal.data));

  let hasPdfText = true;
  try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); } catch { hasPdfText = false; }
  if (hasPdfText) {
    const pack = await owner("GET", `/reports/inspection-pack?from=${plusDays(today, -30)}&to=${today}`, undefined, true);
    const text = pack.status === 200 ? pdfText(pack.bytes) : "";
    check("unsatisfactory: inspection pack lists the check as action required",
      // The status column wraps "Action required" around the certificate note.
      pack.status === 200 && /\(EICR\).{0,120}Action.{0,120}required/.test(text) && text.includes("Unsatisfactory — remedial work open"),
      `${pack.status} ${text.slice(text.indexOf("Compliance checks ("), text.indexOf("Compliance checks (") + 600)}`);
  } else {
    console.log("SKIP: pdftotext not installed; inspection pack text not checked");
  }

  // FixTrack jobs: priority, target date, title, description, site, tenant.
  const issues = {};
  for (const code of ["C1", "C2", "C3"]) issues[code] = (await owner("GET", `/fix-track/issues/${defects[code]?.fixTrackIssueId}`)).data;
  check("fixtrack: C1 job is urgent and due today",
    issues.C1?.priority === "urgent" && String(issues.C1?.targetDate ?? issues.C1?.target_date).slice(0, 10) === today, JSON.stringify(issues.C1));
  check("fixtrack: C2 job is high priority, due in 28 days",
    issues.C2?.priority === "high" && String(issues.C2?.targetDate ?? issues.C2?.target_date).slice(0, 10) === plusDays(today, 28), JSON.stringify(issues.C2));
  check("fixtrack: C3 job is low priority",
    issues.C3?.priority === "low", JSON.stringify(issues.C3));
  check("fixtrack: titled by check and code, described with certificate and check",
    issues.C2?.title === "EICR C2: No RCD protection to socket circuits"
      && /EICR 2026/.test(issues.C2?.description ?? "") && /Electrical Installation Condition Report/.test(issues.C2?.description ?? ""),
    JSON.stringify(issues.C2));
  check("fixtrack: jobs start as reported", issues.C1?.status === "reported");
  check("fixtrack: defect location becomes the job location", issues.C1?.location === "Kitchen", issues.C1?.location);

  // Tenant isolation.
  check("tenant: another business cannot read the certificates",
    (await other("GET", `/items/${itemId}/certificates`)).status === 404);
  check("tenant: another business cannot add a defect",
    (await other("POST", `/items/${itemId}/certificates/${certId}/defects`, { code: "C1", description: "Injected" })).status === 404);
  check("tenant: another business cannot see the FixTrack job",
    (await other("GET", `/fix-track/issues/${defects.C1?.fixTrackIssueId}`)).status === 404);
  const otherIssues = await other("GET", "/fix-track/issues");
  const otherRows = Array.isArray(otherIssues.data) ? otherIssues.data : otherIssues.data?.issues ?? [];
  check("tenant: the job is not in another business's FixTrack list",
    otherIssues.status === 200 && !otherRows.some((i) => i.id === defects.C1?.fixTrackIssueId), JSON.stringify(otherIssues.data).slice(0, 200));
  check("tenant: a client-supplied clientId does not move the certificate",
    (await other("POST", `/items/${itemId}/certificates?clientId=${owner.clientId}`, { name: "Spoof", outcome: "satisfactory" })).status !== 201);

  // A defect with a FixTrack job is closed in FixTrack, not marked remedied here.
  check("defects: a defect with a job cannot be marked remedied directly",
    (await owner("PATCH", `/items/${itemId}/certificates/${certId}/defects/${defects.C1?.id}`, { resolved: true })).status === 409);

  // Resolving one job is not enough; resolving both C1 and C2 clears it.
  const r1 = await resolveIssue(owner, defects.C1?.fixTrackIssueId);
  check("resolve: C1 job resolved", r1.status === 200, JSON.stringify(r1.data));
  const afterOne = await owner("GET", `/compliance-items/${itemId}`);
  check("resolve: still needs action while the C2 job is open",
    afterOne.data?.needsAction === true && afterOne.data?.openDefectCount === 1, JSON.stringify(afterOne.data));
  const r2 = await resolveIssue(owner, defects.C2?.fixTrackIssueId);
  check("resolve: C2 job resolved", r2.status === 200, JSON.stringify(r2.data));
  const cleared = await owner("GET", `/compliance-items/${itemId}`);
  check("resolve: needs-action clears once the C1/C2 jobs are resolved (open C3 does not block)",
    cleared.data?.needsAction === false && cleared.data?.openDefectCount === 0, JSON.stringify(cleared.data));
  check("resolve: stats no longer count it", (await owner("GET", "/dashboard/stats")).data?.actionRequired === 0);
  const certsAfter = await owner("GET", `/items/${itemId}/certificates`);
  const c1After = certsAfter.data?.[0]?.defects?.find((d) => d.code === "C1");
  check("resolve: certificate defects report the job status", c1After?.open === false && c1After?.fixTrackStatus === "resolved", JSON.stringify(c1After));

  // Audit trail on the check.
  const audit = await owner("GET", `/audit-events?entityType=compliance_item&entityId=${itemId}`);
  check("audit: certificate creation recorded on the check",
    (audit.data ?? []).some((e) => e.action === "certificate_added" && e.after?.outcome === "unsatisfactory"), JSON.stringify(audit.data).slice(0, 300));
  return itemId;
}

async function dueDateRules(owner) {
  const today = londonToday();
  const item = await owner("POST", "/compliance-items", { title: "Gas Boilers — Annual Service", frequencyMonths: 12 });
  const itemId = item.data?.id;
  const firstExpiry = plusMonths(today, 12);
  const first = await owner("POST", `/items/${itemId}/certificates`, {
    name: "Gas safety record 2026", issueDate: `${plusDays(today, -20)}T09:00:00.000Z`, expiryDate: `${firstExpiry}T00:00:00.000Z`, outcome: "satisfactory",
  });
  check("satisfactory: certificate saved", first.status === 201, JSON.stringify(first.data));
  let detail = await owner("GET", `/compliance-items/${itemId}`);
  check("satisfactory: due date moves to the certificate expiry", isoDay(detail.data?.dueDate) === firstExpiry, JSON.stringify(detail.data?.dueDate));
  check("satisfactory: does not need action", detail.data?.needsAction === false);

  const bad = await owner("POST", `/items/${itemId}/certificates`, {
    name: "Gas safety record (failed)", issueDate: `${plusDays(today, -5)}T09:00:00.000Z`,
    expiryDate: `${plusMonths(today, 24)}T00:00:00.000Z`, outcome: "unsatisfactory",
  });
  detail = await owner("GET", `/compliance-items/${itemId}`);
  check("unsatisfactory newer certificate: due date unchanged", bad.status === 201 && isoDay(detail.data?.dueDate) === firstExpiry, JSON.stringify(detail.data?.dueDate));
  check("unsatisfactory newer certificate, no defects: needs action (new certificate needed)",
    detail.data?.needsAction === true && detail.data?.needsActionReason === "unsatisfactory" && detail.data?.openDefectCount === 0, JSON.stringify(detail.data));

  const goodExpiry = plusMonths(today, 13);
  const good = await owner("POST", `/items/${itemId}/certificates`, {
    name: "Gas safety record (re-test)", issueDate: `${today}T09:00:00.000Z`, expiryDate: `${goodExpiry}T00:00:00.000Z`, outcome: "satisfactory",
  });
  detail = await owner("GET", `/compliance-items/${itemId}`);
  check("new satisfactory certificate: clears needs-action and moves the due date",
    good.status === 201 && detail.data?.needsAction === false && isoDay(detail.data?.dueDate) === goodExpiry, JSON.stringify(detail.data));

  const removed = await owner("DELETE", `/items/${itemId}/certificates/${good.data?.id}`);
  detail = await owner("GET", `/compliance-items/${itemId}`);
  check("delete: due date recalculated from the remaining satisfactory certificate",
    removed.status === 204 && isoDay(detail.data?.dueDate) === firstExpiry, JSON.stringify(detail.data?.dueDate));
  check("delete: the unsatisfactory certificate is newest again, so it needs action", detail.data?.needsAction === true);
  const audit = await owner("GET", `/audit-events?entityType=compliance_item&entityId=${itemId}`);
  check("audit: certificate deletion recorded", (audit.data ?? []).some((e) => e.action === "certificate_deleted"));

  // A satisfactory gas record with an AR warning still needs action.
  const warned = await owner("POST", `/items/${itemId}/certificates`, {
    name: "Gas safety record (warning notice)", issueDate: `${today}T10:00:00.000Z`,
    expiryDate: `${goodExpiry}T00:00:00.000Z`, outcome: "satisfactory",
    defects: [{ code: "AR", description: "Flue terminal too close to window" }],
  });
  detail = await owner("GET", `/compliance-items/${itemId}`);
  const arIssue = (await owner("GET", `/fix-track/issues/${warned.data?.defects?.[0]?.fixTrackIssueId}`)).data;
  check("AR warning: satisfactory certificate with an open AR defect needs action",
    warned.status === 201 && detail.data?.needsAction === true && detail.data?.needsActionReason === "open_defects", JSON.stringify(detail.data));
  check("AR warning: FixTrack job is high priority and titled for gas",
    arIssue?.priority === "high" && /^Gas AR: /.test(arIssue?.title ?? ""), JSON.stringify(arIssue));
}

// The AI certificate reader saves with remedialJob: the work that needs doing
// shares one FixTrack job (so one quote covers it); C3s and advice open none.
async function remedialJob(owner) {
  const today = londonToday();
  const item = await owner("POST", "/compliance-items", { title: "Electrical Installation Condition Report (EICR)", frequencyMonths: 60 });
  const itemId = item.data?.id;
  const cert = await owner("POST", `/items/${itemId}/certificates`, {
    name: "EICR 2026 (read by AI)", issueDate: `${today}T09:00:00.000Z`, expiryDate: `${plusMonths(today, 60)}T00:00:00.000Z`,
    outcome: "unsatisfactory", remedialJob: true, readByAi: true,
    defects: [
      { code: "C2", description: "No RCD protection to socket circuits", location: "DB1" },
      { code: "C1", description: "Exposed live conductors", location: "Kitchen" },
      { code: "FI", description: "Circuit 7 could not be traced" },
      { code: "C3", description: "No surge protection" },
      { code: "other", description: "Replace damaged accessory", needsWork: true },
      { code: "other", description: "Consider upgrading consumer unit", needsWork: false },
      { code: "C3", description: "Labels missing", needsWork: true },
    ],
  });
  check("remedial job: certificate saved with seven defects", cert.status === 201 && cert.data?.defects?.length === 7, JSON.stringify(cert.data));
  const byText = Object.fromEntries((cert.data?.defects ?? []).map((d) => [d.description, d]));
  const jobId = byText["Exposed live conductors"]?.fixTrackIssueId;
  check("remedial job: C1, C2, FI and the work item share one job",
    Number.isInteger(jobId) && ["No RCD protection to socket circuits", "Circuit 7 could not be traced", "Replace damaged accessory", "Labels missing"]
      .every((text) => byText[text]?.fixTrackIssueId === jobId), JSON.stringify(cert.data?.defects));
  check("remedial job: C3 and advice open no job",
    byText["No surge protection"]?.fixTrackIssueId === null && byText["Consider upgrading consumer unit"]?.fixTrackIssueId === null);
  const job = (await owner("GET", `/fix-track/issues/${jobId}`)).data;
  check("remedial job: urgent (from the C1), due today, titled with the codes",
    job?.priority === "urgent" && String(job?.targetDate ?? job?.target_date).slice(0, 10) === today
      && job?.title === "EICR remedial work: 1 × C1, 1 × C2, 1 × FI, 1 × C3, 1 × other", JSON.stringify(job));
  check("remedial job: the description lists each item",
    /1\. C2 \(Potentially dangerous\): No RCD protection to socket circuits \(DB1\)/.test(job?.description ?? "")
      && /Replace damaged accessory/.test(job?.description ?? "") && !/No surge protection/.test(job?.description ?? ""), job?.description);
  let detail = await owner("GET", `/compliance-items/${itemId}`);
  check("remedial job: the check needs action with three open blocking defects",
    detail.data?.needsAction === true && detail.data?.openDefectCount === 3, JSON.stringify(detail.data));
  const audit = await owner("GET", `/audit-events?entityType=compliance_item&entityId=${itemId}`);
  check("remedial job: the audit trail notes it was read by AI",
    (audit.data ?? []).some((e) => e.action === "certificate_added" && e.metadata?.readByAi === true), JSON.stringify(audit.data).slice(0, 300));
  const resolved = await resolveIssue(owner, jobId);
  detail = await owner("GET", `/compliance-items/${itemId}`);
  check("remedial job: resolving the one job clears the check's remedial work",
    resolved.status === 200 && detail.data?.openDefectCount === 0 && detail.data?.needsAction === false, JSON.stringify(detail.data));

  const clean = await owner("POST", `/items/${itemId}/certificates`, {
    name: "EICR re-test", outcome: "satisfactory", remedialJob: true,
    defects: [{ code: "C3", description: "Minor improvement" }],
  });
  check("remedial job: only C3s means no job at all",
    clean.status === 201 && clean.data?.defects?.[0]?.fixTrackIssueId === null, JSON.stringify(clean.data));
}

// Without an Anthropic key the AI certificate reader says it is off; viewers never reach it.
async function readerRoutes(owner, viewer) {
  if (process.env.ANTHROPIC_API_KEY) return console.log("SKIP: ANTHROPIC_API_KEY is set; reader-off checks not run");
  const status = await owner("GET", "/certificates/reading");
  check("reader: status says reading is off and reports FixTrack and the AI allowance",
    status.status === 200 && status.data?.available === false && typeof status.data?.fixTrack === "boolean" && typeof status.data?.ai?.active === "boolean",
    JSON.stringify(status.data));
  const body = { fileName: "eicr.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4\n").toString("base64") };
  const off = await owner("POST", "/certificates/read", body);
  check("reader: reading is refused with a plain message while off",
    off.status === 503 && off.data?.code === "CERTIFICATE_READING_UNAVAILABLE", JSON.stringify(off.data));
  const batch = { files: [body, { ...body, fileName: "boiler.pdf" }] };
  const batchOff = await owner("POST", "/certificates/read-files", batch);
  check("reader: reading several files is refused with a plain message while off",
    batchOff.status === 503 && batchOff.data?.code === "CERTIFICATE_READING_UNAVAILABLE", JSON.stringify(batchOff.data));
  if (viewer) {
    check("reader: a viewer cannot see the status", (await viewer("GET", "/certificates/reading")).status === 403);
    check("reader: a viewer cannot send a certificate to be read", (await viewer("POST", "/certificates/read", body)).status === 403);
    check("reader: a viewer cannot send several files to be read", (await viewer("POST", "/certificates/read-files", batch)).status === 403);
  }
}

async function datedCompletion(owner, viewer) {
  const today = londonToday();
  const item = await owner("POST", "/compliance-items", { title: "Fire Alarm Maintenance", frequencyMonths: 6 });
  const itemId = item.data?.id;
  const past = plusDays(today, -40);
  const done = await owner("PATCH", `/compliance-items/${itemId}/status`, { status: "completed", completedAt: past });
  check("completion: past date accepted", done.status === 200, JSON.stringify(done.data));
  check("completion: completedAt is the date done", isoDay(done.data?.completedAt) === past, done.data?.completedAt);
  check("completion: next due counted from the date done", isoDay(done.data?.dueDate) === plusMonths(past, 6) && done.data?.status === "pending",
    JSON.stringify({ due: done.data?.dueDate, status: done.data?.status }));

  const future = await owner("PATCH", `/compliance-items/${itemId}/status`, { status: "completed", completedAt: plusDays(today, 2) });
  check("completion: future date rejected", future.status === 400 && future.data?.code === "CHECK_DATE_IN_FUTURE", JSON.stringify(future.data));
  const unchanged = await owner("GET", `/compliance-items/${itemId}`);
  check("completion: rejected completion changes nothing", isoDay(unchanged.data?.completedAt) === past);
  check("completion: malformed date rejected",
    (await owner("PATCH", `/compliance-items/${itemId}/status`, { status: "completed", completedAt: "2026-02-30" })).status === 400);
  check("completion: date only allowed with completed",
    (await owner("PATCH", `/compliance-items/${itemId}/status`, { status: "in_progress", completedAt: past })).status === 400);

  const legacy = await owner("PATCH", `/compliance-items/${itemId}/status`, { status: "completed" });
  check("completion: without a date it is today (older clients)",
    legacy.status === 200 && isoDay(legacy.data?.dueDate) === plusMonths(isoDay(legacy.data?.completedAt), 6), JSON.stringify(legacy.data));

  // Completing through the edit form (PUT) also takes the date done.
  const oneOff = await owner("POST", "/compliance-items", { title: "Chimney Sweep", frequencyMonths: 12 });
  const viaPut = await owner("PUT", `/compliance-items/${oneOff.data?.id}`, { status: "completed", completedAt: past });
  check("completion (edit form): past date sets the next due date",
    viaPut.status === 200 && isoDay(viaPut.data?.completedAt) === past && isoDay(viaPut.data?.dueDate) === plusMonths(past, 12), JSON.stringify(viaPut.data));
  check("completion (edit form): future date rejected",
    (await owner("PUT", `/compliance-items/${oneOff.data?.id}`, { status: "completed", completedAt: plusDays(today, 3) })).status === 400);

  if (viewer) {
    check("viewer: cannot complete a check", (await viewer("PATCH", `/compliance-items/${itemId}/status`, { status: "completed", completedAt: past })).status === 403);
    check("viewer: cannot add a certificate", (await viewer("POST", `/items/${itemId}/certificates`, { name: "Viewer cert", outcome: "satisfactory" })).status === 403);
  }
}

async function starterIntervals() {
  const eicrFor = async (businessType) => {
    const request = await tenant(businessType, businessType);
    const items = (await request("GET", "/compliance-items")).data ?? [];
    const setup = (await request("GET", "/setup/state")).data;
    return {
      seeded: items.find((i) => i.title === "Electrical Installation Condition Report (EICR)")?.frequencyMonths,
      wizard: setup?.starterChecks?.find((c) => c.title === "Electrical Installation Condition Report (EICR)")?.frequencyMonths,
    };
  };
  const leisure = await eicrFor("leisure_sports_centre");
  const park = await eicrFor("holiday_park_campsite");
  const pub = await eicrFor("restaurant_cafe_pub");
  check("starter: leisure centre / pool EICR every 12 months", leisure.seeded === 12 && leisure.wizard === 12, JSON.stringify(leisure));
  check("starter: holiday park EICR every 12 months", park.seeded === 12 && park.wizard === 12, JSON.stringify(park));
  check("starter: pub EICR every 60 months", pub.seeded === 60 && pub.wizard === 60, JSON.stringify(pub));
}

async function main() {
  const owner = await tenant("owner", "offices_commercial");
  const other = await tenant("other", "retail");
  const viewerEmail = `cert-outcomes-viewer-${RUN}@test.local`;
  const createdViewer = await owner("POST", "/users", {
    name: "Read-only viewer", email: viewerEmail, password: "password-123", role: "client_viewer", clientId: owner.clientId,
  });
  let viewer = null;
  if (createdViewer.status === 201) {
    viewer = session();
    const login = await viewer("POST", "/auth/login", { email: viewerEmail, password: "password-123" });
    if (login.status !== 200) viewer = null;
  }
  check("setup: viewer account", viewer !== null, String(createdViewer.status));

  await outcomesAndDefects(owner, other);
  await dueDateRules(owner);
  await remedialJob(owner);
  await readerRoutes(owner, viewer);
  await datedCompletion(owner, viewer);
  await starterIntervals();

  console.log(`${passed} certificate-outcome checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
