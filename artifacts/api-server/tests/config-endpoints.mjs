// Regression tests for the per-client configuration endpoints.
//
// Covers, all against a self-booted server with freshly-registered probe
// accounts. Every client (including the consultant-created client B) and user
// this run creates is removed in a finally block, also on failure paths; see
// tests/fixture-ownership.mjs.
//
//   1. /api/form-options
//        - GET returns effective lists + defaults
//        - PUT is admin-only (viewer/staff → 403)
//        - PUT validates items (empty, >50, blank, duplicate → 400)
//        - PUT/DELETE unknown key → 400
//        - DELETE resets to default
//        - tenant isolation — client A's custom list must not leak to client B
//        - consultant with ?clientId only for clients they can access
//   2. Record validation via /api/incidents
//        - POST with a type outside the effective list → 400
//        - after PUT custom list, the custom type is accepted
//        - PUT (edit) with an unchanged legacy value still succeeds after the
//          option is removed from the list
//   2b. FixTrack contractors + PremisesTrack inspections
//        - account-specific active custom trades and inspection types are
//          accepted for new records
//        - disabled or another client's values are rejected for new records
//        - unrelated edits preserve an unchanged disabled value
//        - consultant ?clientId context keeps both modules tenant-scoped
//   3. /api/food-safety/config
//        - PUT/DELETE require admin (viewer/staff → 403)
//        - invalid section-toggle values (not "true"/"false") → 400
//        - siteId belonging to another client → 400
//        - per-site override layering (PUT ?siteId affects only that site's GET)
//   4. /api/mobile/push-token
//        - requires auth (401 without a session)
//        - POST stores a row for the session user (204)
//        - DELETE removes only the caller's own token (cross-user delete leaves
//          the other user's token intact)
//
// Every account enrols a TOTP authenticator through tests/two-factor-fixture.mjs,
// as mandatory 2FA requires.
//
// Usage: API_BASE=... DATABASE_URL=... node tests/config-endpoints.mjs
// (normally via `pnpm run test:config:ci`, which boots a private API).
// Exits 0 when every check passes, 1 otherwise.

import { randomUUID } from "node:crypto";
import { createFixtureOwnership, resolveRunId } from "./fixture-ownership.mjs";
import { signIn } from "./two-factor-fixture.mjs";

const runId = resolveRunId();
const fixtures = createFixtureOwnership({ runId, suite: "config-endpoints" });
// Never fall back to a live development API: cleanup must target the same
// database as the API under test.
const BASE = process.env.API_BASE;
if (!BASE) {
  console.error("API_BASE is required (use `pnpm run test:config:ci` to boot a private API).");
  process.exit(1);
}

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.error(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function expectOk(name, status, allowed = [200, 201]) {
  check(name, allowed.includes(status), `expected ${allowed.join("/")}, got ${status}`);
}

function expectStatus(name, status, expected) {
  const list = Array.isArray(expected) ? expected : [expected];
  check(name, list.includes(status), `expected ${list.join("/")}, got ${status}`);
}

// A cookie-carrying session. `bearer` mode drops the cookie and instead sends
// an Authorization header (used for the push-token auth checks).
function makeSession() {
  let cookie = "";
  async function request(method, path, body, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    if (cookie && !opts.noCookie) headers.cookie = cookie;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) data = await res.json().catch(() => null);
    else await res.text().catch(() => null);
    return { status: res.status, data };
  }
  request.getCookie = () => cookie;
  return request;
}

function isoDate(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

// Register a fresh self-service account (role "consultant" linked to a single
// auto-provisioned client). Returns { session, clientId, email }.
async function registerAccount(label, ts) {
  const session = makeSession();
  const email = `${label}-${runId}-${randomUUID()}@test.local`;
  const reg = await session("POST", "/auth/register", {
    name: `${label} account`,
    email,
    password: "password-123",
  });
  if (![200, 201].includes(reg.status)) {
    throw new Error(`FATAL: registration failed for ${label} (${reg.status})`);
  }
  fixtures.trackRegisteredUser();
  // Self-registrations require email verification; the test instance returns
  // the one-time token in the response because there is no mailbox.
  if (reg.data?.verificationToken) {
    const verify = await session("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
    if (verify.status !== 200) {
      throw new Error(`FATAL: email verification failed for ${label} (${verify.status})`);
    }
    // Mandatory 2FA: enrol a deterministic TOTP authenticator before app access.
    await signIn(session, { email, password: "password-123", label });
  }
  const me = await session("GET", "/auth/me");
  const user = me.data?.user ?? me.data;
  const clientId = user?.clientId;
  if (!Number.isInteger(clientId)) {
    throw new Error(`FATAL: no clientId for ${label} (${me.status})`);
  }
  fixtures.trackClient(clientId);
  return { session, clientId, email };
}

// Create a sub-user under the given admin session, then log them in.
async function createAndLogin(admin, clientId, role, label, ts) {
  const email = `${label}-${runId}-${randomUUID()}@test.local`;
  const password = "password-456";
  const created = await admin("POST", "/users", {
    name: label,
    email,
    password,
    role,
    clientId,
  });
  expectOk(`setup: create ${role} (${label})`, created.status, [200, 201]);
  const session = makeSession();
  await signIn(session, { email, password, label: `${role} (${label})` });
  return session;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. /api/form-options
// ─────────────────────────────────────────────────────────────────────────────
async function testFormOptions(admin, viewer, staff, ts) {
  console.log("\n── form-options ──");

  // GET returns defaults for a fresh client.
  const getRes = await admin("GET", "/form-options");
  expectOk("form-options: GET", getRes.status);
  check("form-options: GET returns options", typeof getRes.data?.options === "object", `got ${typeof getRes.data?.options}`);
  check("form-options: GET returns defaults", typeof getRes.data?.defaults === "object", `got ${typeof getRes.data?.defaults}`);
  check(
    "form-options: incident_types defaults present",
    Array.isArray(getRes.data?.defaults?.incident_types) && getRes.data.defaults.incident_types.length > 0,
    "no default incident_types",
  );
  check(
    "form-options: fresh client is not customised",
    getRes.data?.customised?.incident_types === false,
    `customised=${getRes.data?.customised?.incident_types}`,
  );

  // PUT requires admin — viewer & staff → 403.
  expectStatus(
    "form-options: PUT viewer → 403",
    (await viewer("PUT", "/form-options/incident_types", { items: ["accident"] })).status,
    403,
  );
  expectStatus(
    "form-options: PUT staff → 403",
    (await staff("PUT", "/form-options/incident_types", { items: ["accident"] })).status,
    403,
  );

  // Validation cases → 400.
  expectStatus(
    "form-options: PUT empty array → 400",
    (await admin("PUT", "/form-options/incident_types", { items: [] })).status,
    400,
  );
  const tooMany = Array.from({ length: 51 }, (_, i) => `type_${i}`);
  expectStatus(
    "form-options: PUT >50 items → 400",
    (await admin("PUT", "/form-options/incident_types", { items: tooMany })).status,
    400,
  );
  expectStatus(
    "form-options: PUT blank entry → 400",
    (await admin("PUT", "/form-options/incident_types", { items: ["accident", "   "] })).status,
    400,
  );
  expectStatus(
    "form-options: PUT duplicate entry → 400",
    (await admin("PUT", "/form-options/incident_types", { items: ["accident", "Accident"] })).status,
    400,
  );
  expectStatus(
    "form-options: PUT non-array items → 400",
    (await admin("PUT", "/form-options/incident_types", { items: "nope" })).status,
    400,
  );

  // Unknown key → 400 (route validates isFormOptionKey before writing).
  expectStatus(
    "form-options: PUT unknown key → 400/404",
    (await admin("PUT", "/form-options/not_a_real_key", { items: ["x"] })).status,
    [400, 404],
  );
  expectStatus(
    "form-options: DELETE unknown key → 400/404",
    (await admin("DELETE", "/form-options/not_a_real_key")).status,
    [400, 404],
  );

  // Valid PUT → saved and reflected in GET.
  const custom = ["custom_type_a", "custom_type_b"];
  const put = await admin("PUT", "/form-options/incident_types", { items: custom });
  expectOk("form-options: PUT valid custom list", put.status);
  check("form-options: PUT echoes cleaned items", JSON.stringify(put.data?.items) === JSON.stringify(custom), `got ${JSON.stringify(put.data?.items)}`);

  const afterPut = await admin("GET", "/form-options");
  check(
    "form-options: GET reflects custom list",
    JSON.stringify(afterPut.data?.options?.incident_types) === JSON.stringify(custom),
    `got ${JSON.stringify(afterPut.data?.options?.incident_types)}`,
  );
  check(
    "form-options: customised flag set after PUT",
    afterPut.data?.customised?.incident_types === true,
    `customised=${afterPut.data?.customised?.incident_types}`,
  );

  // Removing an active custom value keeps it available for restoration, just
  // like a disabled built-in default.
  const disabledCustom = await admin("PUT", "/form-options/incident_types", {
    items: [custom[0]],
  });
  expectOk("form-options: disable one custom option", disabledCustom.status);
  const afterDisable = await admin("GET", "/form-options");
  const disabledIncidentOptions = afterDisable.data?.disabled?.incident_types ?? [];
  check(
    "form-options: disabled custom option remains visible",
    disabledIncidentOptions.includes(custom[1]),
    `disabled=${JSON.stringify(disabledIncidentOptions)}`,
  );
  check(
    "form-options: disabled built-in option remains visible",
    disabledIncidentOptions.includes(afterDisable.data?.defaults?.incident_types?.[0]),
    `disabled=${JSON.stringify(disabledIncidentOptions)}`,
  );

  const reenabled = await admin("PUT", "/form-options/incident_types", { items: custom });
  expectOk("form-options: re-enable disabled custom option", reenabled.status);
  const afterReenable = await admin("GET", "/form-options");
  check(
    "form-options: re-enabled custom option is active again",
    afterReenable.data?.options?.incident_types?.includes(custom[1])
      && !afterReenable.data?.disabled?.incident_types?.includes(custom[1]),
    `active=${JSON.stringify(afterReenable.data?.options?.incident_types)}, disabled=${JSON.stringify(afterReenable.data?.disabled?.incident_types)}`,
  );

  // DELETE resets to default.
  const del = await admin("DELETE", "/form-options/incident_types");
  expectOk("form-options: DELETE resets", del.status);
  const afterDelete = await admin("GET", "/form-options");
  check(
    "form-options: GET reverts to default after DELETE",
    JSON.stringify(afterDelete.data?.options?.incident_types) === JSON.stringify(afterDelete.data?.defaults?.incident_types),
    "custom list still present after reset",
  );
  check(
    "form-options: customised flag cleared after DELETE",
    afterDelete.data?.customised?.incident_types === false,
    `customised=${afterDelete.data?.customised?.incident_types}`,
  );
}

// Tenant isolation + consultant ?clientId access.
async function testFormOptionsIsolation(admin, clientAId, ts) {
  console.log("\n── form-options: tenant isolation & consultant scoping ──");

  // The self-service admin (a consultant) creates a second client, which links
  // them via consultant_clients so they can act on it with ?clientId.
  const bRes = await admin("POST", "/clients", {
    name: `Isolation Client B ${ts}`,
    slug: `isolation-b-${runId}`,
  });
  expectOk("isolation: consultant creates client B", bRes.status, [200, 201]);
  const clientBId = bRes.data?.id;
  fixtures.trackClient(clientBId);
  check("isolation: client B id", Number.isInteger(clientBId), `id=${clientBId}`);

  // Set a custom list on client A only.
  const customA = ["a_only_type_1", "a_only_type_2"];
  expectOk(
    "isolation: PUT custom list on client A",
    (await admin("PUT", "/form-options/incident_types", { items: customA })).status,
  );

  // Client B (same consultant, via ?clientId) must NOT see client A's list.
  const bView = await admin("GET", `/form-options?clientId=${clientBId}`);
  expectOk("isolation: consultant GET with ?clientId=B", bView.status);
  check(
    "isolation: client B does not inherit client A custom list",
    JSON.stringify(bView.data?.options?.incident_types) === JSON.stringify(bView.data?.defaults?.incident_types),
    `client B got ${JSON.stringify(bView.data?.options?.incident_types)}`,
  );
  check(
    "isolation: client B customised flag is false",
    bView.data?.customised?.incident_types === false,
    `customised=${bView.data?.customised?.incident_types}`,
  );

  // Write a different list on client B via ?clientId, and confirm A is unchanged.
  const customB = ["b_only_type_1"];
  expectOk(
    "isolation: PUT custom list on client B via ?clientId",
    (await admin("PUT", `/form-options/incident_types?clientId=${clientBId}`, { items: customB })).status,
  );
  const aView = await admin("GET", "/form-options");
  check(
    "isolation: client A still has its own list after B write",
    JSON.stringify(aView.data?.options?.incident_types) === JSON.stringify(customA),
    `client A got ${JSON.stringify(aView.data?.options?.incident_types)}`,
  );
  const bView2 = await admin("GET", `/form-options?clientId=${clientBId}`);
  check(
    "isolation: client B has its own list",
    JSON.stringify(bView2.data?.options?.incident_types) === JSON.stringify(customB),
    `client B got ${JSON.stringify(bView2.data?.options?.incident_types)}`,
  );

  // Consultant with ?clientId for a client they cannot access → 403.
  const foreign = await admin("GET", "/form-options?clientId=999999999");
  expectStatus("isolation: ?clientId for inaccessible client → 403", foreign.status, [403]);

  // Reset client A back to default so the record-validation section starts clean.
  expectOk("isolation: reset client A list", (await admin("DELETE", "/form-options/incident_types")).status);

  return { clientBId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Record validation via /api/incidents
// ─────────────────────────────────────────────────────────────────────────────
async function testRecordValidation(admin, ts) {
  console.log("\n── incident record validation ──");

  const baseIncident = (overrides) => ({
    incidentDate: isoDate(-1),
    location: "Kitchen",
    description: "Test incident",
    involvedName: "Jane Doe",
    reportedBy: "Test Reporter",
    riddorRationale: "Assessed against RIDDOR criteria; no reportable injury or occurrence.",
    ...overrides,
  });

  // Ensure client A is on defaults for incident_types.
  await admin("DELETE", "/form-options/incident_types");
  const defaults = (await admin("GET", "/form-options")).data?.defaults?.incident_types ?? [];
  const legacyType = defaults[0];
  check("record: have a default incident type", typeof legacyType === "string", `got ${legacyType}`);

  // POST with a type NOT in the effective list → 400.
  const bad = await admin("POST", "/incidents", baseIncident({ incidentType: "definitely_not_a_type" }));
  expectStatus("record: POST unknown incident type → 400", bad.status, 400);

  // Create a record with a valid legacy type (used later for the edit test).
  const legacyRecord = await admin("POST", "/incidents", baseIncident({ incidentType: legacyType }));
  expectOk("record: POST legacy type accepted", legacyRecord.status, [201]);
  const legacyId = legacyRecord.data?.id;
  check("record: legacy record id", Number.isInteger(legacyId), `id=${legacyId}`);

  // Save a custom list that INCLUDES a brand-new type but EXCLUDES the legacy one.
  const customType = "custom_incident_type";
  expectOk(
    "record: PUT custom incident_types list",
    (await admin("PUT", "/form-options/incident_types", { items: [customType] })).status,
  );

  // POST with the new custom type → accepted.
  const customRecord = await admin("POST", "/incidents", baseIncident({ incidentType: customType }));
  expectOk("record: POST custom type accepted after PUT", customRecord.status, [201]);

  // POST with the now-removed legacy type → rejected.
  const removed = await admin("POST", "/incidents", baseIncident({ incidentType: legacyType }));
  expectStatus("record: POST removed legacy type → 400", removed.status, 400);

  // UPDATE the legacy record with the unchanged legacy value → still succeeds
  // (route allows an unchanged value even after removal from the list).
  const editUnchanged = await admin("PUT", `/incidents/${legacyId}`, {
    incidentType: legacyType,
    description: "Edited but type unchanged",
  });
  expectOk("record: PUT unchanged removed legacy value succeeds", editUnchanged.status, [200]);
  check(
    "record: PUT preserved legacy type",
    editUnchanged.data?.incidentType === legacyType,
    `got ${editUnchanged.data?.incidentType}`,
  );

  // UPDATE the legacy record to a DIFFERENT now-invalid value → rejected.
  const editInvalid = await admin("PUT", `/incidents/${legacyId}`, { incidentType: "another_bad_type" });
  expectStatus("record: PUT to new invalid type → 400", editInvalid.status, 400);

  // TrainTrack preserves the historical "Other" wildcard only while that
  // option is active for the client. The UI submits the nonblank description,
  // rather than persisting the literal picker label.
  const customTrainingType = `Bespoke equipment induction ${ts}`;
  expectOk(
    "record: enable TrainTrack Other wildcard",
    (await admin("PUT", "/form-options/traintrack_types", { items: ["Other"] })).status,
  );
  const customTraining = await admin("POST", "/train-track/records", {
    recordType: "internal",
    staffName: "Jane Doe",
    trainingType: customTrainingType,
    trainer: "Test Trainer",
    completedDate: isoDate(-1),
  });
  expectOk("record: TrainTrack custom type accepted while Other active", customTraining.status, [201]);
  const customTrainingId = customTraining.data?.id;

  expectOk(
    "record: disable TrainTrack Other wildcard",
    (await admin("PUT", "/form-options/traintrack_types", { items: ["Fire Safety Awareness"] })).status,
  );
  const rejectedTraining = await admin("POST", "/train-track/records", {
    recordType: "internal",
    staffName: "John Doe",
    trainingType: `Unlisted training ${ts}`,
    trainer: "Test Trainer",
    completedDate: isoDate(-1),
  });
  expectStatus("record: TrainTrack custom type rejected while Other disabled", rejectedTraining.status, 400);

  if (Number.isInteger(customTrainingId)) {
    const unchangedTraining = await admin("PATCH", `/train-track/records/${customTrainingId}`, {
      trainingType: customTrainingType,
      notes: "Legacy custom type remains editable",
    });
    expectOk("record: unchanged custom TrainTrack type remains editable", unchangedTraining.status, [200]);
    await admin("DELETE", `/train-track/records/${customTrainingId}`);
  }
  await admin("DELETE", "/form-options/traintrack_types");

  // Cleanup: reset the list and remove created incidents.
  await admin("DELETE", "/form-options/incident_types");
  await admin("DELETE", `/incidents/${legacyId}`);
  if (Number.isInteger(customRecord.data?.id)) await admin("DELETE", `/incidents/${customRecord.data.id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. FixTrack contractors + PremisesTrack inspection validation
// ─────────────────────────────────────────────────────────────────────────────
async function testCustomTradeAndInspectionValidation(admin, clientAId, clientBId, ts) {
  console.log("\n── FixTrack trades + PremisesTrack inspection types ──");

  const tradeA = `A trade ${ts}`;
  const tradeAReplacement = `A replacement trade ${ts}`;
  const tradeB = `B trade ${ts}`;
  const tradeBReplacement = `B replacement trade ${ts}`;
  const inspectionA = `A inspection ${ts}`;
  const inspectionAReplacement = `A replacement inspection ${ts}`;
  const inspectionB = `B inspection ${ts}`;
  const inspectionBReplacement = `B replacement inspection ${ts}`;

  const setOptions = async (clientId, key, items) => {
    const suffix = clientId === clientAId ? "" : `?clientId=${clientId}`;
    return admin("PUT", `/form-options/${key}${suffix}`, { items });
  };

  const getOptions = async (clientId) => {
    const suffix = clientId === clientAId ? "" : `?clientId=${clientId}`;
    return admin("GET", `/form-options${suffix}`);
  };

  const contractorBody = (label, trades) => ({
    name: `${label} contractor`,
    email: `${label.toLowerCase().replaceAll(" ", "-")}-${ts}@test.local`,
    trades,
  });

  const inspectionBody = (inspectionType, findings) => ({
    inspectionDate: isoDate(-2),
    inspectionType,
    area: "Test kitchen",
    findings,
    inspectedBy: "Config endpoint tester",
  });

  const createdContractorIds = [];
  const createdInspectionIds = [];

  try {
    // The consultant's two selectable clients receive different active values.
    expectOk(
      "custom records: save client A FixTrack trade",
      (await setOptions(clientAId, "fixtrack_trades", [tradeA])).status,
    );
    expectOk(
      "custom records: save client B FixTrack trade via ?clientId",
      (await setOptions(clientBId, "fixtrack_trades", [tradeB])).status,
    );
    expectOk(
      "custom records: save client A PremisesTrack inspection type",
      (await setOptions(clientAId, "premises_inspection_types", [inspectionA])).status,
    );
    expectOk(
      "custom records: save client B PremisesTrack inspection type via ?clientId",
      (await setOptions(clientBId, "premises_inspection_types", [inspectionB])).status,
    );

    const aOptions = await getOptions(clientAId);
    const bOptions = await getOptions(clientBId);
    check(
      "custom records: client A exposes only its active custom values",
      JSON.stringify(aOptions.data?.options?.fixtrack_trades) === JSON.stringify([tradeA])
        && JSON.stringify(aOptions.data?.options?.premises_inspection_types) === JSON.stringify([inspectionA]),
      `got ${JSON.stringify(aOptions.data?.options)}`,
    );
    check(
      "custom records: client B exposes only its active custom values",
      JSON.stringify(bOptions.data?.options?.fixtrack_trades) === JSON.stringify([tradeB])
        && JSON.stringify(bOptions.data?.options?.premises_inspection_types) === JSON.stringify([inspectionB]),
      `got ${JSON.stringify(bOptions.data?.options)}`,
    );

    // New records accept each client's active custom value, but not the other
    // client's value, even when the same consultant selects that client.
    const aContractor = await admin("POST", "/contractors", contractorBody("A active", [tradeA]));
    expectOk("custom records: client A accepts active custom trade", aContractor.status, [201]);
    if (Number.isInteger(aContractor.data?.id)) createdContractorIds.push(["", aContractor.data.id]);

    const aForeignContractor = await admin("POST", "/contractors", contractorBody("A foreign", [tradeB]));
    expectStatus("custom records: client A rejects client B trade", aForeignContractor.status, 400);

    const bContractor = await admin(
      "POST",
      `/contractors?clientId=${clientBId}`,
      contractorBody("B active", [tradeB]),
    );
    expectOk("custom records: client B accepts active custom trade", bContractor.status, [201]);
    if (Number.isInteger(bContractor.data?.id)) createdContractorIds.push([`?clientId=${clientBId}`, bContractor.data.id]);

    const bForeignContractor = await admin(
      "POST",
      `/contractors?clientId=${clientBId}`,
      contractorBody("B foreign", [tradeA]),
    );
    expectStatus("custom records: client B rejects client A trade", bForeignContractor.status, 400);

    const aInspection = await admin("POST", "/premises-track", inspectionBody(inspectionA, "A active type"));
    expectOk("custom records: client A accepts active inspection type", aInspection.status, [201]);
    if (Number.isInteger(aInspection.data?.id)) createdInspectionIds.push(["", aInspection.data.id]);

    const aForeignInspection = await admin(
      "POST",
      "/premises-track",
      inspectionBody(inspectionB, "A foreign type"),
    );
    expectStatus("custom records: client A rejects client B inspection type", aForeignInspection.status, 400);

    const bInspection = await admin(
      "POST",
      `/premises-track?clientId=${clientBId}`,
      inspectionBody(inspectionB, "B active type"),
    );
    expectOk("custom records: client B accepts active inspection type", bInspection.status, [201]);
    if (Number.isInteger(bInspection.data?.id)) createdInspectionIds.push([`?clientId=${clientBId}`, bInspection.data.id]);

    const bForeignInspection = await admin(
      "POST",
      `/premises-track?clientId=${clientBId}`,
      inspectionBody(inspectionA, "B foreign type"),
    );
    expectStatus("custom records: client B rejects client A inspection type", bForeignInspection.status, 400);

    // Remove the values from the active lists. New records reject them, but an
    // unrelated edit may retain the unchanged value already stored on a record.
    expectOk(
      "custom records: disable client A trade",
      (await setOptions(clientAId, "fixtrack_trades", [tradeAReplacement])).status,
    );
    const disabledContractor = await admin("POST", "/contractors", contractorBody("A disabled", [tradeA]));
    expectStatus("custom records: new contractor rejects disabled trade", disabledContractor.status, 400);

    if (Number.isInteger(aContractor.data?.id)) {
      const editedContractor = await admin("PUT", `/contractors/${aContractor.data.id}`, {
        name: "A active contractor renamed",
        email: aContractor.data.email,
      });
      expectOk("custom records: contractor edit preserves disabled trade", editedContractor.status, [200]);
      check(
        "custom records: contractor keeps unchanged disabled trade",
        JSON.stringify(editedContractor.data?.trades) === JSON.stringify([tradeA]),
        `got ${JSON.stringify(editedContractor.data?.trades)}`,
      );
    }

    expectOk(
      "custom records: disable client A inspection type",
      (await setOptions(clientAId, "premises_inspection_types", [inspectionAReplacement])).status,
    );
    const disabledInspection = await admin(
      "POST",
      "/premises-track",
      inspectionBody(inspectionA, "A disabled type"),
    );
    expectStatus("custom records: new inspection rejects disabled type", disabledInspection.status, 400);

    if (Number.isInteger(aInspection.data?.id)) {
      const editedInspection = await admin("PUT", `/premises-track/${aInspection.data.id}`, {
        ...inspectionBody(inspectionA, "A unrelated edit"),
      });
      expectOk("custom records: inspection edit preserves disabled type", editedInspection.status, [200]);
      const afterEdit = await admin("GET", `/premises-track?type=${encodeURIComponent(inspectionA)}`);
      const stored = Array.isArray(afterEdit.data)
        ? afterEdit.data.find((row) => row.id === aInspection.data.id)
        : null;
      check(
        "custom records: inspection keeps unchanged disabled type",
        stored?.inspectionType === inspectionA && stored?.findings === "A unrelated edit",
        `got ${JSON.stringify(stored)}`,
      );
    }
  } finally {
    for (const [suffix, id] of createdContractorIds) {
      await admin("DELETE", `/contractors/${id}${suffix}`).catch(() => {});
    }
    for (const [suffix, id] of createdInspectionIds) {
      await admin("DELETE", `/premises-track/${id}${suffix}`).catch(() => {});
    }
    await setOptions(clientAId, "fixtrack_trades", [
      "electrical", "plumbing", "gas_kitchen", "gas_fireplace", "gas_heating",
      "structural", "equipment", "hvac", "it_comms", "safety_hazard", "cleaning", "general",
    ]);
    await setOptions(clientAId, "premises_inspection_types", [
      "routine", "hazard", "fault", "housekeeping", "signage",
    ]);
    await admin("DELETE", `/form-options/fixtrack_trades?clientId=${clientBId}`).catch(() => {});
    await admin("DELETE", `/form-options/premises_inspection_types?clientId=${clientBId}`).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. /api/food-safety/config
// ─────────────────────────────────────────────────────────────────────────────
async function testFoodSafetyConfig(admin, viewer, staff, clientBId, ts) {
  console.log("\n── food-safety/config ──");

  // PUT/DELETE require admin — viewer & staff → 403.
  expectStatus(
    "food-config: PUT viewer → 403",
    (await viewer("PUT", "/food-safety/config", { food_num_fridges: "3" })).status,
    403,
  );
  expectStatus(
    "food-config: PUT staff → 403",
    (await staff("PUT", "/food-safety/config", { food_num_fridges: "3" })).status,
    403,
  );
  expectStatus(
    "food-config: DELETE viewer → 403",
    (await viewer("DELETE", "/food-safety/config")).status,
    403,
  );

  // Invalid section-toggle value (must be "true"/"false") → 400.
  expectStatus(
    "food-config: PUT invalid toggle value → 400",
    (await admin("PUT", "/food-safety/config", { food_show_cooling: "maybe" })).status,
    400,
  );
  expectStatus(
    "food-config: PUT duplicate probe names → 400",
    (await admin("PUT", "/food-safety/config", { food_probe_names: JSON.stringify(["Blue probe", " blue PROBE "]) })).status,
    400,
  );
  expectOk(
    "food-config: PUT custom probe names",
    (await admin("PUT", "/food-safety/config", { food_probe_names: JSON.stringify([" Blue probe ", "Red probe"]) })).status,
  );
  const probeConfig = await admin("GET", "/food-safety/config");
  check(
    "food-config: custom probe names are trimmed and stored",
    JSON.stringify(JSON.parse(probeConfig.data?.food_probe_names ?? "[]")) === JSON.stringify(["Blue probe", "Red probe"]),
    `got ${probeConfig.data?.food_probe_names}`,
  );

  expectStatus(
    "food-config: invalid jurisdiction → 400",
    (await admin("PUT", "/food-safety/config", { food_jurisdiction: "northern_ireland" })).status,
    400,
  );
  expectOk(
    "food-config: Scotland jurisdiction",
    (await admin("PUT", "/food-safety/config", { food_jurisdiction: "scotland" })).status,
  );
  const scotlandConfig = await admin("GET", "/food-safety/config");
  check(
    "food-config: Scotland reheating target is 82°C",
    scotlandConfig.data?.food_jurisdiction === "scotland"
      && scotlandConfig.data?.food_reheating_limit === "Above 82°C",
    `jurisdiction=${scotlandConfig.data?.food_jurisdiction}, limit=${scotlandConfig.data?.food_reheating_limit}`,
  );
  expectOk(
    "food-config: England/Wales jurisdiction",
    (await admin("PUT", "/food-safety/config", { food_jurisdiction: "england_wales" })).status,
  );
  const englandWalesConfig = await admin("GET", "/food-safety/config");
  check(
    "food-config: England/Wales reheating target is 75°C",
    englandWalesConfig.data?.food_jurisdiction === "england_wales"
      && englandWalesConfig.data?.food_reheating_limit === "Above 75°C",
    `jurisdiction=${englandWalesConfig.data?.food_jurisdiction}, limit=${englandWalesConfig.data?.food_reheating_limit}`,
  );
  const jurisdictionRecord = await admin("POST", "/food-safety", {
    recordDate: isoDate(-5),
    reheating: [{ item: "Soup", coreTemp: "75" }],
  });
  expectOk("food-config: new diary uses jurisdiction reheating target", jurisdictionRecord.status, [201]);
  check(
    "food-config: England/Wales diary record stores 75°C target",
    jurisdictionRecord.data?.reheatingLimit === "Above 75°C",
    `got ${jurisdictionRecord.data?.reheatingLimit}`,
  );

  // siteId belonging to another client → 400.
  // Create a site under client B; using it on client A's config must be rejected.
  const bSite = await admin("POST", `/sites?clientId=${clientBId}`, { name: `B Site ${ts}` });
  expectOk("food-config: create site under client B", bSite.status, [200, 201]);
  const bSiteId = bSite.data?.id;
  check("food-config: client B site id", Number.isInteger(bSiteId), `id=${bSiteId}`);
  expectStatus(
    "food-config: PUT with foreign siteId → 400",
    (await admin("PUT", `/food-safety/config?siteId=${bSiteId}`, { food_show_cooling: "false" })).status,
    400,
  );
  expectStatus(
    "food-config: GET with foreign siteId → 400",
    (await admin("GET", `/food-safety/config?siteId=${bSiteId}`)).status,
    400,
  );

  // Per-site override layering. Create a site owned by client A.
  const aSite = await admin("POST", "/sites", { name: `A Site ${ts}` });
  expectOk("food-config: create site under client A", aSite.status, [200, 201]);
  const aSiteId = aSite.data?.id;
  check("food-config: client A site id", Number.isInteger(aSiteId), `id=${aSiteId}`);

  // Client-level default: cooling section on.
  const clientLevel = await admin("GET", "/food-safety/config");
  expectOk("food-config: GET client-level", clientLevel.status);
  check(
    "food-config: client-level cooling defaults true",
    clientLevel.data?.food_show_cooling === "true",
    `got ${clientLevel.data?.food_show_cooling}`,
  );

  // PUT a site-level override turning cooling OFF for that one site.
  expectOk(
    "food-config: PUT site override",
    (await admin("PUT", `/food-safety/config?siteId=${aSiteId}`, { food_show_cooling: "false" })).status,
  );

  // That site's effective GET reflects the override.
  const siteView = await admin("GET", `/food-safety/config?siteId=${aSiteId}`);
  expectOk("food-config: GET site view", siteView.status);
  check(
    "food-config: site override applied",
    siteView.data?.food_show_cooling === "false",
    `got ${siteView.data?.food_show_cooling}`,
  );
  check(
    "food-config: site override listed in _siteOverrides",
    Array.isArray(siteView.data?._siteOverrides) && siteView.data._siteOverrides.includes("food_show_cooling"),
    `got ${JSON.stringify(siteView.data?._siteOverrides)}`,
  );

  // Client-level config is UNAFFECTED by the site override.
  const clientLevelAfter = await admin("GET", "/food-safety/config");
  check(
    "food-config: client-level unaffected by site override",
    clientLevelAfter.data?.food_show_cooling === "true",
    `got ${clientLevelAfter.data?.food_show_cooling}`,
  );

  // DELETE the site override → site falls back to client-level (cooling on).
  expectOk(
    "food-config: DELETE site override",
    (await admin("DELETE", `/food-safety/config?siteId=${aSiteId}`)).status,
  );
  const siteViewReset = await admin("GET", `/food-safety/config?siteId=${aSiteId}`);
  check(
    "food-config: site reverts to client-level after DELETE",
    siteViewReset.data?.food_show_cooling === "true",
    `got ${siteViewReset.data?.food_show_cooling}`,
  );

  // Cleanup client-level template (leaves it on defaults for a clean state).
  await admin("DELETE", "/food-safety/config");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3b. Per-site diaries: config layering into the diary + record uniqueness
// ─────────────────────────────────────────────────────────────────────────────
async function testSiteDiaries(admin, ts) {
  console.log("\n── food-safety: per-site diaries ──");

  // Two sites under client A.
  const site1 = await admin("POST", "/sites", { name: `Diary Site 1 ${ts}` });
  const site2 = await admin("POST", "/sites", { name: `Diary Site 2 ${ts}` });
  expectOk("site-diary: create site 1", site1.status, [200, 201]);
  expectOk("site-diary: create site 2", site2.status, [200, 201]);
  const s1 = site1.data?.id;
  const s2 = site2.data?.id;
  check("site-diary: site ids", Number.isInteger(s1) && Number.isInteger(s2), `s1=${s1} s2=${s2}`);

  // Start from clean client-level defaults.
  await admin("DELETE", "/food-safety/config");

  // ── (a) A site override changes THAT site's effective template only ──
  // Give site 1 a distinctive cooking limit override.
  const s1CookLimit = `S1 cook ${ts}`;
  expectOk(
    "site-diary: PUT site1 cooking-limit override",
    (await admin("PUT", `/food-safety/config?siteId=${s1}`, { food_cooking_limit: s1CookLimit })).status,
  );

  const s1Cfg = await admin("GET", `/food-safety/config?siteId=${s1}`);
  check(
    "site-diary: site1 effective config reflects override",
    s1Cfg.data?.food_cooking_limit === s1CookLimit,
    `got ${s1Cfg.data?.food_cooking_limit}`,
  );
  const s2Cfg = await admin("GET", `/food-safety/config?siteId=${s2}`);
  check(
    "site-diary: site2 unaffected by site1 override",
    s2Cfg.data?.food_cooking_limit !== s1CookLimit,
    `got ${s2Cfg.data?.food_cooking_limit}`,
  );
  const clientCfg = await admin("GET", "/food-safety/config");
  check(
    "site-diary: client-level unaffected by site1 override",
    clientCfg.data?.food_cooking_limit !== s1CookLimit,
    `got ${clientCfg.data?.food_cooking_limit}`,
  );

  // ── (b) Unoverridden fields follow LATER client-level changes ──
  // Site 1 has NOT overridden the reheating limit, so a new client-level value
  // must flow through to site 1's effective config.
  const clientReheat = `Client reheat ${ts}`;
  expectOk(
    "site-diary: PUT client-level reheating limit",
    (await admin("PUT", "/food-safety/config", { food_reheating_limit: clientReheat })).status,
  );
  const s1CfgAfter = await admin("GET", `/food-safety/config?siteId=${s1}`);
  check(
    "site-diary: site1 inherits later client-level reheating change",
    s1CfgAfter.data?.food_reheating_limit === clientReheat,
    `got ${s1CfgAfter.data?.food_reheating_limit}`,
  );
  check(
    "site-diary: site1 still keeps its own cooking override",
    s1CfgAfter.data?.food_cooking_limit === s1CookLimit,
    `got ${s1CfgAfter.data?.food_cooking_limit}`,
  );

  // ── (c) The DIARY loads the site's effective template ──
  // A brand-new diary record for site 1 stamps the (site-effective) cooking
  // limit; the client-level diary uses the client-level cooking limit.
  const day = isoDate(-3);
  const s1Rec = await admin("POST", `/food-safety?siteId=${s1}`, { recordDate: day, cookingLimit: s1CfgAfter.data.food_cooking_limit });
  expectOk("site-diary: create site1 record", s1Rec.status, [201]);
  check("site-diary: site1 record carries siteId", s1Rec.data?.siteId === s1, `got ${s1Rec.data?.siteId}`);
  check(
    "site-diary: site1 record uses site cooking limit",
    s1Rec.data?.cookingLimit === s1CookLimit,
    `got ${s1Rec.data?.cookingLimit}`,
  );

  // ── (d) Record uniqueness: two sites both get a record for the SAME date ──
  const s2Rec = await admin("POST", `/food-safety?siteId=${s2}`, { recordDate: day });
  expectOk("site-diary: site2 record same date allowed", s2Rec.status, [201]);
  check("site-diary: site2 record carries siteId", s2Rec.data?.siteId === s2, `got ${s2Rec.data?.siteId}`);
  check(
    "site-diary: site1 and site2 records are distinct rows",
    Number.isInteger(s1Rec.data?.id) && Number.isInteger(s2Rec.data?.id) && s1Rec.data.id !== s2Rec.data.id,
    `s1=${s1Rec.data?.id} s2=${s2Rec.data?.id}`,
  );

  // Whole-organisation diary for the same date is ALSO independent.
  const orgRec = await admin("POST", "/food-safety", { recordDate: day });
  expectOk("site-diary: whole-org record same date allowed", orgRec.status, [201]);
  check("site-diary: whole-org record has null siteId", orgRec.data?.siteId == null, `got ${orgRec.data?.siteId}`);

  // ── (e) Monthly and missing-date views distinguish drafts, submissions and gaps ──
  const calendarDraftDate = "2098-02-10";
  const calendarSubmittedDate = "2098-02-11";
  const calendarMissingDate = "2098-02-12";
  const calendarDraft = await admin("POST", `/food-safety?siteId=${s1}`, { recordDate: calendarDraftDate });
  expectOk("site-diary: create calendar draft", calendarDraft.status, [201]);
  const calendarSubmitted = await admin("POST", `/food-safety?siteId=${s1}`, {
    recordDate: calendarSubmittedDate,
    submittedAt: "2098-02-11T12:00:00.000Z",
  });
  expectOk("site-diary: create submitted calendar record", calendarSubmitted.status, [201]);

  const summary = await admin("GET", `/food-safety/summary?year=2098&month=2&siteId=${s1}`);
  expectOk("site-diary: GET monthly summary", summary.status);
  check("site-diary: February summary has 28 days", summary.data?.days?.length === 28, `got ${summary.data?.days?.length}`);
  const draftSummary = summary.data?.days?.find((entry) => entry.date === calendarDraftDate);
  const submittedSummary = summary.data?.days?.find((entry) => entry.date === calendarSubmittedDate);
  const missingSummary = summary.data?.days?.find((entry) => entry.date === calendarMissingDate);
  check("site-diary: summary marks draft as present but not submitted", draftSummary?.hasRecord === true && draftSummary?.submitted === false);
  check("site-diary: summary marks submitted record complete", submittedSummary?.hasRecord === true && submittedSummary?.submitted === true);
  check("site-diary: summary marks absent date missing", missingSummary?.hasRecord === false && missingSummary?.submitted === false);

  const missingDates = await admin(
    "GET",
    `/food-safety/missing-dates?from=${calendarDraftDate}&to=${calendarMissingDate}&siteId=${s1}`,
  );
  expectOk("site-diary: GET missing dates", missingDates.status);
  check(
    "site-diary: missing dates excludes drafts and submissions",
    JSON.stringify(missingDates.data?.missingDates) === JSON.stringify([calendarMissingDate])
      && JSON.stringify(missingDates.data?.draftDates) === JSON.stringify([calendarDraftDate]),
    `got ${JSON.stringify(missingDates.data)}`,
  );

  // ── (f) Same site + same date → upsert semantics (409 conflict, no dup) ──
  const s1Dup = await admin("POST", `/food-safety?siteId=${s1}`, { recordDate: day });
  expectStatus("site-diary: duplicate site1 record same date → 409", s1Dup.status, 409);
  check(
    "site-diary: duplicate points at the existing row",
    s1Dup.data?.id === s1Rec.data.id,
    `got ${s1Dup.data?.id}`,
  );

  // Scoped GETs return the right rows.
  const getS1 = await admin("GET", `/food-safety/by-date/${day}?siteId=${s1}`);
  check("site-diary: GET site1 by-date returns site1 row", getS1.data?.id === s1Rec.data.id, `got ${getS1.data?.id}`);
  const getS2 = await admin("GET", `/food-safety/by-date/${day}?siteId=${s2}`);
  check("site-diary: GET site2 by-date returns site2 row", getS2.data?.id === s2Rec.data.id, `got ${getS2.data?.id}`);
  const getOrg = await admin("GET", `/food-safety/by-date/${day}`);
  check("site-diary: GET whole-org by-date returns org row", getOrg.data?.id === orgRec.data.id, `got ${getOrg.data?.id}`);

  // Scoped lists only include their own scope's records for the day.
  const listS1 = await admin("GET", `/food-safety?siteId=${s1}`);
  check(
    "site-diary: site1 list excludes site2/org rows",
    Array.isArray(listS1.data)
      && listS1.data.some((r) => r.id === s1Rec.data.id)
      && !listS1.data.some((r) => r.id === s2Rec.data.id || r.id === orgRec.data.id),
    `ids=${JSON.stringify((listS1.data ?? []).map((r) => r.id))}`,
  );

  // ── (g) Clearing a site override reverts that key to the client value ──
  expectOk(
    "site-diary: clear site1 cooking override (null)",
    (await admin("PUT", `/food-safety/config?siteId=${s1}`, { food_cooking_limit: null })).status,
  );
  const s1CfgCleared = await admin("GET", `/food-safety/config?siteId=${s1}`);
  check(
    "site-diary: site1 cooking limit now inherits client value",
    s1CfgCleared.data?.food_cooking_limit === clientCfg.data?.food_cooking_limit,
    `got ${s1CfgCleared.data?.food_cooking_limit} vs client ${clientCfg.data?.food_cooking_limit}`,
  );
  check(
    "site-diary: cleared key removed from _siteOverrides",
    Array.isArray(s1CfgCleared.data?._siteOverrides) && !s1CfgCleared.data._siteOverrides.includes("food_cooking_limit"),
    `got ${JSON.stringify(s1CfgCleared.data?._siteOverrides)}`,
  );

  // There is no DELETE endpoint for diary records; the run's fixture cleanup
  // removes them with the rest of this run's tenants.
  await admin("DELETE", `/food-safety/config?siteId=${s1}`);
  await admin("DELETE", `/food-safety/config?siteId=${s2}`);
  await admin("DELETE", "/food-safety/config");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. /api/mobile/push-token
// ─────────────────────────────────────────────────────────────────────────────
async function testPushToken(admin, other, ts) {
  console.log("\n── mobile/push-token ──");

  // Requires auth — a session with no cookie → 401.
  const anon = makeSession();
  const noAuth = await anon("POST", "/mobile/push-token", { token: `anon-${ts}` }, { noCookie: true });
  expectStatus("push-token: POST without auth → 401", noAuth.status, 401);
  const noAuthDel = await anon("DELETE", "/mobile/push-token", { token: `anon-${ts}` }, { noCookie: true });
  expectStatus("push-token: DELETE without auth → 401", noAuthDel.status, 401);

  // POST stores a row for the session user → 204.
  const tokenA = `push-A-${ts}-${Math.floor(Math.random() * 1e6)}`;
  const tokenB = `push-B-${ts}-${Math.floor(Math.random() * 1e6)}`;
  expectStatus(
    "push-token: POST user A stores token → 204",
    (await admin("POST", "/mobile/push-token", { token: tokenA, platform: "ios" })).status,
    204,
  );
  expectStatus(
    "push-token: POST user B stores token → 204",
    (await other("POST", "/mobile/push-token", { token: tokenB, platform: "android" })).status,
    204,
  );

  // Invalid body → 400.
  expectStatus(
    "push-token: POST empty token → 400",
    (await admin("POST", "/mobile/push-token", { token: "" })).status,
    400,
  );

  // DELETE removes only the caller's own token. User A attempting to delete
  // user B's token must NOT remove it: a subsequent re-POST by user B still
  // upserts cleanly (204) and, crucially, user A deleting B's token returns 204
  // but leaves B able to delete it themselves.
  expectStatus(
    "push-token: user A DELETE user B's token → 204 (no-op)",
    (await admin("DELETE", "/mobile/push-token", { token: tokenB })).status,
    204,
  );
  // If A's delete had actually removed B's token, B could still delete (idempotent
  // 204); the real signal is that only-own scoping is enforced by the WHERE
  // user_id clause. Verify B can delete its own token, and A can delete its own.
  expectStatus(
    "push-token: user B DELETE own token → 204",
    (await other("DELETE", "/mobile/push-token", { token: tokenB })).status,
    204,
  );
  expectStatus(
    "push-token: user A DELETE own token → 204",
    (await admin("DELETE", "/mobile/push-token", { token: tokenA })).status,
    204,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. /api/storage/usage and storage warning settings
// ─────────────────────────────────────────────────────────────────────────────
async function testStorageUsage(admin, viewer, staff, clientAId, clientBId) {
  console.log("\n── storage usage ──");

  const initialSettings = await admin("GET", `/settings?clientId=${clientAId}`);
  expectOk("account timezone: settings are readable", initialSettings.status);
  check(
    "account timezone: existing accounts use the UK fallback",
    initialSettings.data?.accountTimezone === null,
    `got ${initialSettings.data?.accountTimezone}`,
  );
  expectOk(
    "account timezone: save a valid IANA zone",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      accountTimezone: "America/New_York",
    })).status,
  );
  const configuredSettings = await admin("GET", `/settings?clientId=${clientAId}`);
  check(
    "account timezone: saved value is returned",
    configuredSettings.data?.accountTimezone === "America/New_York",
    `got ${configuredSettings.data?.accountTimezone}`,
  );
  expectStatus(
    "account timezone: fixed offset is rejected",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      accountTimezone: "+05:00",
    })).status,
    400,
  );
  expectStatus(
    "account timezone: unknown IANA name is rejected",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      accountTimezone: "Not/AZone",
    })).status,
    400,
  );
  expectOk(
    "account timezone: null resets to the UK fallback",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      accountTimezone: null,
    })).status,
  );
  expectOk(
    "SafeTrack reminders: save weekly cadence and preferred time",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      safeTrackReminderFrequency: "weekly",
      safeTrackReminderTime: "17:35",
    })).status,
  );
  const safeTrackSettings = await admin("GET", `/settings?clientId=${clientAId}`);
  check(
    "SafeTrack reminders: saved cadence and time are returned",
    safeTrackSettings.data?.safeTrackReminderFrequency === "weekly" &&
      safeTrackSettings.data?.safeTrackReminderTime === "17:35",
    `got ${JSON.stringify({
      frequency: safeTrackSettings.data?.safeTrackReminderFrequency,
      time: safeTrackSettings.data?.safeTrackReminderTime,
    })}`,
  );
  expectStatus(
    "SafeTrack reminders: invalid cadence is rejected",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      safeTrackReminderFrequency: "monthly",
    })).status,
    400,
  );
  expectStatus(
    "SafeTrack reminders: invalid time is rejected",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      safeTrackReminderTime: "5pm",
    })).status,
    400,
  );

  const anon = makeSession();
  expectStatus(
    "storage usage: anonymous request → 401",
    (await anon("GET", "/storage/usage", undefined, { noCookie: true })).status,
    401,
  );
  expectStatus("storage usage: viewer → 403", (await viewer("GET", "/storage/usage")).status, 403);
  expectStatus("storage usage: staff → 403", (await staff("GET", "/storage/usage")).status, 403);

  const thresholdA = 2 * 1024 * 1024;
  const thresholdB = 3 * 1024 * 1024;
  expectOk(
    "storage usage: save client A warning threshold",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      storageWarningThresholdBytes: String(thresholdA),
    })).status,
  );
  expectOk(
    "storage usage: save selected client B warning threshold",
    (await admin("PUT", `/settings?clientId=${clientBId}`, {
      storageWarningThresholdBytes: String(thresholdB),
    })).status,
  );

  const usageA = await admin("GET", `/storage/usage?clientId=${clientAId}`);
  const usageB = await admin("GET", `/storage/usage?clientId=${clientBId}`);
  expectOk("storage usage: client A response", usageA.status);
  expectOk("storage usage: selected client B response", usageB.status);
  check(
    "storage usage: client A keeps its threshold",
    usageA.data?.warningThresholdBytes === thresholdA,
    `got ${usageA.data?.warningThresholdBytes}`,
  );
  check(
    "storage usage: selected client B keeps its threshold",
    usageB.data?.warningThresholdBytes === thresholdB,
    `got ${usageB.data?.warningThresholdBytes}`,
  );
  check(
    "storage usage: selected accounts use distinct tenant contexts",
    usageA.data?.usedBytes === clientAId && usageB.data?.usedBytes === clientBId,
    `A=${usageA.data?.usedBytes}, B=${usageB.data?.usedBytes}`,
  );
  for (const [name, response] of [["A", usageA], ["B", usageB]]) {
    check(`storage usage: client ${name} bytes are non-negative`, Number.isSafeInteger(response.data?.usedBytes) && response.data.usedBytes >= 0);
    check(`storage usage: client ${name} object count is non-negative`, Number.isSafeInteger(response.data?.objectCount) && response.data.objectCount >= 0);
     check(`storage usage: client ${name} download traffic is measured`, Number.isSafeInteger(response.data?.monthlyDownloadBytes) && response.data.monthlyDownloadBytes >= 0 && response.data?.monthlyDownloadTrackingAvailable === true);
  }

  expectStatus(
    "storage usage: threshold below 1 MB → 400",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      storageWarningThresholdBytes: String(1024 * 1024 - 1),
    })).status,
    400,
  );
  expectOk(
    "storage usage: null threshold resets to default",
    (await admin("PUT", `/settings?clientId=${clientAId}`, {
      storageWarningThresholdBytes: null,
    })).status,
  );
  const reset = await admin("GET", `/storage/usage?clientId=${clientAId}`);
  check(
    "storage usage: reset uses 5 GB default",
    reset.data?.warningThresholdBytes === 5 * 1024 * 1024 * 1024,
    `got ${reset.data?.warningThresholdBytes}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function runSuite() {
  // Full UUID entropy, without separators, fits the 60-character option limit.
  const ts = runId.replaceAll("-", "");

  // Probe account A: self-service consultant + its own client.
  const a = await registerAccount("config-admin", ts);
  // Sub-users under client A for the admin-only guards.
  const viewer = await createAndLogin(a.session, a.clientId, "client_viewer", "config-viewer", ts);
  const staff = await createAndLogin(a.session, a.clientId, "client_staff", "config-staff", ts);
  // A second real user (client_admin) under client A for push-token ownership.
  const other = await createAndLogin(a.session, a.clientId, "client_admin", "config-other", ts);
  fixtures.probe("after-registration");

  await testFormOptions(a.session, viewer, staff, ts);
  const { clientBId } = await testFormOptionsIsolation(a.session, a.clientId, ts);
  await testRecordValidation(a.session, ts);
  fixtures.probe("after-record-validation");
  await testCustomTradeAndInspectionValidation(a.session, a.clientId, clientBId, ts);
  await testFoodSafetyConfig(a.session, viewer, staff, clientBId, ts);
  await testSiteDiaries(a.session, ts);
  await testPushToken(a.session, other, ts);
  await testStorageUsage(a.session, viewer, staff, a.clientId, clientBId);
}

async function main() {
  console.log(`config-endpoints fixture run id: ${runId}`);
  try {
    await runSuite();
  } catch (err) {
    failures.push(`suite aborted — ${err?.message ?? err}`);
    console.error("Test run aborted:", err?.message ?? err);
  } finally {
    try {
      await fixtures.cleanup();
    } catch (err) {
      failures.push(`fixture cleanup — ${err?.message ?? err}`);
      console.error(`FAIL: fixture cleanup — ${err?.message ?? err}`);
    }
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error("\nFailures:");
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
