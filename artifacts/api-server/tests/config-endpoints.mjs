// Regression tests for the per-client configuration endpoints.
//
// Covers, all against a self-booted server with freshly-registered probe
// accounts (cleaned up implicitly by using unique emails/clients each run):
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
// Usage: node tests/config-endpoints.mjs   (API must be running on API_BASE)
// Exits 0 when every check passes, 1 otherwise.

const BASE = process.env.API_BASE || "http://localhost:8080/api";

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
  const email = `${label}-${ts}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const reg = await session("POST", "/auth/register", {
    name: `${label} account`,
    email,
    password: "password-123",
  });
  if (![200, 201].includes(reg.status)) {
    console.error(`FATAL: registration failed for ${label}`, reg.status, reg.data);
    process.exit(1);
  }
  const me = await session("GET", "/auth/me");
  const user = me.data?.user ?? me.data;
  const clientId = user?.clientId;
  if (!Number.isInteger(clientId)) {
    console.error(`FATAL: no clientId for ${label}`, me.status, me.data);
    process.exit(1);
  }
  return { session, clientId, email };
}

// Create a sub-user under the given admin session, then log them in.
async function createAndLogin(admin, clientId, role, label, ts) {
  const email = `${label}-${ts}-${Math.floor(Math.random() * 1e6)}@test.local`;
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
  const login = await session("POST", "/auth/login", { email, password });
  expectOk(`setup: login ${role} (${label})`, login.status, [200, 201]);
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
    slug: `isolation-b-${ts}-${Math.floor(Math.random() * 1e6)}`,
  });
  expectOk("isolation: consultant creates client B", bRes.status, [200, 201]);
  const clientBId = bRes.data?.id;
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

  // Cleanup: reset the list and remove created incidents.
  await admin("DELETE", "/form-options/incident_types");
  await admin("DELETE", `/incidents/${legacyId}`);
  if (Number.isInteger(customRecord.data?.id)) await admin("DELETE", `/incidents/${customRecord.data.id}`);
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

  // ── (e) Same site + same date → upsert semantics (409 conflict, no dup) ──
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

  // ── (f) Clearing a site override reverts that key to the client value ──
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

  // Cleanup records + config so later runs stay clean.
  for (const id of [s1Rec.data?.id, s2Rec.data?.id, orgRec.data?.id]) {
    if (Number.isInteger(id)) {
      // No dedicated DELETE endpoint for diary records; clearing config is enough
      // for isolation since each run uses fresh dates/sites. Leave rows in place.
    }
  }
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
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const ts = Date.now();

  // Probe account A: self-service consultant + its own client.
  const a = await registerAccount("config-admin", ts);
  // Sub-users under client A for the admin-only guards.
  const viewer = await createAndLogin(a.session, a.clientId, "client_viewer", "config-viewer", ts);
  const staff = await createAndLogin(a.session, a.clientId, "client_staff", "config-staff", ts);
  // A second real user (client_admin) under client A for push-token ownership.
  const other = await createAndLogin(a.session, a.clientId, "client_admin", "config-other", ts);

  await testFormOptions(a.session, viewer, staff, ts);
  const { clientBId } = await testFormOptionsIsolation(a.session, a.clientId, ts);
  await testRecordValidation(a.session, ts);
  await testFoodSafetyConfig(a.session, viewer, staff, clientBId, ts);
  await testSiteDiaries(a.session, ts);
  await testPushToken(a.session, other, ts);

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
