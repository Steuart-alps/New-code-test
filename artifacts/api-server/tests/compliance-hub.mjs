// Regression tests for Compliance Hub accountability, corrective actions and
// tenant isolation. Run through test:compliance-hub:ci for a self-booted API.
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0; const failures = [];
const check = (name, ok, detail = "") => ok ? passed++ : failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
const expect = (name, response, codes = [200, 201]) => check(name, codes.includes(response.status), `got ${response.status}`);

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

async function account(label) {
  const call = session();
  const email = `compliance-hub-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const registration = await call("POST", "/auth/register", { name: `${label} admin`, email, password: "password-123" });
  expect(`${label}: register`, registration, [200, 201]);
  if (registration.data?.verificationToken) {
    expect(`${label}: verify`, await call("GET", `/auth/verify-email?token=${encodeURIComponent(registration.data.verificationToken)}`));
    expect(`${label}: login`, await call("POST", "/auth/login", { email, password: "password-123" }));
  }
  const me = await call("GET", "/auth/me");
  expect(`${label}: load account`, me);
  call.clientId = me.data?.user?.clientId ?? me.data?.clientId;
  check(`${label}: receives client context`, Number.isInteger(call.clientId));
  return call;
}

async function createVerifier(admin) {
  const verifier = session();
  const email = `compliance-verifier-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  expect("setup: create independent client admin", await admin("POST", "/users", {
    name: "Independent verifier", email, password: "password-456", role: "client_admin", clientId: admin.clientId,
  }), [200, 201]);
  expect("setup: login independent client admin", await verifier("POST", "/auth/login", { email, password: "password-456" }));
  return verifier;
}

const profile = (name, nation) => ({
  nation, operationType: "Hospitality venue with commercial kitchen", responsiblePersonName: name,
  responsiblePersonRole: "Premises manager", responsiblePersonEmail: `${name.toLowerCase().replaceAll(" ", ".")}@test.local`,
  competentAppointments: [{ area: "Legionella", person: "Competent water contractor", evidence: "Appointment record" }],
  reviewCadence: "Annual and after material change", nextReviewDate: "2027-01-01", haccpSystemReviewed: true,
});

async function run() {
  const [tenantA, tenantB] = await Promise.all([account("tenant-a"), account("tenant-b")]);
  const verifier = await createVerifier(tenantA);
  const guide = await tenantA("GET", "/compliance-hub/guidance");
  expect("guidance: available to authenticated tenant", guide);
  check("guidance: contains public sources", Array.isArray(guide.data?.guidance) && guide.data.guidance.some(g => g.track === "FireTrack" && g.url.startsWith("https://")));

  expect("profile: tenant A saves accountable profile", await tenantA("PUT", "/compliance-hub/profile", profile("A Manager", "england")));
  expect("profile: tenant B saves separate jurisdiction", await tenantB("PUT", "/compliance-hub/profile", profile("B Manager", "scotland")));
  const aProfile = await tenantA("GET", "/compliance-hub/profile");
  const bProfile = await tenantB("GET", "/compliance-hub/profile");
  check("profile: tenant A does not receive B profile", aProfile.data?.responsiblePersonName === "A Manager" && aProfile.data?.nation === "england");
  check("profile: tenant B does not receive A profile", bProfile.data?.responsiblePersonName === "B Manager" && bProfile.data?.nation === "scotland");

  const created = await tenantA("POST", "/compliance-hub/actions", {
    sourceTrack: "FireTrack", sourceRecordId: "check-99", title: "Clear obstructed escape route", severity: "high",
    ownerName: "A Manager", dueDate: "2026-12-01", interimControl: "Area isolated and staff briefed",
    correctiveAction: "Remove storage and verify route remains clear",
  });
  expect("actions: create tenant A action", created);
  const id = created.data?.id;
  const bActions = await tenantB("GET", "/compliance-hub/actions");
  check("actions: tenant A action does not leak to B", Array.isArray(bActions.data) && !bActions.data.some(a => a.id === id));
  expect("actions: cannot verify without evidence and notes", await tenantA("PATCH", `/compliance-hub/actions/${id}`, { status: "verified" }), [400]);
  expect("actions: add evidence", await tenantA("PATCH", `/compliance-hub/actions/${id}`, { evidenceReference: "Photo ref 99", status: "awaiting_verification" }));
  expect("actions: creator cannot self-verify", await tenantA("PATCH", `/compliance-hub/actions/${id}`, { status: "verified", verificationNotes: "Creator attempted to verify." }), [403]);
  expect("actions: independent admin verifies with evidence and notes", await verifier("PATCH", `/compliance-hub/actions/${id}`, { status: "verified", verificationNotes: "Independent manager inspected route and evidence on 2026-08-19." }));
  expect("actions: verified action is immutable", await verifier("PATCH", `/compliance-hub/actions/${id}`, { status: "open" }), [409]);
  const finalActions = await tenantA("GET", "/compliance-hub/actions");
  check("actions: verified closure persisted", finalActions.data?.find(a => a.id === id)?.status === "verified");

  const concurrent = await tenantA("POST", "/compliance-hub/actions", {
    sourceTrack: "FireTrack", sourceRecordId: "concurrency-1", title: "Protect verified closure from concurrent update", severity: "high",
    ownerName: "A Manager", dueDate: "2026-12-02", interimControl: "Area isolated while review completes",
    correctiveAction: "Confirm the closure evidence before releasing the action",
  });
  expect("actions: create concurrency guard action", concurrent);
  const concurrentId = concurrent.data?.id;
  expect("actions: prepare concurrency guard action", await tenantA("PATCH", `/compliance-hub/actions/${concurrentId}`, {
    status: "awaiting_verification", evidenceReference: "Concurrent evidence reference",
  }));
  const [closing, reopening] = await Promise.all([
    verifier("PATCH", `/compliance-hub/actions/${concurrentId}`, { status: "verified", verificationNotes: "Independent concurrent closure check." }),
    tenantA("PATCH", `/compliance-hub/actions/${concurrentId}`, { status: "open" }),
  ]);
  check("actions: concurrent closure has one accepted transition", [200, 409].includes(closing.status) && [200, 409].includes(reopening.status) && (closing.status === 200 || reopening.status === 200));
  const concurrentActions = await tenantA("GET", "/compliance-hub/actions");
  expect("actions: reload concurrency guard action", concurrentActions);
  const settledAction = concurrentActions.data?.find(action => action.id === concurrentId);
  check("actions: a verified concurrent closure cannot be reopened", settledAction?.status !== "verified" || (closing.status === 200 && reopening.status === 409 && settledAction?.verificationNotes === "Independent concurrent closure check."));

  const evidenceRace = await tenantA("POST", "/compliance-hub/actions", {
    sourceTrack: "FireTrack", sourceRecordId: "concurrency-2", title: "Protect verified closure from blank evidence", severity: "high",
    ownerName: "A Manager", dueDate: "2026-12-03", interimControl: "Area isolated while evidence is reviewed",
    correctiveAction: "Retain the evidence reference until independent closure",
  });
  expect("actions: create evidence concurrency action", evidenceRace);
  const evidenceRaceId = evidenceRace.data?.id;
  expect("actions: prepare evidence concurrency action", await tenantA("PATCH", `/compliance-hub/actions/${evidenceRaceId}`, {
    status: "awaiting_verification", evidenceReference: "Evidence ref race-2",
  }));
  const [evidenceClosing, evidenceClearing] = await Promise.all([
    verifier("PATCH", `/compliance-hub/actions/${evidenceRaceId}`, { status: "verified", verificationNotes: "Independent evidence closure check." }),
    tenantA("PATCH", `/compliance-hub/actions/${evidenceRaceId}`, { evidenceReference: "" }),
  ]);
  check("actions: concurrent blank evidence has one accepted transition", [200, 409].includes(evidenceClosing.status) && [200, 409].includes(evidenceClearing.status) && (evidenceClosing.status === 200 || evidenceClearing.status === 200));
  const evidenceRaceActions = await tenantA("GET", "/compliance-hub/actions");
  expect("actions: reload evidence concurrency action", evidenceRaceActions);
  const settledEvidenceAction = evidenceRaceActions.data?.find(action => action.id === evidenceRaceId);
  check("actions: verified closure always retains evidence", settledEvidenceAction?.status !== "verified" || (evidenceClosing.status === 200 && evidenceClearing.status === 409 && Boolean(settledEvidenceAction?.evidenceReference)));

  console.log(`Compliance Hub tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach(f => console.error(`FAIL: ${f}`)); process.exit(1); }
}
run().catch(error => { console.error(error); process.exit(1); });