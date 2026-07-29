// Happy-path integration tests for module routes.
//
// Registers one account and verifies that:
//   - FireTrack (fire-safety): all 5 check types can be created, listed,
//     filtered, updated, and deleted; status summary is coherent.
//   - LegionellaTrack (legionella): all 6 check types including temperature
//     storage and action_required result; same CRUD + status checks.
//   - KitchenTrack (food-safety): config read/write, daily record
//     create/update/list/by-date, duplicate-date 409 guard.
//
// Usage: node tests/module-routes.mjs
// Exits 0 when all checks pass, 1 otherwise.

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

function makeSession() {
  let cookie = "";
  return async function request(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let data = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) data = await res.json().catch(() => null);
    else await res.text().catch(() => null);
    return { status: res.status, data };
  };
}

// Returns a YYYY-MM-DD string offset by `days` from today (negative = past).
function isoDate(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// FireTrack (fire-safety)
// Check types: alarm, emergency_lights, extinguishers, fire_doors, fire_drill
// ─────────────────────────────────────────────────────────────────────────────

async function testFireSafety(req) {
  console.log("\n── FireTrack ──");

  const TYPES = ["alarm", "emergency_lights", "extinguishers", "fire_doors", "fire_drill"];

  // 1. Create one record per check type
  const createdIds = {};
  for (const checkType of TYPES) {
    const res = await req("POST", "/fire-safety", {
      checkType,
      checkDate: isoDate(-1), // yesterday → always "ok" or "due_soon", never "overdue" for daily checks
      result: "pass",
      notes: `Test record for ${checkType}`,
      performedBy: "Test Engineer",
    });
    expectOk(`fire-safety: POST ${checkType}`, res.status, [201]);
    check(`fire-safety: POST ${checkType} returns id`, typeof res.data?.id === "number", `id=${res.data?.id}`);
    check(`fire-safety: POST ${checkType} persists checkType`, res.data?.checkType === checkType, `got ${res.data?.checkType}`);
    check(`fire-safety: POST ${checkType} persists result`, res.data?.result === "pass", `got ${res.data?.result}`);
    check(`fire-safety: POST ${checkType} persists performedBy`, res.data?.performedBy === "Test Engineer", `got ${res.data?.performedBy}`);
    createdIds[checkType] = res.data?.id;
  }

  // 2. List — all created records should appear
  const listRes = await req("GET", "/fire-safety");
  expectOk("fire-safety: GET /", listRes.status);
  check("fire-safety: list returns array", Array.isArray(listRes.data), `got ${typeof listRes.data}`);
  for (const checkType of TYPES) {
    check(
      `fire-safety: list includes ${checkType} record`,
      (listRes.data ?? []).some((r) => r.id === createdIds[checkType]),
      "record not found in list",
    );
  }

  // 3. Filter by checkType
  const filterRes = await req("GET", "/fire-safety?checkType=alarm");
  expectOk("fire-safety: GET /?checkType=alarm", filterRes.status);
  check(
    "fire-safety: filter returns only alarm records",
    (filterRes.data ?? []).every((r) => r.checkType === "alarm"),
    "non-alarm record in filtered list",
  );
  check(
    "fire-safety: filter includes created alarm record",
    (filterRes.data ?? []).some((r) => r.id === createdIds["alarm"]),
    "alarm record not found in filtered list",
  );

  // 4. PUT — update result and notes
  const alarmId = createdIds["alarm"];
  const putRes = await req("PUT", `/fire-safety/${alarmId}`, {
    result: "fail",
    notes: "Updated notes",
  });
  expectOk("fire-safety: PUT /:id", putRes.status, [200]);
  check("fire-safety: PUT persists result change", putRes.data?.result === "fail", `got ${putRes.data?.result}`);
  check("fire-safety: PUT persists notes change", putRes.data?.notes === "Updated notes", `got ${putRes.data?.notes}`);
  check("fire-safety: PUT preserves checkType", putRes.data?.checkType === "alarm", `got ${putRes.data?.checkType}`);

  // 5. PUT on non-existent id → 404
  const put404 = await req("PUT", "/fire-safety/999999999", { result: "pass" });
  check("fire-safety: PUT non-existent → 404", put404.status === 404, `got ${put404.status}`);

  // 6. Status endpoint — all 5 types should appear, each with required fields
  const statusRes = await req("GET", "/fire-safety/status");
  expectOk("fire-safety: GET /status", statusRes.status);
  check("fire-safety: status returns array", Array.isArray(statusRes.data), `got ${typeof statusRes.data}`);
  check(
    "fire-safety: status returns entry for all 5 check types",
    TYPES.every((t) => (statusRes.data ?? []).some((s) => s.checkType === t)),
    `missing types: ${TYPES.filter((t) => !(statusRes.data ?? []).some((s) => s.checkType === t)).join(", ")}`,
  );
  for (const entry of statusRes.data ?? []) {
    check(`fire-safety: status.${entry.checkType} has frequencyDays`, typeof entry.frequencyDays === "number", `got ${entry.frequencyDays}`);
    check(`fire-safety: status.${entry.checkType} has lastDate`, entry.lastDate !== undefined, "lastDate field missing");
    check(`fire-safety: status.${entry.checkType} has status field`, ["ok", "due_soon", "overdue", "never"].includes(entry.status), `got ${entry.status}`);
  }

  // Records created for yesterday should NOT be "overdue" immediately (they have
  // at least some days before due date for all types except alarm/extinguisher
  // which are weekly — but yesterday is 6 days before due).
  const alarmStatus = (statusRes.data ?? []).find((s) => s.checkType === "alarm");
  check("fire-safety: alarm check yesterday is not overdue", alarmStatus?.status !== "overdue", `status=${alarmStatus?.status}`);

  // 7. DELETE
  const delId = createdIds["fire_drill"];
  const delRes = await req("DELETE", `/fire-safety/${delId}`);
  check("fire-safety: DELETE /:id → 204", delRes.status === 204, `got ${delRes.status}`);

  // 8. Confirm deleted record is gone from list
  const listAfterDelete = await req("GET", "/fire-safety");
  check(
    "fire-safety: deleted record not in list",
    !(listAfterDelete.data ?? []).some((r) => r.id === delId),
    "deleted record still in list",
  );

  // 9. DELETE already-gone → 404
  const del404 = await req("DELETE", `/fire-safety/${delId}`);
  check("fire-safety: DELETE non-existent → 404", del404.status === 404, `got ${del404.status}`);

  // 10. Validation: missing required fields → 400
  const badPost = await req("POST", "/fire-safety", { checkDate: isoDate(), result: "pass" }); // missing checkType
  check("fire-safety: POST without checkType → 400", badPost.status === 400, `got ${badPost.status}`);
  const badType = await req("POST", "/fire-safety", { checkType: "invalid", checkDate: isoDate(), result: "pass" });
  check("fire-safety: POST with unknown checkType → 400", badType.status === 400, `got ${badType.status}`);

  return createdIds;
}

// ─────────────────────────────────────────────────────────────────────────────
// LegionellaTrack (legionella)
// Check types: cold_water_temp, hot_water_temp, sentinel_flush, shower_clean,
//              tank_inspection, risk_assessment
// ─────────────────────────────────────────────────────────────────────────────

async function testLegionella(req) {
  console.log("\n── LegionellaTrack ──");

  const TYPES = [
    "cold_water_temp",
    "hot_water_temp",
    "sentinel_flush",
    "shower_clean",
    "tank_inspection",
    "risk_assessment",
  ];

  const TEMPERATURE_TYPES = new Set(["cold_water_temp", "hot_water_temp"]);

  const createdIds = {};

  // 1. Create one record per check type; include temperature for temp checks
  for (const checkType of TYPES) {
    const body = {
      checkType,
      checkDate: isoDate(-1),
      result: checkType === "cold_water_temp" ? "pass" : "action_required",
      notes: `Legionella test: ${checkType}`,
      performedBy: "Water Hygiene Ltd",
    };
    if (TEMPERATURE_TYPES.has(checkType)) {
      body.temperature = checkType === "cold_water_temp" ? 17.5 : 52.3;
    }

    const res = await req("POST", "/legionella", body);
    expectOk(`legionella: POST ${checkType}`, res.status, [201]);
    check(`legionella: POST ${checkType} returns id`, typeof res.data?.id === "number", `id=${res.data?.id}`);
    check(`legionella: POST ${checkType} persists checkType`, res.data?.checkType === checkType, `got ${res.data?.checkType}`);
    check(
      `legionella: POST ${checkType} persists result`,
      res.data?.result === (checkType === "cold_water_temp" ? "pass" : "action_required"),
      `got ${res.data?.result}`,
    );

    if (TEMPERATURE_TYPES.has(checkType)) {
      const expected = checkType === "cold_water_temp" ? 17.5 : 52.3;
      // Temperature is stored as numeric string in DB; accept string or number
      const actual = parseFloat(res.data?.temperature);
      check(
        `legionella: POST ${checkType} persists temperature`,
        Math.abs(actual - expected) < 0.01,
        `expected ${expected}, got ${res.data?.temperature}`,
      );
    }

    createdIds[checkType] = res.data?.id;
  }

  // 2. List — all records should appear
  const listRes = await req("GET", "/legionella");
  expectOk("legionella: GET /", listRes.status);
  check("legionella: list returns array", Array.isArray(listRes.data), `got ${typeof listRes.data}`);
  for (const checkType of TYPES) {
    check(
      `legionella: list includes ${checkType} record`,
      (listRes.data ?? []).some((r) => r.id === createdIds[checkType]),
      "record not found in list",
    );
  }

  // 3. Filter by checkType
  const filterRes = await req("GET", "/legionella?checkType=cold_water_temp");
  expectOk("legionella: GET /?checkType=cold_water_temp", filterRes.status);
  check(
    "legionella: filter returns only cold_water_temp records",
    (filterRes.data ?? []).every((r) => r.checkType === "cold_water_temp"),
    "unexpected check type in filtered list",
  );

  // 4. PUT — update notes and temperature on a temp check
  const coldId = createdIds["cold_water_temp"];
  const putRes = await req("PUT", `/legionella/${coldId}`, {
    result: "fail",
    temperature: 21.0,
    notes: "Remedial action taken",
  });
  expectOk("legionella: PUT /:id", putRes.status, [200]);
  check("legionella: PUT persists result change", putRes.data?.result === "fail", `got ${putRes.data?.result}`);
  check("legionella: PUT persists notes change", putRes.data?.notes === "Remedial action taken", `got ${putRes.data?.notes}`);
  const newTemp = parseFloat(putRes.data?.temperature);
  check("legionella: PUT persists temperature change", Math.abs(newTemp - 21.0) < 0.01, `got ${putRes.data?.temperature}`);
  check("legionella: PUT preserves checkType", putRes.data?.checkType === "cold_water_temp", `got ${putRes.data?.checkType}`);

  // 5. PUT non-existent → 404
  const put404 = await req("PUT", "/legionella/999999999", { result: "pass" });
  check("legionella: PUT non-existent → 404", put404.status === 404, `got ${put404.status}`);

  // 6. Status endpoint — all 6 types present with correct shape
  const statusRes = await req("GET", "/legionella/status");
  expectOk("legionella: GET /status", statusRes.status);
  check("legionella: status returns array", Array.isArray(statusRes.data), `got ${typeof statusRes.data}`);
  check(
    "legionella: status returns entry for all 6 check types",
    TYPES.every((t) => (statusRes.data ?? []).some((s) => s.checkType === t)),
    `missing: ${TYPES.filter((t) => !(statusRes.data ?? []).some((s) => s.checkType === t)).join(", ")}`,
  );
  for (const entry of statusRes.data ?? []) {
    check(`legionella: status.${entry.checkType} has frequencyDays`, typeof entry.frequencyDays === "number", `got ${entry.frequencyDays}`);
    check(`legionella: status.${entry.checkType} has lastDate`, entry.lastDate !== undefined, "lastDate field missing");
    check(`legionella: status.${entry.checkType} has valid status`, ["ok", "due_soon", "overdue", "never"].includes(entry.status), `got ${entry.status}`);
  }

  // Risk assessment is annual (365 days) — a record from yesterday must be "ok"
  const riskStatus = (statusRes.data ?? []).find((s) => s.checkType === "risk_assessment");
  check("legionella: annual risk_assessment not overdue after recent check", riskStatus?.status === "ok", `status=${riskStatus?.status}`);

  // 7. DELETE
  const delId = createdIds["shower_clean"];
  const delRes = await req("DELETE", `/legionella/${delId}`);
  check("legionella: DELETE /:id → 204", delRes.status === 204, `got ${delRes.status}`);

  const listAfterDelete = await req("GET", "/legionella");
  check(
    "legionella: deleted record not in list",
    !(listAfterDelete.data ?? []).some((r) => r.id === delId),
    "deleted record still in list",
  );

  const del404 = await req("DELETE", `/legionella/${delId}`);
  check("legionella: DELETE non-existent → 404", del404.status === 404, `got ${del404.status}`);

  // 8. Validation
  const badPost = await req("POST", "/legionella", { checkDate: isoDate(), result: "pass" }); // missing checkType
  check("legionella: POST without checkType → 400", badPost.status === 400, `got ${badPost.status}`);
  const badResult = await req("POST", "/legionella", { checkType: "sentinel_flush", checkDate: isoDate(), result: "unknown" });
  check("legionella: POST with invalid result → 400", badResult.status === 400, `got ${badResult.status}`);

  return createdIds;
}

// ─────────────────────────────────────────────────────────────────────────────
// KitchenTrack (food-safety)
// ─────────────────────────────────────────────────────────────────────────────

async function testFoodSafety(req) {
  console.log("\n── KitchenTrack (food-safety) ──");

  // ── Config ────────────────────────────────────────────────────────────────
  // 1. GET config — returns defaults
  const configRes = await req("GET", "/food-safety/config");
  expectOk("food-safety: GET /config", configRes.status);
  check("food-safety: config returns object", typeof configRes.data === "object" && configRes.data !== null, `got ${typeof configRes.data}`);
  check("food-safety: config has food_cooking_limit", typeof configRes.data?.food_cooking_limit === "string", `got ${configRes.data?.food_cooking_limit}`);
  check("food-safety: config has food_num_fridges", typeof configRes.data?.food_num_fridges === "string", `got ${configRes.data?.food_num_fridges}`);

  // 2. PUT config — update two values
  const putConfigRes = await req("PUT", "/food-safety/config", {
    food_num_fridges: "4",
    food_num_freezers: "3",
    food_cooking_limit: "Above 75°C (30 seconds)",
  });
  expectOk("food-safety: PUT /config", putConfigRes.status);
  check("food-safety: PUT /config returns ok", putConfigRes.data?.ok === true, `got ${JSON.stringify(putConfigRes.data)}`);

  // 3. GET config again — updated values should be reflected
  const configAfterRes = await req("GET", "/food-safety/config");
  expectOk("food-safety: GET /config after update", configAfterRes.status);
  check("food-safety: config reflects updated num_fridges", configAfterRes.data?.food_num_fridges === "4", `got ${configAfterRes.data?.food_num_fridges}`);
  check("food-safety: config reflects updated num_freezers", configAfterRes.data?.food_num_freezers === "3", `got ${configAfterRes.data?.food_num_freezers}`);
  check("food-safety: config reflects updated cooking_limit", configAfterRes.data?.food_cooking_limit === "Above 75°C (30 seconds)", `got ${configAfterRes.data?.food_cooking_limit}`);

  // ── Daily records ─────────────────────────────────────────────────────────
  const recordDate = isoDate(-5); // 5 days ago — avoids collision with isolation tests
  const recordDate2 = isoDate(-6);

  // 4. GET /by-date before any record exists → 404
  const notFoundRes = await req("GET", `/food-safety/by-date/${recordDate}`);
  check("food-safety: GET /by-date missing record → 404", notFoundRes.status === 404, `got ${notFoundRes.status}`);

  // 5. POST — create a record for recordDate
  const postRes = await req("POST", "/food-safety", {
    recordDate,
    deliveries: [{ supplier: "Fresh Foods Ltd", temp: 4.2, ok: true }],
    coldFood: [{ item: "Chicken", temp: 3.1, ok: true }],
    hotTemperature: [],
    hotHolding: [],
    correctives: "",
    managerSignature: "J Smith",
  });
  expectOk("food-safety: POST /", postRes.status, [201]);
  check("food-safety: POST returns id", typeof postRes.data?.id === "number", `id=${postRes.data?.id}`);
  check("food-safety: POST persists recordDate", postRes.data?.recordDate === recordDate, `got ${postRes.data?.recordDate}`);
  check("food-safety: POST persists deliveries", Array.isArray(postRes.data?.deliveries), `got ${typeof postRes.data?.deliveries}`);
  check("food-safety: POST persists managerSignature", postRes.data?.managerSignature === "J Smith", `got ${postRes.data?.managerSignature}`);
  const recordId = postRes.data?.id;

  // 6. Duplicate date → 409
  const dupRes = await req("POST", "/food-safety", { recordDate });
  check("food-safety: POST duplicate date → 409", dupRes.status === 409, `got ${dupRes.status}`);
  check("food-safety: 409 response includes existing id", typeof dupRes.data?.id === "number", `got ${JSON.stringify(dupRes.data)}`);

  // 7. GET /by-date — should return the created record
  const byDateRes = await req("GET", `/food-safety/by-date/${recordDate}`);
  expectOk("food-safety: GET /by-date/:date", byDateRes.status);
  check("food-safety: /by-date returns correct id", byDateRes.data?.id === recordId, `got id=${byDateRes.data?.id}`);
  check("food-safety: /by-date returns deliveries array", Array.isArray(byDateRes.data?.deliveries), `got ${typeof byDateRes.data?.deliveries}`);

  // 8. GET /food-safety?date= — same record
  const byQueryRes = await req("GET", `/food-safety?date=${recordDate}`);
  expectOk("food-safety: GET /?date=", byQueryRes.status);
  check("food-safety: /?date returns correct record", byQueryRes.data?.id === recordId, `got id=${byQueryRes.data?.id}`);

  // 9. GET /food-safety (list — no date param) — should include the record's date
  const listRes = await req("GET", "/food-safety");
  expectOk("food-safety: GET / (list)", listRes.status);
  check("food-safety: list returns array", Array.isArray(listRes.data), `got ${typeof listRes.data}`);
  check(
    "food-safety: list includes created record",
    (listRes.data ?? []).some((r) => r.id === recordId),
    "created record not in list",
  );
  // List endpoint returns summary rows (id, recordDate, submittedAt)
  const summary = (listRes.data ?? []).find((r) => r.id === recordId);
  check("food-safety: list summary has recordDate", summary?.recordDate === recordDate, `got ${summary?.recordDate}`);

  // 10. PUT — update the record (add a corrective action, set submittedAt)
  const submittedAt = new Date().toISOString();
  const putRes = await req("PUT", `/food-safety/${recordId}`, {
    correctives: "Discarded batch of cooked chicken",
    hotHolding: [{ item: "Soup", temp: 68.0, ok: true }],
    submittedAt,
  });
  expectOk("food-safety: PUT /:id", putRes.status, [200]);
  check("food-safety: PUT persists correctives", putRes.data?.correctives === "Discarded batch of cooked chicken", `got ${putRes.data?.correctives}`);
  check("food-safety: PUT persists hotHolding", Array.isArray(putRes.data?.hotHolding), `got ${typeof putRes.data?.hotHolding}`);
  check("food-safety: PUT persists submittedAt", putRes.data?.submittedAt != null, `submittedAt is null`);
  // deliveries should be unchanged
  check("food-safety: PUT preserves deliveries", Array.isArray(putRes.data?.deliveries), `got ${typeof putRes.data?.deliveries}`);

  // 11. GET /by-date confirms update
  const byDateAfterPut = await req("GET", `/food-safety/by-date/${recordDate}`);
  expectOk("food-safety: GET /by-date after PUT", byDateAfterPut.status);
  check("food-safety: /by-date after PUT reflects correctives", byDateAfterPut.data?.correctives === "Discarded batch of cooked chicken", `got ${byDateAfterPut.data?.correctives}`);

  // 12. PUT non-existent → 404
  const put404 = await req("PUT", "/food-safety/999999999", { correctives: "hacked" });
  check("food-safety: PUT non-existent → 404", put404.status === 404, `got ${put404.status}`);

  // 13. GET /?date= on missing date → null (not 404 — this endpoint returns null)
  const missingDateRes = await req("GET", `/food-safety?date=${isoDate(-99)}`);
  expectOk("food-safety: GET /?date= missing → 200 null", missingDateRes.status, [200]);
  check("food-safety: GET /?date= missing returns null", missingDateRes.data === null, `got ${JSON.stringify(missingDateRes.data)}`);

  // 14. Create a second record to confirm list grows
  const post2Res = await req("POST", "/food-safety", { recordDate: recordDate2 });
  expectOk("food-safety: POST second record", post2Res.status, [201]);
  const list2Res = await req("GET", "/food-safety");
  check(
    "food-safety: list includes second record",
    (list2Res.data ?? []).some((r) => r.id === post2Res.data?.id),
    "second record not in list",
  );

  return { recordId, recordDate };
}

// ─────────────────────────────────────────────────────────────────────────────
// Site-scoped filtering (shared across modules)
// ─────────────────────────────────────────────────────────────────────────────

async function testSiteFiltering(req, siteId) {
  console.log("\n── Site-scoped filtering ──");

  // Create one fire-safety check pinned to the site
  const siteCheck = await req("POST", "/fire-safety", {
    checkType: "alarm",
    checkDate: isoDate(-2),
    result: "pass",
    siteId,
  });
  expectOk("site-filter: create fire-safety check with siteId", siteCheck.status, [201]);
  check("site-filter: check persists siteId", siteCheck.data?.siteId === siteId, `got ${siteCheck.data?.siteId}`);
  const siteCheckId = siteCheck.data?.id;

  // Filter by siteId — should include the site-pinned check
  const filtered = await req("GET", `/fire-safety?siteId=${siteId}`);
  expectOk("site-filter: GET /fire-safety?siteId=", filtered.status);
  check(
    "site-filter: filtered list includes site-pinned check",
    (filtered.data ?? []).some((r) => r.id === siteCheckId),
    "site-pinned check not in filtered list",
  );
  check(
    "site-filter: filtered list excludes records without siteId",
    (filtered.data ?? []).every((r) => r.siteId === siteId),
    "records with different siteId present in filtered list",
  );

  // Status with siteId filter
  const siteStatus = await req("GET", `/fire-safety/status?siteId=${siteId}`);
  expectOk("site-filter: GET /fire-safety/status?siteId=", siteStatus.status);
  check(
    "site-filter: site status includes alarm with lastDate",
    (siteStatus.data ?? []).find((s) => s.checkType === "alarm")?.lastDate != null,
    "alarm entry has no lastDate",
  );

  // Same for legionella
  const legSiteCheck = await req("POST", "/legionella", {
    checkType: "cold_water_temp",
    checkDate: isoDate(-2),
    result: "pass",
    temperature: 16.0,
    siteId,
  });
  expectOk("site-filter: create legionella check with siteId", legSiteCheck.status, [201]);
  check("site-filter: legionella check persists siteId", legSiteCheck.data?.siteId === siteId, `got ${legSiteCheck.data?.siteId}`);

  const legFiltered = await req("GET", `/legionella?siteId=${siteId}`);
  expectOk("site-filter: GET /legionella?siteId=", legFiltered.status);
  check(
    "site-filter: legionella filtered list includes site-pinned check",
    (legFiltered.data ?? []).some((r) => r.id === legSiteCheck.data?.id),
    "site-pinned legionella check not in filtered list",
  );

  // Invalid siteId (belongs to nobody) → 400
  const wrongSite = await req("POST", "/fire-safety", {
    checkType: "alarm",
    checkDate: isoDate(),
    result: "pass",
    siteId: 999999999,
  });
  check("site-filter: POST with foreign siteId → 400", wrongSite.status === 400, `got ${wrongSite.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const req = makeSession();

  // Register a fresh account
  const email = `modules-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const regRes = await req("POST", "/auth/register", {
    name: "Module Test Account",
    email,
    password: "password-123",
  });
  if (![200, 201].includes(regRes.status)) {
    console.error("FATAL: registration failed", regRes.status, regRes.data);
    process.exit(1);
  }

  // Create a site (needed for site-scoped filter tests)
  const siteRes = await req("POST", "/sites", { name: "Module Test HQ" });
  if (siteRes.status !== 201) {
    console.error("FATAL: site creation failed", siteRes.status, siteRes.data);
    process.exit(1);
  }
  const siteId = siteRes.data?.id;
  check("setup: site created", typeof siteId === "number", `siteId=${siteId}`);

  await testFireSafety(req);
  await testLegionella(req);
  await testFoodSafety(req);
  await testSiteFiltering(req, siteId);

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
