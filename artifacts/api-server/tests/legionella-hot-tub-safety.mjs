// Integration smoke test for unsafe observations and their Compliance Hub actions.
// Run with the API server and database available: node tests/legionella-hot-tub-safety.mjs
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { if (ok) passed++; else { failed++; console.error(`FAIL ${name}`, detail); } };
const client = () => {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
};
const run = async () => {
  const request = client();
  const email = `safety-${Date.now()}@test.local`;
  const reg = await request("POST", "/auth/register", { name: "Safety Integration Manager", email, password: "password-123" });
  check("register", [200, 201].includes(reg.status), reg.status);
  if (reg.data?.verificationToken) await request("GET", `/auth/verify-email?token=${encodeURIComponent(reg.data.verificationToken)}`);
  const login = await request("POST", "/auth/login", { email, password: "password-123" });
  check("login", login.status === 200, login.status);
  if (login.status !== 200) return;
  const site = await request("POST", "/sites", { name: `Water safety ${Date.now()}`, seedStarterChecks: false });
  check("create test site", site.status === 201 && !!site.data?.id, site.status);
  const siteId = site.data?.id;
  const day = new Date().toISOString().slice(0, 10);
  const missingLegionella = await request("POST", "/legionella", {
    checkType: "calorifier_temp", checkDate: day, result: "pass", siteId,
  });
  check("temperature checks cannot pass without a reading", missingLegionella.status === 400);
  const missingChemistry = await request("POST", "/hot-tub", {
    checkType: "water_chemistry", checkDate: day, result: "pass", siteId, phValue: 7.4,
  });
  check("chemistry checks require both readings", missingChemistry.status === 400);
  const missingHotTemperature = await request("POST", "/hot-tub", {
    checkType: "temperature", checkDate: day, result: "pass", siteId,
  });
  check("tub temperature checks require a reading", missingHotTemperature.status === 400);
  const legConfig = await request("GET", `/legionella/config?siteId=${siteId}`);
  check("default calorifier threshold available", legConfig.status === 200 && legConfig.data?.effectiveTemperatureLimits?.calorifier_temp?.min === 60);
  const legionella = await request("POST", "/legionella", { checkType: "calorifier_temp", checkDate: day, result: "pass", temperature: 55, siteId, performedBy: "Integration tester" });
  check("unsafe Legionella POST fails", legionella.status === 201 && legionella.data?.result === "fail", legionella.status);
  const hotTub = await request("POST", "/hot-tub", { checkType: "water_chemistry", checkDate: day, result: "pass", phValue: 8.2, sanitiserLevel: 2, temperature: 41, siteId, performedBy: "Integration tester" });
  check("unsafe Hot Tub POST fails", hotTub.status === 201 && hotTub.data?.result === "fail", hotTub.status);
  const actions = await request("GET", "/compliance-hub/actions");
  const rows = actions.data ?? [];
  check("both actions persist with owners", actions.status === 200 &&
    rows.some(a => a.sourceTrack === "LegionellaTrack" && a.sourceRecordId === String(legionella.data?.id) && a.ownerName) &&
    rows.some(a => a.sourceTrack === "HotTubTrack" && a.sourceRecordId === String(hotTub.data?.id) && a.ownerName), JSON.stringify(rows));
  const explicitLeg = await request("POST", "/legionella", {
    checkType: "cold_tank_inspection", checkDate: day, result: "fail", siteId,
    notes: "Inspection found a damaged cover",
  });
  const explicitTub = await request("POST", "/hot-tub", {
    checkType: "cover_inspection", checkDate: day, result: "fail", siteId,
    notes: "Cover fastenings need repair",
  });
  const safeMarkedFailed = await request("POST", "/hot-tub", {
    checkType: "water_chemistry", checkDate: day, result: "fail", siteId,
    phValue: 7.4, sanitiserLevel: 4,
  });
  const explicitActions = await request("GET", "/compliance-hub/actions");
  check("manual inspection failures create linked actions", explicitLeg.data?.result === "fail" &&
    explicitTub.data?.result === "fail" &&
    explicitActions.data?.some(a => a.sourceTrack === "LegionellaTrack" && a.sourceRecordId === String(explicitLeg.data?.id) && a.ownerName) &&
    explicitActions.data?.some(a => a.sourceTrack === "HotTubTrack" && a.sourceRecordId === String(explicitTub.data?.id) && a.ownerName));
  check("in-range but explicitly failed chemistry creates action",
    safeMarkedFailed.data?.result === "fail" &&
    explicitActions.data?.filter(a => a.sourceTrack === "HotTubTrack" && a.sourceRecordId === String(safeMarkedFailed.data?.id)).length === 1);
  const safeInspection = await request("POST", "/legionella", {
    checkType: "cold_tank_inspection", checkDate: day, result: "pass", siteId,
  });
  const failedEdit = await request("PUT", `/legionella/${safeInspection.data?.id}`, { result: "fail" });
  const editedActions = await request("GET", "/compliance-hub/actions");
  check("explicitly failed edit creates one linked action",
    failedEdit.data?.result === "fail" && editedActions.data?.filter(a =>
      a.sourceTrack === "LegionellaTrack" && a.sourceRecordId === String(safeInspection.data?.id)).length === 1);
  check("linked unsafe check cannot be removed",
    (await request("DELETE", `/legionella/${legionella.data?.id}`)).status === 409);
  const safeToRace = await request("POST", "/legionella", {
    checkType: "calorifier_temp", checkDate: day, result: "pass", temperature: 63, siteId,
  });
  const raceId = safeToRace.data?.id;
  const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
    request("PUT", `/legionella/${raceId}`, { result: "pass", temperature: 54 })));
  const concurrentActions = await request("GET", "/compliance-hub/actions");
  check("concurrent unsafe edits produce one linked action", concurrent.every(r => r.status === 200 && r.data?.result === "fail") &&
    concurrentActions.data?.filter(a => a.sourceTrack === "LegionellaTrack" && a.sourceRecordId === String(raceId)).length === 1);
  const update = await request("PUT", `/legionella/${legionella.data?.id}`, { result: "pass" });
  check("unsafe edit cannot force a pass", update.status === 200 && update.data?.result === "fail");
  const unchangedActions = await request("GET", "/compliance-hub/actions");
  check("repeated unsafe save does not duplicate action",
    unchangedActions.data?.filter(a => a.sourceTrack === "LegionellaTrack" && a.sourceRecordId === String(legionella.data?.id)).length === 1);
  const safeEdit = await request("PUT", `/legionella/${legionella.data?.id}`, { temperature: 61, result: "pass" });
  check("safe corrected reading can pass without deleting action history", safeEdit.status === 200 && safeEdit.data?.result === "pass");
  const hotConfig = await request("GET", `/hot-tub/config?siteId=${siteId}`);
  check("default operating ranges available", hotConfig.status === 200 && hotConfig.data?.operatingRanges?.temperature?.max === 40);
  const invalidConfig = await request("PUT", `/hot-tub/config?siteId=${siteId}`, {
    operatingRanges: { ph: { min: 8, max: 7 }, sanitiser: { min: 3, max: 5 }, temperature: { max: 40 } },
  });
  check("inverted manager range rejected", invalidConfig.status === 400);
  const changedConfig = await request("PUT", `/hot-tub/config?siteId=${siteId}`, {
    operatingRanges: { ph: { min: 7.2, max: 7.8 }, sanitiser: { min: 4, max: 6 }, temperature: { max: 40 } },
  });
  check("manager can set site controls", changedConfig.status === 200 && changedConfig.data?.operatingRanges?.sanitiser?.min === 4);
  const newBreach = await request("POST", "/hot-tub", {
    checkType: "water_chemistry", checkDate: day, result: "pass", phValue: 7.4, sanitiserLevel: 3.5, siteId,
  });
  check("site-specific sanitiser threshold is enforced", newBreach.status === 201 && newBreach.data?.result === "fail");
  const secondSite = await request("POST", "/sites", { name: `Other water site ${Date.now()}`, seedStarterChecks: false });
  const secondSiteId = secondSite.data?.id;
  const safeOtherLeg = await request("POST", "/legionella", {
    checkType: "calorifier_temp", checkDate: day, result: "pass", temperature: 62, siteId: secondSiteId,
  });
  const safeOtherTub = await request("POST", "/hot-tub", {
    checkType: "water_chemistry", checkDate: day, result: "pass", phValue: 7.4, sanitiserLevel: 4.5, siteId: secondSiteId,
  });
  check("second site saves passing observations", secondSite.status === 201 &&
    safeOtherLeg.data?.result === "pass" && safeOtherTub.data?.result === "pass");
  const [allLeg, otherLeg, allTub, otherTub] = await Promise.all([
    request("GET", "/legionella/status"), request("GET", `/legionella/status?siteId=${secondSiteId}`),
    request("GET", "/hot-tub/status"), request("GET", `/hot-tub/status?siteId=${secondSiteId}`),
  ]);
  const outcome = (rows, type) => rows.data?.find(r => r.checkType === type)?.lastResult;
  check("Legionella status retains unsafe first site but isolates safe second site",
    outcome(allLeg, "calorifier_temp") === "fail" && outcome(otherLeg, "calorifier_temp") === "pass");
  check("HotTub status retains unsafe first site but isolates safe second site",
    outcome(allTub, "water_chemistry") === "fail" && outcome(otherTub, "water_chemistry") === "pass");
  const reminders = await request("GET", "/check-reminders");
  check("unsafe water result appears in reminders", reminders.status === 200 &&
    JSON.stringify(reminders.data).includes("action_required"), JSON.stringify(reminders.data).slice(0, 700));
  const dashboard = await request("GET", `/dashboard/summary?siteId=${siteId}`);
  check("dashboard health reflects unsafe result", dashboard.status === 200 &&
    dashboard.data?.tracks?.find(t => t.trackId === "hot_tub")?.health === "action_required", JSON.stringify(dashboard.data?.tracks?.find(t => t.trackId === "hot_tub")));
  console.log(`Safety integration: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
};
run().catch(error => { console.error(error); process.exitCode = 1; });