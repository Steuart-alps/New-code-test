// Focused IncidentTrack RIDDOR audit-trail coverage.
// Usage: node tests/riddor-audit-history.mjs (with the API server running).
const BASE = process.env.API_BASE || "http://localhost:8080/api";
const day = new Date().toISOString().slice(0, 10);
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
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
}

async function tenant(label) {
  const request = session();
  const email = `riddor-audit-${label}-${Date.now()}-${Math.random()}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: `${label} RIDDOR Manager`, email, password: "password-123",
  });
  check(`${label}: register`, [200, 201].includes(registered.status), String(registered.status));
  const token = registered.data?.verificationToken;
  if (!token) {
    check(`${label}: test verification token is available`, false,
      "run via tests/run-riddor-audit-history.sh (NODE_ENV=test)");
    return null;
  }
  const verified = await request("GET", `/auth/verify-email?token=${encodeURIComponent(token)}`);
  check(`${label}: verify`, verified.status === 200, String(verified.status));
  if (verified.status !== 200) return null;
  const loggedIn = await request("POST", "/auth/login", { email, password: "password-123" });
  check(`${label}: login`, loggedIn.status === 200, String(loggedIn.status));
  if (loggedIn.status !== 200) return null;
  return request;
}

function incident(overrides = {}) {
  return {
    incidentType: "accident", severity: "minor", status: "open", incidentDate: day,
    location: "Kitchen", description: "Test incident", involvedName: "Test Person",
    involvedEmploymentType: "employee", firstAidGiven: false, reportedBy: "Duty manager",
    riddorReportable: false, reportedToHse: false,
    ...overrides,
  };
}

async function main() {
  const owner = await tenant("owner");
  const other = await tenant("other");
  if (!owner || !other) {
    console.log(`${passed} RIDDOR audit-history setup checks passed, ${failures.length} failed.`);
    process.exitCode = 1;
    return;
  }

  const missingRationale = await owner("POST", "/incidents", incident());
  check("decision rationale is required", missingRationale.status === 400, String(missingRationale.status));
  const unsupportedSubmission = await owner("POST", "/incidents", incident({
    riddorRationale: "No report was made.", submittedAt: new Date().toISOString(),
    submissionEvidence: "Unmatched HSE receipt",
  }));
  check("a new decision cannot carry unsupported HSE submission metadata",
    unsupportedSubmission.status === 400, String(unsupportedSubmission.status));

  const created = await owner("POST", "/incidents", incident({
    riddorRationale: "Assessed against RIDDOR criteria; this is not reportable.",
  }));
  check("create an assessed incident", created.status === 201, String(created.status));
  const id = created.data?.id;
  const mobileCreated = await owner("POST", "/incidents", {
    incidentType: "accident", severity: "minor", incidentDate: day,
    location: "Mobile inspection", description: "Incident reported from a device",
    involvedName: "Mobile worker", involvedEmploymentType: "employee",
    firstAidGiven: false, reportedBy: "Site staff", riddorReportable: false,
    reportedToHse: false, riddorRationale: "Assessed at the site; no reportable injury.",
  });
  check("mobile form decision payload creates an incident", mobileCreated.status === 201, String(mobileCreated.status));
  const mobileHistory = await owner("GET", `/incidents/${mobileCreated.data?.id}/riddor-history`);
  check("mobile decision records reviewer and reason", mobileHistory.data?.[0]?.rationale?.includes("site") &&
    !!mobileHistory.data?.[0]?.decisionMaker);

  const initialHistory = await owner("GET", `/incidents/${id}/riddor-history`);
  const decision = initialHistory.data?.[0];
  check("initial decision retains outcome, rationale, maker and time",
    initialHistory.status === 200 && decision?.eventType === "decision" &&
    decision.riddorReportable === false &&
    decision.rationale?.includes("not reportable") &&
    decision.decisionMaker === "owner RIDDOR Manager" && !!decision.decisionAt,
    JSON.stringify(decision));

  const incompleteSubmission = await owner("PUT", `/incidents/${id}`, {
    riddorReportable: true, reportedToHse: true, hseReference: "RIDDOR-TEST-1",
    hseReportDate: day, riddorRationale: "Now confirmed as a reportable specified injury.",
  });
  check("reject incomplete HSE submission audit record", incompleteSubmission.status === 400, String(incompleteSubmission.status));

  const submittedAt = new Date().toISOString();
  const submitted = await owner("PUT", `/incidents/${id}`, {
    riddorReportable: true, reportedToHse: true, hseReference: "RIDDOR-TEST-1",
    hseReportDate: day, submittedAt, submissionEvidence: "HSE confirmation receipt TEST-1",
    riddorRationale: "Now confirmed as a reportable specified injury.",
  });
  check("append complete HSE submission record", submitted.status === 200, String(submitted.status));

  const history = await owner("GET", `/incidents/${id}/riddor-history`);
  const submission = history.data?.find((event) => event.eventType === "submission");
  check("submission keeps reference, time and evidence with decision",
    submission?.riddorReportable === true && submission?.reportedToHse === true &&
    submission?.hseReference === "RIDDOR-TEST-1" && submission?.submittedAt &&
    submission?.submissionEvidence === "HSE confirmation receipt TEST-1" &&
    submission?.decisionMaker === "owner RIDDOR Manager",
    JSON.stringify(submission));
  check("history remains append-only after submission",
    history.data?.length === 2 && history.data.some((event) => event.id === decision?.id),
    JSON.stringify(history.data));
  for (const [label, fields] of [
    ["null HSE reference", { hseReference: null }],
    ["empty HSE reference", { hseReference: "" }],
    ["null HSE date", { hseReportDate: null }],
  ]) {
    const invalid = await owner("PUT", `/incidents/${id}`, {
      ...fields, submittedAt: new Date().toISOString(),
      submissionEvidence: "This cannot support a submission without the reference and date.",
      riddorRationale: "This attempted correction must be rejected.",
    });
    check(`reject ${label} on an audited submission`, invalid.status === 400, JSON.stringify(invalid));
  }
  const stillSubmitted = await owner("GET", `/incidents/${id}/riddor-history`);
  check("invalid corrections do not append history", stillSubmitted.data?.length === 2);

  const ordinaryEdit = await owner("PUT", `/incidents/${id}`, {
    investigationFindings: "Witness statements and shift records reviewed.",
    immediateActions: "Area isolated.",
  });
  check("investigation findings persist on the incident", ordinaryEdit.status === 200 &&
    ordinaryEdit.data?.investigationFindings?.includes("Witness"), JSON.stringify(ordinaryEdit));
  const unchangedHistory = await owner("GET", `/incidents/${id}/riddor-history`);
  check("investigation edits do not invent a new RIDDOR decision", unchangedHistory.data?.length === 2);
  check("changing an HSE reference needs fresh submission evidence",
    (await owner("PUT", `/incidents/${id}`, {
      hseReference: "RIDDOR-TEST-2", riddorRationale: "Corrected reference after review.",
    })).status === 400);
  check("submission-only edits cannot masquerade as decisions",
    (await owner("PUT", `/incidents/${id}`, {
      submittedAt: new Date().toISOString(), submissionEvidence: "Unsupported receipt",
      riddorRationale: "No new submission was made.",
    })).status === 400);

  const foreignAction = await other("POST", "/compliance-hub/actions", {
    sourceTrack: "IncidentTrack", sourceRecordId: String(id),
    title: "Invalid cross-tenant follow-up", ownerName: "Other manager",
    correctiveAction: "This must not be linked to another tenant",
  });
  check("a different tenant cannot link an action to this incident", foreignAction.status === 404, String(foreignAction.status));
  const linked = await owner("POST", "/compliance-hub/actions", {
    sourceTrack: "IncidentTrack", sourceRecordId: String(id),
    title: "Review incident controls", ownerName: "Duty manager",
    correctiveAction: "Introduce and document safer procedures",
  });
  check("corrective action is linked to the incident", linked.status === 201, JSON.stringify(linked));
  const actionId = linked.data?.id;
  const actions = await owner("GET", `/incidents/${id}/actions`);
  check("incident file shows linked action and status",
    actions.status === 200 && actions.data?.some(a => a.id === actionId && a.status === "open"));
  check("unverified action blocks incident closure",
    (await owner("PUT", `/incidents/${id}`, { status: "closed" })).status === 409);
  check("incident action cannot be reassigned",
    (await owner("PATCH", `/compliance-hub/actions/${actionId}`, { sourceRecordId: "99999" })).status === 409);
  check("cross-tenant incident action list is inaccessible",
    [403, 404].includes((await other("GET", `/incidents/${id}/actions`)).status));

  const verifier = session();
  const verifierEmail = `incident-verifier-${Date.now()}@test.local`;
  const me = await owner("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.clientId;
  const alphaDept = await owner("POST", "/departments", { name: `RIDDOR Alpha ${Date.now()}` });
  const betaDept = await owner("POST", "/departments", { name: `RIDDOR Beta ${Date.now()}` });
  check("create departments for action isolation", alphaDept.status === 201 && betaDept.status === 201);
  const alphaSite = await owner("POST", "/sites", {
    name: `RIDDOR Alpha site ${Date.now()}`, departmentId: alphaDept.data?.id, seedStarterChecks: false,
  });
  check("create department site", alphaSite.status === 201);
  const scoped = await owner("POST", "/incidents", incident({
    siteId: alphaSite.data?.id, riddorRationale: "No specified injury in this separate incident.",
  }));
  check("create scoped incident", scoped.status === 201);
  const scopedId = scoped.data?.id;
  const alternateId = await owner("POST", "/compliance-hub/actions", {
    sourceTrack: "IncidentTrack", sourceRecordId: `00${scopedId}`,
    title: "Canonical linked action", ownerName: "Duty manager",
    correctiveAction: "Update site inspection guidance",
  });
  check("alternate numeric ID is stored canonically", alternateId.status === 201 &&
    alternateId.data?.sourceRecordId === String(scopedId));
  check("canonical link appears on the incident file",
    (await owner("GET", `/incidents/${scopedId}/actions`)).data?.some(a => a.id === alternateId.data?.id));
  check("canonical link blocks incident closure",
    (await owner("PUT", `/incidents/${scopedId}`, { status: "closed" })).status === 409);
  const alphaStaff = session();
  const betaStaff = session();
  for (const [label, dept, request] of [
    ["alpha", alphaDept.data?.id, alphaStaff], ["beta", betaDept.data?.id, betaStaff],
  ]) {
    const email = `riddor-${label}-${Date.now()}@test.local`;
    const addedStaff = await owner("POST", "/users", {
      name: `${label} incident staff`, email, password: "password-456",
      role: "client_staff", clientId, departmentId: dept,
    });
    check(`${label}: create department staff`, [200, 201].includes(addedStaff.status));
    check(`${label}: login department staff`,
      (await request("POST", "/auth/login", { email, password: "password-456" })).status === 200);
  }
  check("same-department staff sees incident action",
    (await alphaStaff("GET", "/compliance-hub/actions")).data?.some(a => a.id === alternateId.data?.id));
  check("other-department staff cannot list incident action",
    !(await betaStaff("GET", "/compliance-hub/actions")).data?.some(a => a.id === alternateId.data?.id));
  check("other-department staff cannot update incident action",
    (await betaStaff("PATCH", `/compliance-hub/actions/${alternateId.data?.id}`, { status: "in_progress" })).status === 404);
  check("other-department staff cannot link an action to incident",
    (await betaStaff("POST", "/compliance-hub/actions", {
      sourceTrack: "IncidentTrack", sourceRecordId: String(scopedId),
      title: "Unpermitted follow-up", ownerName: "Other staff", correctiveAction: "Must be denied",
    })).status === 404);
  const added = await owner("POST", "/users", {
    name: "Independent verifier", email: verifierEmail, password: "password-456",
    role: "client_admin", clientId,
  });
  check("create independent reviewer", [200, 201].includes(added.status), JSON.stringify(added));
  check("independent reviewer can sign in",
    (await verifier("POST", "/auth/login", { email: verifierEmail, password: "password-456" })).status === 200);
  check("record action evidence and await verification",
    (await owner("PATCH", `/compliance-hub/actions/${actionId}`, {
      status: "awaiting_verification", evidenceReference: "Incident evidence attachment #1",
    })).status === 200);
  check("independent reviewer verifies the linked action",
    (await verifier("PATCH", `/compliance-hub/actions/${actionId}`, {
      status: "verified", verificationNotes: "Inspected the revised procedures and evidence.",
    })).status === 200);
  const verifiedActions = await owner("GET", `/incidents/${id}/actions`);
  check("incident file retains verified closure evidence", verifiedActions.data?.some(a =>
    a.id === actionId && a.status === "verified" && a.verifiedAt && a.evidenceReference && a.verificationNotes));
  check("incident can close after verification",
    (await owner("PUT", `/incidents/${id}`, { status: "closed" })).status === 200);
  check("closed incident cannot silently acquire an unverified action",
    (await owner("POST", "/compliance-hub/actions", {
      sourceTrack: "IncidentTrack", sourceRecordId: String(id), title: "Late follow-up",
      ownerName: "Duty manager", correctiveAction: "Reopen the incident before creating this action",
    })).status === 404);

  const foreignHistory = await other("GET", `/incidents/${id}/riddor-history`);
  check("tenant isolation protects RIDDOR audit history", [403, 404].includes(foreignHistory.status), String(foreignHistory.status));
  check("incident cannot be deleted to remove its audit history",
    (await owner("DELETE", `/incidents/${id}`)).status === 409);

  console.log(`${passed} RIDDOR audit-history checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });