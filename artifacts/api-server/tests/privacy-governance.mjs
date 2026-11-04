import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteToConsultant } from "./consultant-account.mjs";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function expectStatus(name, response, expected) {
  const choices = Array.isArray(expected) ? expected : [expected];
  check(name, choices.includes(response.status), `expected ${choices.join("/")}, got ${response.status}`);
}

function makeSession() {
  let cookie = "";
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    return { status: response.status, data, response };
  };
  request.cookie = () => cookie;
  return request;
}

async function registerManager(label, stamp) {
  const session = makeSession();
  const email = `privacy-${label}-${stamp}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const registration = await session("POST", "/auth/register", {
    name: `${label} privacy manager`,
    email,
    password: "password-123",
  });
  if (![200, 201].includes(registration.status)) throw new Error(`Registration failed for ${label}: ${registration.status}`);
  const verified = await session("GET", `/auth/verify-email?token=${encodeURIComponent(registration.data?.verificationToken)}`);
  if (verified.status !== 200) throw new Error(`Email verification failed for ${label}: ${verified.status}`);
  const login = await session("POST", "/auth/login", { email, password: "password-123" });
  if (login.status !== 200) throw new Error(`Login failed for ${label}: ${login.status}`);
  const me = await session("GET", "/auth/me");
  const user = me.data?.user ?? me.data;
  if (!Number.isInteger(user?.clientId)) throw new Error(`No client context for ${label}`);
  return { session, user, clientId: user.clientId, email };
}

async function createUserSession(admin, clientId, role, label, stamp) {
  const email = `privacy-${label}-${stamp}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const created = await admin.session("POST", "/users", {
    name: `${label} privacy access test`,
    email,
    password: "password-456",
    role,
    clientId,
  });
  expectStatus(`create ${role} account`, created, [200, 201]);
  const session = makeSession();
  const login = await session("POST", "/auth/login", { email, password: "password-456" });
  expectStatus(`login ${role} account`, login, 200);
  return session;
}

function addCalendarMonth(date) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function exportEntry(zipPath, entryName) {
  return execFileSync("unzip", ["-p", zipPath, entryName], { encoding: "utf8" });
}

// Public form calls carry no session cookie, exactly like a member of the public.
async function publicCall(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data, response };
}

async function capturedEmails() {
  const path = process.env.TEST_EMAIL_CAPTURE_PATH;
  if (!path) return null;
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function checkOnlineIntake({ managerA, managerB, viewer, staff, stamp, profile }) {
  const a = `?clientId=${managerA.clientId}`;
  expectStatus("viewer cannot publish the online form", await viewer("POST", `/privacy-governance/intake-link${a}`), 403);
  expectStatus("staff cannot publish the online form", await staff("POST", `/privacy-governance/intake-link${a}`), 403);
  expectStatus("anonymous caller cannot publish the online form", await makeSession()("POST", "/privacy-governance/intake-link"), 401);

  const before = await managerA.session("GET", `/privacy-governance${a}`);
  check("online form starts off", before.data?.program?.intakeEnabled === false, JSON.stringify(before.data?.program?.intakeEnabled));
  check("administrators list includes the manager", before.data?.privacyAdministrators?.some((admin) => admin.id === managerA.user.id));

  const published = await managerA.session("POST", `/privacy-governance/intake-link${a}`);
  expectStatus("manager publishes the online form", published, 201);
  const url = published.data?.url ?? "";
  const token = url.split("/privacy-request/")[1] ?? "";
  check("form link has a 43-character random token", /^[A-Za-z0-9_-]{43}$/.test(token), url);
  check("form link does not contain the tenant id", !url.includes(`clientId`) && !new RegExp(`/${managerA.clientId}(/|$)`).test(url), url);
  check("publish response does not expose the stored digest", !JSON.stringify(published.data).includes("intakeTokenHash"));
  check("publish response marks the form live", published.data?.program?.intakeEnabled === true);

  const after = await managerA.session("GET", `/privacy-governance${a}`);
  check("privacy records never include the link or digest", !JSON.stringify(after.data).includes(token) && !JSON.stringify(after.data).includes("intakeTokenHash"));

  const form = await publicCall("GET", `/privacy-intake/${token}`);
  expectStatus("public form opens without signing in", form, 200);
  check("public form names the controller", form.data?.organisationName === profile.controllerName, form.data?.organisationName);
  check("public form links the privacy notice", form.data?.privacyNoticeUrl === profile.noticeUrl);
  check("public form does not reveal the tenant id", !JSON.stringify(form.data).includes("clientId"));
  expectStatus("unknown form link is not found", await publicCall("GET", `/privacy-intake/${"x".repeat(43)}`), 404);
  expectStatus("malformed form link is not found", await publicCall("GET", "/privacy-intake/abc"), 404);

  expectStatus("assignee must administer this business", await managerA.session("PUT", `/privacy-governance/intake-assignee${a}`, { assigneeId: managerB.user.id }), 400);
  const assigned = await managerA.session("PUT", `/privacy-governance/intake-assignee${a}`, { assigneeId: managerA.user.id });
  expectStatus("manager assigns online requests", assigned, 200);
  check("assignee is saved", assigned.data?.intakeAssigneeId === managerA.user.id);

  // Submission 1 of the five the per-IP limiter allows each hour.
  const subject = `ONLINE-SUBJECT-${stamp}`;
  const subjectEmail = `online-${stamp}@example.test`;
  const details = `ONLINE-DETAILS-${stamp}: please send me a copy of my records`;
  const submitted = await publicCall("POST", `/privacy-intake/${token}`, {
    requestType: "access",
    name: subject,
    email: subjectEmail,
    details,
    // A client id in the body is ignored: the link decides the business.
    clientId: managerB.clientId,
  });
  expectStatus("public submission is accepted", submitted, 201);
  const reference = submitted.data?.reference;
  check("requester gets a reference", /^PR-[2-9A-HJ-NP-Z]{8}$/.test(reference ?? ""), reference);
  check("receipt does not expose internal ids", submitted.data && !("id" in submitted.data) && !("clientId" in submitted.data));

  const records = await managerA.session("GET", `/privacy-governance${a}`);
  const online = records.data?.rightsRequests?.find((row) => row.publicReference === reference);
  check("online request reaches the business's Privacy Centre", Boolean(online));
  check("online request is marked as from the form", online?.source === "public_intake");
  check("online request starts unverified", online?.identityStatus === "not_started" && online?.status === "received");
  check("online request has no staff author", online?.createdBy === null);
  check("online request is assigned to the chosen administrator", online?.assignedTo === managerA.user.id);
  check("online request keeps the requester's details", online?.subjectName === subject && online?.subjectContact === subjectEmail && online?.scopeDescription === details);
  check(
    "receipt time starts the one-month deadline",
    online && online.dueAt === addCalendarMonth(new Date(online.receivedAt)).toISOString(),
    `${online?.receivedAt} -> ${online?.dueAt}`,
  );
  check("receipt time is the server's", online && Math.abs(Date.parse(online.receivedAt) - Date.now()) < 5 * 60_000);
  const other = await managerB.session("GET", `/privacy-governance?clientId=${managerB.clientId}`);
  check("online request is not visible to another business", !JSON.stringify(other.data).includes(subject));

  const audit = await managerA.session("GET", `/audit-events${a}&entityType=privacy_rights_request&entityId=${online?.id}`);
  expectStatus("manager reads the request's audit trail", audit, 200);
  const created = audit.data?.find?.((row) => row.action === "created");
  check("online request creation is audited", created?.metadata?.source === "public_intake" && created?.actorId === null);
  check("audit metadata leaves out subject details", !JSON.stringify(audit.data).includes(subject) && !JSON.stringify(audit.data).includes(subjectEmail) && !JSON.stringify(audit.data).includes("ONLINE-DETAILS"));

  const emails = await capturedEmails();
  if (emails) {
    // Delivery runs after the response; give it a moment.
    let matching = [];
    for (let i = 0; i < 20 && matching.length === 0; i++) {
      matching = ((await capturedEmails()) ?? []).filter((email) => email.subject?.includes(reference));
      if (!matching.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check("assigned administrator is emailed", matching.length === 1 && matching[0].to === managerA.email, JSON.stringify(matching.map((email) => email.to)));
    const body = JSON.stringify(matching);
    check("notification leaves out subject details", !body.includes(subject) && !body.includes(subjectEmail) && !body.includes("ONLINE-DETAILS"));
    const notified = await managerA.session("GET", `/privacy-governance${a}`);
    check("notification time is recorded", Boolean(notified.data?.rightsRequests?.find((row) => row.publicReference === reference)?.adminNotifiedAt));
  } else {
    console.log("(email capture not configured; skipping notification checks)");
  }

  // Submission 2: invalid bodies are refused.
  expectStatus("submission needs an email address", await publicCall("POST", `/privacy-intake/${token}`, {
    requestType: "access", name: "No email", email: "", details: "x",
  }), 400);

  const rotated = await managerA.session("POST", `/privacy-governance/intake-link${a}`);
  expectStatus("manager replaces the form link", rotated, 201);
  const newToken = (rotated.data?.url ?? "").split("/privacy-request/")[1] ?? "";
  check("replacement link differs", newToken.length === 43 && newToken !== token);
  expectStatus("old link stops working", await publicCall("GET", `/privacy-intake/${token}`), 404);
  expectStatus("new link works", await publicCall("GET", `/privacy-intake/${newToken}`), 200);

  expectStatus("manager turns the form off", await managerA.session("DELETE", `/privacy-governance/intake-link${a}`), 200);
  expectStatus("form link stops working when off", await publicCall("GET", `/privacy-intake/${newToken}`), 404);
  // Submission 3.
  expectStatus("submissions are refused when off", await publicCall("POST", `/privacy-intake/${newToken}`, {
    requestType: "erasure", name: "Late", email: "late@example.test", details: "x",
  }), 404);

  const trail = await managerA.session("GET", `/audit-events${a}&entityType=privacy_program`);
  const actions = (trail.data ?? []).map((row) => row.action);
  check("link changes are audited", ["intake_link_published", "intake_link_rotated", "intake_link_disabled"].every((action) => actions.includes(action)), actions.join(","));
  check("audit trail never holds the link", !JSON.stringify(trail.data).includes(token) && !JSON.stringify(trail.data).includes(newToken));

  const republished = await managerA.session("POST", `/privacy-governance/intake-link${a}`);
  const liveToken = (republished.data?.url ?? "").split("/privacy-request/")[1] ?? "";
  const countBefore = (await managerA.session("GET", `/privacy-governance${a}`)).data?.rightsRequests?.length;
  // Submission 4: the spam trap looks successful but stores nothing.
  const trapped = await publicCall("POST", `/privacy-intake/${liveToken}`, {
    requestType: "access", name: "Bot", email: "bot@example.test", details: "spam", website: "https://spam.example",
  });
  expectStatus("spam-trap submission looks accepted", trapped, 201);
  const countAfter = (await managerA.session("GET", `/privacy-governance${a}`)).data?.rightsRequests?.length;
  check("spam-trap submission stores nothing", countBefore === countAfter, `${countBefore} -> ${countAfter}`);
  // Submission 5 is allowed; the sixth from this IP within the hour is not.
  expectStatus("fifth submission in the hour is accepted", await publicCall("POST", `/privacy-intake/${liveToken}`, {
    requestType: "objection", name: `Fifth ${stamp}`, email: `fifth-${stamp}@example.test`, details: "Please stop marketing to me",
  }), 201);
  const limited = await publicCall("POST", `/privacy-intake/${liveToken}`, {
    requestType: "objection", name: `Sixth ${stamp}`, email: `sixth-${stamp}@example.test`, details: "Over the limit",
  });
  expectStatus("submissions are rate-limited per source", limited, 429);
  check("rate limit says when to retry", Number(limited.response.headers.get("retry-after")) > 0);
}

async function main() {
  const stamp = Date.now();
  const managerA = await registerManager("tenant-a", stamp);
  const managerB = await registerManager("tenant-b", stamp);
  const markerA = `PRIVACY-OWNER-${stamp}`;
  const markerB = `PRIVACY-OTHER-${stamp}`;

  const viewer = await createUserSession(managerA, managerA.clientId, "client_viewer", "viewer", stamp);
  const staff = await createUserSession(managerA, managerA.clientId, "client_staff", "staff", stamp);

  expectStatus("privacy records require authentication", await makeSession()("GET", "/privacy-governance"), 401);
  expectStatus("viewer cannot read privacy records", await viewer("GET", `/privacy-governance?clientId=${managerA.clientId}`), 403);
  expectStatus("staff cannot read privacy records", await staff("GET", `/privacy-governance?clientId=${managerA.clientId}`), 403);
  expectStatus("viewer cannot create privacy records", await viewer("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, {}), 403);

  const profile = {
    customerRole: "mixed",
    controllerName: `Example controller ${stamp}`,
    controllerContact: "privacy@example.test",
    dpoContact: null,
    noticeUrl: "https://example.test/privacy",
    noticeVersion: "2026-09",
    noticeReviewedAt: "2026-09-01T09:00:00.000Z",
    processorAgreementStatus: "in_place",
    processorAgreementReviewedAt: "2026-09-01T09:00:00.000Z",
    responsibilitiesNotes: "Controller for staff records; processor for customer-hosted records.",
    privacyOwner: "Privacy Lead",
  };
  const savedProfile = await managerA.session("PUT", `/privacy-governance/program?clientId=${managerA.clientId}`, profile);
  expectStatus("save controller / processor profile", savedProfile, 200);
  check("profile stores selected role", savedProfile.data?.customerRole === "mixed");
  check("profile stores notice link", savedProfile.data?.noticeUrl === profile.noticeUrl);

  const activityInvalid = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, {
    kind: "activity",
    name: "Sensitive activity",
    purpose: "Test Article 9 validation",
    dataSubjects: "Employees",
    dataCategories: "Health data",
    article6Basis: "legal_obligation",
    article6Rationale: null,
    specialCategoryData: true,
    article9Condition: null,
    article9Rationale: null,
    recipients: null,
    transferDetails: null,
    retentionCriteria: "Review at end of employment",
    securityMeasures: null,
    dpiaClassification: "not_screened",
    dpiaRationale: null,
    dpiaCompletedAt: null,
    owner: null,
    reviewDueAt: null,
    active: true,
  });
  expectStatus("special category requires Article 9 condition", activityInvalid, 400);

  const activityBody = {
    kind: "activity",
    name: `Staff records ${stamp}`,
    purpose: "Manage employee onboarding and employment records",
    dataSubjects: "Employees and applicants",
    dataCategories: "Contact and employment details",
    article6Basis: "legal_obligation",
    article6Rationale: "Assessment recorded by the customer",
    specialCategoryData: false,
    article9Condition: null,
    article9Rationale: null,
    recipients: "Payroll provider",
    transferDetails: "No restricted transfer identified",
    retentionCriteria: "Review against the employment lifecycle and legal obligations",
    securityMeasures: "Role-based access and encryption",
    dpiaClassification: "not_required",
    dpiaRationale: "Screening notes recorded for this example",
    dpiaCompletedAt: null,
    owner: "People team",
    reviewDueAt: null,
    active: true,
  };
  // A body clientId naming another tenant than the URL is refused outright.
  const smuggledActivity = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, {
    ...activityBody,
    clientId: managerB.clientId,
  });
  expectStatus("request body cannot select another tenant", smuggledActivity, 400);
  const activity = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, activityBody);
  expectStatus("create processing activity", activity, 201);
  check("request body cannot select another tenant", activity.data?.clientId === managerA.clientId, `stored client=${activity.data?.clientId}`);

  const invalidSubprocessor = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, {
    kind: "processor",
    organizationName: "Subprocessor without parent",
    role: "subprocessor",
    parentProcessor: null,
    serviceDescription: "Hosting",
    dataCategories: "Account records",
    processingCountries: "United States",
    transferMechanism: "uk_idta",
    transferSafeguards: "Contractual safeguard",
    transferAssessment: null,
    agreementStatus: "in_place",
    agreementReviewedAt: null,
    transferReviewedAt: null,
    reviewDueAt: null,
    active: true,
  });
  expectStatus("subprocessor requires appointing processor", invalidSubprocessor, 400);

  // Intentionally historical: 2024-01-31 (a leap year) pins the one-calendar-
  // month deadline clamp to 2024-02-29, and the breach below pins the 72-hour
  // timer. Do not make these dates relative to today.
  const requestBody = {
    kind: "rights_request",
    requestType: "access",
    subjectName: markerA,
    subjectContact: `person-${stamp}@example.test`,
    scopeDescription: "Access request received by email",
    receivedAt: "2024-01-31T12:30:00.000Z",
    extendedDueAt: null,
    extensionReason: null,
    identityStatus: "not_started",
    identityMethod: null,
    identityEvidence: null,
    status: "received",
    decision: null,
    decisionRationale: null,
    responseSentAt: null,
    responseEvidence: null,
  };
  const equalDeadlineExtension = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, {
    ...requestBody,
    extendedDueAt: "2024-02-29T12:30:00.000Z",
    extensionReason: "Test date must be strictly later",
  });
  expectStatus("extension must be after initial deadline", equalDeadlineExtension, 400);

  const smuggledRequest = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, {
    ...requestBody,
    clientId: managerB.clientId,
  });
  expectStatus("rights request body cannot select another tenant", smuggledRequest, 400);
  const createdRequest = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, requestBody);
  expectStatus("create rights request", createdRequest, 201);
  const expectedDue = addCalendarMonth(new Date(requestBody.receivedAt)).toISOString();
  check("one-calendar-month deadline clamps at February month-end", createdRequest.data?.dueAt === expectedDue, `expected ${expectedDue}, got ${createdRequest.data?.dueAt}`);
  check("rights request is stored for the URL tenant", createdRequest.data?.clientId === managerA.clientId);
  const requestId = createdRequest.data?.id;

  const managerBRequest = await managerB.session("POST", `/privacy-governance/records?clientId=${managerB.clientId}`, {
    ...requestBody,
    subjectName: markerB,
    subjectContact: null,
    receivedAt: new Date().toISOString(),
    clientId: undefined,
  });
  expectStatus("create second tenant request", managerBRequest, 201);

  const tenantARecords = await managerA.session("GET", `/privacy-governance?clientId=${managerA.clientId}`);
  expectStatus("manager reads own privacy records", tenantARecords, 200);
  check("GET includes own rights request", tenantARecords.data?.rightsRequests?.some((row) => row.id === requestId));
  check("GET returns the processing activity", tenantARecords.data?.activities?.some((row) => row.id === activity.data?.id));

  const tenantBRecords = await managerB.session("GET", `/privacy-governance?clientId=${managerB.clientId}`);
  expectStatus("second manager reads own privacy records", tenantBRecords, 200);
  check("second tenant cannot read first tenant subject", !JSON.stringify(tenantBRecords.data).includes(markerA));
  check("first tenant cannot read second tenant subject", !JSON.stringify(tenantARecords.data).includes(markerB));

  expectStatus("cross-tenant rights request edit is not found", await managerB.session(
    "PUT",
    `/privacy-governance/records/rights_request/${requestId}?clientId=${managerB.clientId}`,
    requestBody,
  ), 404);

  const holdSchedule = await managerB.session("POST", `/privacy-governance/records?clientId=${managerB.clientId}`, {
    kind: "retention",
    recordCategory: `Held records ${stamp}`,
    scopeDescription: "Records preserved for a live legal matter",
    retentionPeriod: "Retain until hold review",
    retentionTrigger: "Hold release",
    justification: "Active legal matter",
    legalHoldActive: true,
    legalHoldReason: "Preserve evidence while the matter is ongoing",
    deletionException: false,
    deletionExceptionReason: null,
    reviewDueAt: null,
    active: true,
  });
  expectStatus("create legal hold schedule", holdSchedule, 201);
  const scheduleId = holdSchedule.data?.id;
  expectStatus("deletion cannot be verified under active hold", await managerB.session(
    "POST",
    `/privacy-governance/retention-schedules/${scheduleId}/verifications?clientId=${managerB.clientId}`,
    { outcome: "deletion_verified", recordsReviewed: "Folder A", verificationMethod: "Query check", evidence: "Evidence ref A" },
  ), 409);
  const holdEvidence = await managerB.session(
    "POST",
    `/privacy-governance/retention-schedules/${scheduleId}/verifications?clientId=${managerB.clientId}`,
    { outcome: "legal_hold_confirmed", recordsReviewed: "Folder A", verificationMethod: "Matter register review", evidence: "Evidence ref B" },
  );
  expectStatus("legal hold evidence is recorded", holdEvidence, 201);
  check("verification evidence identifies the schedule", holdEvidence.data?.scheduleId === scheduleId);
  // Deleting a business outright is a consultant action.
  promoteToConsultant(managerB.email);
  expectStatus("manual account deletion is blocked by privacy hold", await managerB.session("DELETE", `/clients/${managerB.clientId}`), 409);

  const breach = await managerA.session("POST", `/privacy-governance/records?clientId=${managerA.clientId}`, {
    kind: "breach",
    discoveredAt: "2024-01-01T08:15:00.000Z",
    occurredFrom: null,
    occurredTo: null,
    description: `Test incident ${stamp}`,
    dataCategories: "Contact details",
    affectedSubjectsEstimate: 3,
    affectedRecordsEstimate: 4,
    riskLevel: "under_assessment",
    assessmentStatus: "assessing",
    assessmentRationale: null,
    containmentSteps: "Access disabled",
    authorityNotificationRequired: null,
    authorityNotifiedAt: null,
    authorityNotificationReference: null,
    individualNotificationRequired: null,
    individualNotificationDueAt: null,
    individualsNotifiedAt: null,
    evidence: "Incident note reference",
  });
  expectStatus("create breach assessment", breach, 201);
  check("breach timer is 72 hours from discovery", breach.data?.authorityNotificationDueAt === "2024-01-04T08:15:00.000Z", `got ${breach.data?.authorityNotificationDueAt}`);

  await checkOnlineIntake({ managerA, managerB, viewer, staff, stamp, profile });

  const tempDir = await mkdtemp(join(tmpdir(), "privacy-governance-"));
  try {
    const zipPath = join(tempDir, "tenant-export.zip");
    const exportResponse = await fetch(`${BASE}/export`, { headers: { cookie: managerA.session.cookie() } });
    expectStatus("download privacy-aware tenant export", exportResponse, 200);
    if (exportResponse.status === 200) {
      try {
        await writeFile(zipPath, Buffer.from(await exportResponse.arrayBuffer()));
        const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n");
        check("export includes privacy-governance.json", entries.includes("privacy-governance.json"));
        const privacyJson = JSON.parse(exportEntry(zipPath, "privacy-governance.json"));
        check("export contains own subject record", JSON.stringify(privacyJson).includes(markerA));
        check("export excludes another tenant's subject record", !JSON.stringify(privacyJson).includes(markerB));
        check("export includes processing activity records", Array.isArray(privacyJson.processingActivities) && privacyJson.processingActivities.length > 0);
      } catch (error) {
        check("privacy export archive is readable", false, error instanceof Error ? error.message : String(error));
      }
    } else {
      check("export includes privacy-governance.json", false, `export status was ${exportResponse.status}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} privacy-governance checks passed, ${failures.length} failed.`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Privacy-governance integration test failed:", error);
  process.exitCode = 1;
});