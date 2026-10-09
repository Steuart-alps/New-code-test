// Focused integration coverage for database-created operational actions.
// Usage: node tests/track-actions-trigger.mjs (with the API server running).
const BASE = process.env.API_BASE || "http://localhost:8080/api";
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const date = new Date().toISOString().slice(0, 10);
let cookie = "";
let staffCookie = "";
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

async function staffRequest(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(staffCookie ? { cookie: staffCookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) staffCookie = setCookie.split(";")[0];
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

function resolutionPayload(evidenceReference) {
  return {
    status: "resolved",
    remedialAction: "Corrective work completed",
    evidenceReference,
    resolutionNotes: "Reviewed and ready to close.",
    resolverSignature: SIGNATURE,
  };
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
  const me = await request("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.clientId;
  const staffEmail = `track-action-reviewer-${Date.now()}@test.local`;
  const staffCreated = await request("POST", "/users", {
    name: "Independent reviewer",
    email: staffEmail,
    password: "password-456",
    role: "client_staff",
    clientId,
  });
  assert("create independent reviewer", [200, 201].includes(staffCreated.status));
  assert("independent reviewer login", (await staffRequest("POST", "/auth/login", {
    email: staffEmail,
    password: "password-456",
  })).status === 200);

  const fireFailure = await request("POST", "/fire-safety", {
    checkType: "alarm",
    checkDate: date,
    result: "fail",
    siteId,
    performedBy: "Track action test",
  });
  assert("create failing FireTrack source", fireFailure.status === 201);
  const fireActions = sourceAction(await actions("fire"), "fire_safety_checks", fireFailure.data?.id);
  assert("FireTrack failure creates one linked action", fireActions.length === 1);
  const fireAction = fireActions[0];
  const fireRequirements = await request("GET", `/track-evidence/requirements?module=fire&actionId=${fireAction?.id}`);
  assert("load FireTrack evidence profile", fireRequirements.status === 200 && fireRequirements.data?.length === 5);
  const fireMissing = await request("PATCH", `/track-actions/${fireAction?.id}`, resolutionPayload("Fire closure evidence"));
  assert("FireTrack sign-off lists missing profile evidence", fireMissing.status === 400
    && fireMissing.data?.missingEvidence?.length === 5);

  const responsiblePerson = (fireRequirements.data ?? []).find(item => item.requirementKey === "responsible_person");
  const rejectedResponsible = await request("POST", "/track-evidence", {
    module: "fire", siteId, actionId: fireAction?.id,
    requirementKey: responsiblePerson?.requirementKey, evidenceType: responsiblePerson?.evidenceType,
    title: "Rejected responsible person evidence", details: "The named role could not be confirmed.",
  });
  assert("record FireTrack responsible-person evidence", rejectedResponsible.status === 201);
  assert("reject unsupported FireTrack evidence", (await staffRequest("POST", `/track-evidence/${rejectedResponsible.data?.id}/review`, {
    status: "rejected", reviewNotes: "The named role could not be confirmed.",
  })).status === 200);
  const rejectedProgress = await request("GET", `/track-evidence/requirements?module=fire&actionId=${fireAction?.id}`);
  const rejectedRequirement = rejectedProgress.data?.find(item => item.requirementKey === "responsible_person");
  assert("report rejected FireTrack evidence as missing", rejectedRequirement?.recordedCount === 0
    && rejectedRequirement?.rejectedCount === 1 && rejectedRequirement?.missingCount === 1
    && rejectedRequirement?.satisfied === false);
  const rejectedEvidenceAttempt = await request("PATCH", `/track-actions/${fireAction?.id}`, resolutionPayload("Rejected evidence"));
  assert("rejected evidence does not satisfy a FireTrack requirement", rejectedEvidenceAttempt.status === 400
    && rejectedEvidenceAttempt.data?.missingEvidence?.some(item => item.requirementKey === "responsible_person"));

  const fireEvidenceIds = [];
  for (const requirement of fireRequirements.data ?? []) {
    const evidence = await request("POST", "/track-evidence", {
      module: "fire",
      siteId,
      actionId: fireAction?.id,
      requirementKey: requirement.requirementKey,
      evidenceType: requirement.evidenceType,
      title: requirement.title,
      details: `Evidence recorded for ${requirement.title}.`,
    });
    assert(`record FireTrack ${requirement.requirementKey}`, evidence.status === 201);
    if (evidence.status === 201) fireEvidenceIds.push({ id: evidence.data?.id, requirement });
  }
  const recordedProgress = await request("GET", `/track-evidence/requirements?module=fire&actionId=${fireAction?.id}`);
  const recordedReviewRequirement = recordedProgress.data?.find(item => item.requirementKey === "risk_assessment");
  assert("report recorded FireTrack evidence awaiting review", recordedReviewRequirement?.recordedCount === 1
    && recordedReviewRequirement?.verifiedCount === 0 && recordedReviewRequirement?.satisfied === false);
  const firePendingReview = await request("PATCH", `/track-actions/${fireAction?.id}`, resolutionPayload("Fire profile evidence"));
  assert("FireTrack sign-off waits for independent verification", firePendingReview.status === 400
    && firePendingReview.data?.missingEvidence?.some(item => item.reviewRequired));
  for (const item of fireEvidenceIds.filter(row => row.requirement.reviewRequired)) {
    assert(`independently verify FireTrack ${item.requirement.requirementKey}`, (await staffRequest("POST", `/track-evidence/${item.id}/review`, {
      status: "verified",
      reviewNotes: "Independently checked against the source record.",
    })).status === 200);
  }
  const verifiedProgress = await request("GET", `/track-evidence/requirements?module=fire&actionId=${fireAction?.id}`);
  const verifiedRequirement = verifiedProgress.data?.find(item => item.requirementKey === "risk_assessment");
  assert("report independently verified FireTrack evidence", verifiedRequirement?.verifiedCount === 1
    && verifiedRequirement?.recordedCount === 0 && verifiedRequirement?.satisfied === true);
  assert("FireTrack action resolves after required evidence is verified",
    (await request("PATCH", `/track-actions/${fireAction?.id}`, resolutionPayload("Fire profile evidence"))).status === 200);

  const pass = await request("POST", "/legionella", {
    checkType: "cold_tank_temp", checkDate: date, temperature: 20, result: "pass", siteId,
  });
  assert("create passing source", pass.status === 201);
  assert("pass creates no action", sourceAction(await actions("legionella"), "legionella_checks", pass.data?.id).length === 0);

  const failed = await request("POST", "/legionella", {
    checkType: "hot_sentinel_temp", checkDate: date, temperature: 9, result: "fail", siteId,
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
  const requirements = await request("GET", `/track-evidence/requirements?module=legionella&actionId=${action?.id}`);
  assert("load Legionella evidence requirements", requirements.status === 200 && requirements.data?.length === 8);
  const legionellaMissing = await request("PATCH", `/track-actions/${action?.id}`, resolutionPayload("Legionella closure evidence"));
  assert("Legionella sign-off lists missing profile evidence", legionellaMissing.status === 400
    && legionellaMissing.data?.missingEvidence?.length === 8);
  let pendingReviewGateChecked = false;
  for (const requirement of requirements.data ?? []) {
    const evidence = await request("POST", "/track-evidence", {
      module: "legionella",
      siteId,
      actionId: action?.id,
      requirementKey: requirement.requirementKey,
      evidenceType: requirement.evidenceType,
      title: requirement.title,
      details: `Evidence recorded for ${requirement.title}.`,
    });
    assert(`record ${requirement.requirementKey}`, evidence.status === 201);
    if (requirement.reviewRequired) {
      if (!pendingReviewGateChecked && evidence.status === 201) {
        const pendingReview = await request("PATCH", `/track-actions/${action?.id}`, resolutionPayload("Legionella closure evidence"));
        assert("Legionella sign-off waits for independent verification", pendingReview.status === 400
          && pendingReview.data?.missingEvidence?.some(item => item.requirementKey === requirement.requirementKey));
        pendingReviewGateChecked = true;
      }
      assert(`review ${requirement.requirementKey}`, (await staffRequest("POST", `/track-evidence/${evidence.data?.id}/review`, {
        status: "verified",
        reviewNotes: "Independently checked against the source record.",
      })).status === 200);
    }
  }
  assert("resolve action", (await request("PATCH", `/track-actions/${action?.id}`, resolutionPayload("Legionella closure evidence"))).status === 200);
  assert("source update after resolution", (await request("PUT", `/legionella/${failed.data?.id}`, { result: "fail", notes: "new source evidence" })).status === 200);
  const resolved = sourceAction(await actions("legionella"), "legionella_checks", failed.data?.id);
  assert("resolved action remains singular and resolved", resolved.length === 1 && resolved[0].status === "resolved");
  assert("resolved action fields are immutable", JSON.stringify({
    title: resolved[0]?.title, severity: resolved[0]?.severity, dueDate: resolved[0]?.dueDate,
  }) === JSON.stringify(initialActionFields));

  const urgent = await request("POST", "/track-actions", {
    module: "fire", title: "Urgent evidence gate", severity: "urgent", siteId,
  });
  assert("create urgent action", urgent.status === 201);
  const urgentEvidence = await request("POST", "/track-evidence", {
    module: "fire", siteId, actionId: urgent.data?.id,
    evidenceType: "verification", title: "Urgent closure evidence",
    details: "Independent closure evidence for the urgent action.",
  });
  assert("record urgent evidence", urgentEvidence.status === 201);
  assert("urgent action rejects unsigned evidence", (await request("PATCH", `/track-actions/${urgent.data?.id}`, {
    status: "resolved", remedialAction: "Fixed", evidenceReference: "Urgent evidence",
    resolutionNotes: "Closed", resolverSignature: SIGNATURE,
  })).status === 400);
  assert("review urgent evidence independently", (await staffRequest("POST", `/track-evidence/${urgentEvidence.data?.id}/review`, {
    status: "verified", reviewNotes: "Independently checked.",
  })).status === 200);
  assert("urgent action resolves after evidence review", (await request("PATCH", `/track-actions/${urgent.data?.id}`, {
    status: "resolved", remedialAction: "Fixed", evidenceReference: "Urgent evidence",
    resolutionNotes: "Closed", resolverSignature: SIGNATURE,
  })).status === 200);

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

  const importedRoster = await request("POST", "/green-track/machines/import", {
    rows: [
      { name: "Imported ride-on", type: "ride-on", serialNo: "IMPORT-001", siteId },
      { name: "Imported pedestrian", type: "pedestrian", regNo: "IMPORT-002", siteId },
    ],
  });
  assert("Green equipment roster imports approved aliases",
    importedRoster.status === 201 && importedRoster.data?.imported === 2);
  const importedMachines = await request("GET", "/green-track/machines");
  const importedTypes = new Map(
    (importedMachines.data ?? []).map((item) => [item.name, item.type]),
  );
  assert("Green roster creates ride-on and pedestrian equipment types",
    importedTypes.get("Imported ride-on") === "ride_on" &&
    importedTypes.get("Imported pedestrian") === "pedestrian");
  const duplicateRoster = await request("POST", "/green-track/machines/import", {
    rows: [{ name: "Imported ride-on again", type: "ride-on", serialNo: "IMPORT-001", siteId }],
  });
  assert("Green roster skips duplicate equipment identifiers",
    duplicateRoster.status === 201 && duplicateRoster.data?.imported === 0 &&
    duplicateRoster.data?.skipped?.length === 1);
  const invalidRoster = await request("POST", "/green-track/machines/import", {
    rows: [{ name: "Invalid imported machine", type: "not-a-green-type", siteId }],
  });
  assert("Green roster rejects unknown equipment types", invalidRoster.status === 400);

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