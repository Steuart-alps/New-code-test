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

  const created = await owner("POST", "/incidents", incident({
    riddorRationale: "Assessed against RIDDOR criteria; this is not reportable.",
  }));
  check("create an assessed incident", created.status === 201, String(created.status));
  const id = created.data?.id;

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

  const foreignHistory = await other("GET", `/incidents/${id}/riddor-history`);
  check("tenant isolation protects RIDDOR audit history", [403, 404].includes(foreignHistory.status), String(foreignHistory.status));
  check("incident cannot be deleted to remove its audit history",
    (await owner("DELETE", `/incidents/${id}`)).status === 409);

  console.log(`${passed} RIDDOR audit-history checks passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });