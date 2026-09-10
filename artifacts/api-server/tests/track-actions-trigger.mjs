// Focused integration coverage for database-created operational actions.
// Usage: node tests/track-actions-trigger.mjs (with the API server running).
const BASE = process.env.API_BASE || "http://localhost:8080/api";
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const date = new Date().toISOString().slice(0, 10);
let cookie = "";
let failures = 0;

function assert(name, value) {
  if (value) return;
  failures++;
  console.error(`FAIL: ${name}`);
}

async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function actions(module) {
  const response = await request("GET", `/track-actions?module=${module}`);
  assert(`read ${module} actions`, response.status === 200);
  return response.data ?? [];
}

function sourceAction(rows, sourceKind, sourceRecordId) {
  return Array.isArray(rows)
    ? rows.filter((row) => row.sourceKind === sourceKind && row.sourceRecordId === sourceRecordId)
    : [];
}

async function main() {
  const email = `track-actions-${Date.now()}@test.local`;
  const registered = await request("POST", "/auth/register", {
    name: "Track action test", email, password: "password-123",
  });
  assert("register", [200, 201].includes(registered.status));
  if (registered.data?.verificationToken) {
    assert("verify", (await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`)).status === 200);
  }
  assert("login", (await request("POST", "/auth/login", { email, password: "password-123" })).status === 200);
  const site = await request("POST", "/sites", { name: "Track action site" });
  assert("create site", site.status === 201);
  const siteId = site.data?.id;

  const pass = await request("POST", "/legionella", {
    checkType: "cold_tank_temp", checkDate: date, result: "pass", siteId,
  });
  assert("create passing source", pass.status === 201);
  assert("pass creates no action", sourceAction(await actions("legionella"), "legionella_checks", pass.data?.id).length === 0);

  const failed = await request("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: date, result: "fail", siteId,
  });
  assert("create failing source", failed.status === 201);
  let legActions = sourceAction(await actions("legionella"), "legionella_checks", failed.data?.id);
  assert("fail creates exactly one action", legActions.length === 1);
  const action = legActions[0];
  assert("failing action has source site", action?.siteId === siteId);
  const initialActionFields = {
    title: action?.title, severity: action?.severity, dueDate: action?.dueDate,
  };

  assert("repeat failing update", (await request("PUT", `/legionella/${failed.data?.id}`, {
    result: "fail", followUpDate: "2099-12-31",
  })).status === 200);
  legActions = sourceAction(await actions("legionella"), "legionella_checks", failed.data?.id);
  assert("repeat update creates no duplicate", legActions.length === 1);
  assert("open action fields are immutable", JSON.stringify({
    title: legActions[0]?.title, severity: legActions[0]?.severity, dueDate: legActions[0]?.dueDate,
  }) === JSON.stringify(initialActionFields));
  assert("resolve action", (await request("PATCH", `/track-actions/${action?.id}`, {
    status: "resolved", remedialAction: "Fixed", evidenceReference: "Test evidence", resolutionNotes: "Closed", resolverSignature: SIGNATURE,
  })).status === 200);
  assert("source update after resolution", (await request("PUT", `/legionella/${failed.data?.id}`, { result: "fail", notes: "new source evidence" })).status === 200);
  const resolved = sourceAction(await actions("legionella"), "legionella_checks", failed.data?.id);
  assert("resolved action remains singular and resolved", resolved.length === 1 && resolved[0].status === "resolved");
  assert("resolved action fields are immutable", JSON.stringify({
    title: resolved[0]?.title, severity: resolved[0]?.severity, dueDate: resolved[0]?.dueDate,
  }) === JSON.stringify(initialActionFields));

  const appliance = await request("POST", "/pat-track/appliances", { name: "PAT appliance", siteId });
  const pat = await request("POST", "/pat-track/tests", { applianceId: appliance.data?.id, testDate: date, result: "fail" });
  const patAction = sourceAction(await actions("pat"), "pat_tests", pat.data?.id);
  assert("PAT action maps appliance site/module", patAction.length === 1 && patAction[0].siteId === siteId);

  const bike = await request("POST", "/bike-track/bikes", { ref: "TEST-BIKE", type: "hybrid", siteId });
  const hire = await request("POST", "/bike-track/hires", {
    bikeId: bike.data?.id, guestName: "Test guest", hireDate: date, siteId,
    preHireCheck: { overallResult: "fail", checkDate: date },
  });
  const bikeAction = sourceAction(await actions("bike"), "bike_checks", hire.data?.preCheck?.id);
  assert("Bike action maps hire/bike site/module", bikeAction.length === 1 && bikeAction[0].siteId === siteId);

  const probe = await request("POST", "/kitchen-weekly/probe", {
    checkDate: date, overallResult: "fail", siteId,
  });
  const kitchenAction = sourceAction(await actions("kitchen"), "kitchen_probe_checks", probe.data?.id);
  assert("Kitchen probe action maps direct site/module", kitchenAction.length === 1 && kitchenAction[0].siteId === siteId);

  const machine = await request("POST", "/green-track/machines", {
    name: "Canonical result machine", type: "other", siteId,
  });
  const greenCheck = await request("POST", "/green-track/pre-use-checks", {
    machineId: machine.data?.id, checkDate: date, result: "not-a-result",
  });
  assert("Green canonicalizes arbitrary result", greenCheck.status === 201 && greenCheck.data?.result === "pass");

  const failedMachine = await request("POST", "/green-track/machines", {
    name: "Greens mower", type: "ride_on_rotary", siteId,
  });
  const failedGreenCheck = await request("POST", "/green-track/pre-use-checks", {
    machineId: failedMachine.data?.id,
    checkDate: date,
    operator: "Test Greenkeeper",
    checklistItems: [
      { key: "guards", label: "Guards and shields fitted", section: "Safety devices", status: "ok" },
      { key: "blades", label: "Blades secure and undamaged", section: "Working parts", status: "fail", note: "Loose blade guard" },
    ],
    fuelLevel: "half",
    guardsOk: false,
    notes: "Guard needs attention",
  });
  assert("Green failed check is recorded", failedGreenCheck.status === 201 && failedGreenCheck.data?.result === "fail");
  const detailedItems = failedGreenCheck.data?.checklistItems ?? failedGreenCheck.data?.checklist_items;
  assert("Green detailed checklist is stored", Array.isArray(detailedItems) && detailedItems.length === 2);
  assert("Green checklist stores fuel and submission time",
    (failedGreenCheck.data?.fuelLevel ?? failedGreenCheck.data?.fuel_level) === "half" &&
    Boolean(failedGreenCheck.data?.submittedAt ?? failedGreenCheck.data?.submitted_at));
  const invalidGreenCheck = await request("POST", "/green-track/pre-use-checks", {
    machineId: failedMachine.data?.id,
    checkDate: date,
    checklistItems: [{ key: "guards", label: "Guards", section: "Safety", status: "pending" }],
  });
  assert("Green checklist rejects unanswered status", invalidGreenCheck.status === 400);
  const greenActions = sourceAction(await actions("green"), "green_pre_use_checks", failedGreenCheck.data?.id);
  assert("Green failed check creates one in-track action", greenActions.length === 1);
  assert("Green action names its machine", greenActions[0]?.title === "Pre-use check action: Greens mower");
  assert("Green action is owned by its greenkeeper", greenActions[0]?.ownerName === "Test Greenkeeper");
  assert("Green action remains site scoped", greenActions[0]?.siteId === siteId);
  assert("Green source action cannot be detached from its site", (await request(
    "PATCH",
    `/track-actions/${greenActions[0]?.id}`,
    { siteId: null },
  )).status === 409);

  const swimSession = await request("POST", "/swim-track/sessions", {
    siteId, sessionDate: date, preSessionResult: "not-a-result", result: "urgent_action",
  });
  assert("Swim canonicalizes arbitrary result", swimSession.status === 201 && swimSession.data?.result === "pass");

  const legacyTreeWrite = await request("POST", "/tree-track", {
    checkType: "visual_assessment", checkDate: date, result: "action_required", siteId,
  });
  assert("Tree rejects legacy result aliases on new writes", legacyTreeWrite.status === 400);

  if (failures) process.exit(1);
  console.log("track action trigger checks passed");
}

main().catch((error) => { console.error(error); process.exit(1); });