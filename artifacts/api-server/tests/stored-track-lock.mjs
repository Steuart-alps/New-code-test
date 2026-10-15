// Integration coverage for the date lock's authoritative, server-side lookup.
// This deliberately uses separate admin and staff cookies: a request body must
// not be able to make an old stored record look current.
import { execFileSync } from "node:child_process";

const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
function session() {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = r.headers.get("content-type")?.includes("json")
      ? await r.json().catch(() => null) : null;
    return { status: r.status, data };
  };
}
const expect = (name, result, statuses) => check(name, statuses.includes(result.status), `got ${result.status}`);

async function main() {
  const admin = session();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `stored-lock-admin-${suffix}@test.local`;
  const registered = await admin("POST", "/auth/register", {
    name: "Stored Date Lock Admin", email, password: "password-123",
  });
  if (![200, 201].includes(registered.status)) throw new Error(`registration failed: ${registered.status}`);
  const token = registered.data?.verificationToken;
  if (token) expect("verify admin", await admin("GET", `/auth/verify-email?token=${encodeURIComponent(token)}`), [200]);
  expect("login admin", await admin("POST", "/auth/login", { email, password: "password-123" }), [200]);
  const me = await admin("GET", "/auth/me");
  const clientId = me.data?.user?.clientId ?? me.data?.clientId;
  check("admin has tenant", Number.isInteger(clientId), JSON.stringify(me.data));

  const staffEmail = `stored-lock-staff-${suffix}@test.local`;
  const staffCreated = await admin("POST", "/users", {
    name: "Stored Date Lock Staff", email: staffEmail, password: "password-123",
    role: "client_staff", clientId,
  });
  expect("create staff account", staffCreated, [200, 201]);
  const staff = session();
  expect("login staff", await staff("POST", "/auth/login", { email: staffEmail, password: "password-123" }), [200]);
  const old = iso(-3), yesterday = iso(-1), today = iso(0);

  // Department-scoped staff must pass the site boundary before the date lock
  // is evaluated. Otherwise an old record in another department could leak its
  // existence through a 423 response instead of the route's 403.
  const alphaDepartment = await admin("POST", "/departments", { name: `Lock Alpha ${suffix}` });
  const betaDepartment = await admin("POST", "/departments", { name: `Lock Beta ${suffix}` });
  expect("create lock alpha department", alphaDepartment, [200, 201]);
  expect("create lock beta department", betaDepartment, [200, 201]);
  const alphaSite = await admin("POST", "/sites", {
    name: `Lock Alpha Site ${suffix}`, departmentId: alphaDepartment.data?.id, seedStarterChecks: false,
  });
  const betaSite = await admin("POST", "/sites", {
    name: `Lock Beta Site ${suffix}`, departmentId: betaDepartment.data?.id, seedStarterChecks: false,
  });
  expect("create lock alpha site", alphaSite, [200, 201]);
  expect("create lock beta site", betaSite, [200, 201]);
  const scopedStaffEmail = `stored-lock-scoped-staff-${suffix}@test.local`;
  expect("create department-scoped staff", await admin("POST", "/users", {
    name: "Stored Date Lock Alpha Staff", email: scopedStaffEmail, password: "password-123",
    role: "client_staff", clientId, departmentId: alphaDepartment.data?.id,
  }), [200, 201]);
  const scopedStaff = session();
  expect("login department-scoped staff",
    await scopedStaff("POST", "/auth/login", { email: scopedStaffEmail, password: "password-123" }), [200]);

  const scopedAlphaOld = await admin("POST", "/legionella", {
    checkType: "calorifier_temp", checkDate: old, result: "pass", temperature: 60,
    performedBy: "Lock Fixture", siteId: alphaSite.data?.id,
  });
  const scopedBetaOld = await admin("POST", "/legionella", {
    checkType: "calorifier_temp", checkDate: old, result: "pass", temperature: 60,
    performedBy: "Lock Fixture", siteId: betaSite.data?.id,
  });
  const scopedAlphaCurrent = await admin("POST", "/legionella", {
    checkType: "calorifier_temp", checkDate: today, result: "pass", temperature: 60,
    performedBy: "Lock Fixture", siteId: alphaSite.data?.id,
  });
  expect("seed scoped alpha old Legionella check", scopedAlphaOld, [201]);
  expect("seed scoped beta old Legionella check", scopedBetaOld, [201]);
  expect("seed scoped alpha current Legionella check", scopedAlphaCurrent, [201]);
  if (scopedAlphaOld.status === 201 && scopedBetaOld.status === 201 && scopedAlphaCurrent.status === 201) {
    const alphaOldPath = `/legionella/${scopedAlphaOld.data?.id}`;
    const betaOldPath = `/legionella/${scopedBetaOld.data?.id}`;
    const alphaCurrentPath = `/legionella/${scopedAlphaCurrent.data?.id}`;
    const scopedList = await scopedStaff("GET", "/legionella");
    expect("scoped staff can list Legionella", scopedList, [200]);
    check("scoped Legionella list includes alpha only",
      scopedList.data?.some?.(row => row.id === scopedAlphaOld.data.id)
      && !scopedList.data?.some?.(row => row.id === scopedBetaOld.data.id),
      JSON.stringify(scopedList.data));
    const alphaOldEdit = await scopedStaff("PUT", alphaOldPath, { notes: "scoped staff edit" });
    check("in-scope old Legionella PUT is locked",
      alphaOldEdit.status === 423 && alphaOldEdit.data?.code === "TRACK_RECORD_LOCKED",
      `${alphaOldEdit.status} ${JSON.stringify(alphaOldEdit.data)}`);
    const alphaForged = await scopedStaff("PUT", alphaOldPath, { checkDate: today, notes: "forged fresh date" });
    check("in-scope forged Legionella date remains locked",
      alphaForged.status === 423 && alphaForged.data?.code === "TRACK_RECORD_LOCKED",
      `${alphaForged.status} ${JSON.stringify(alphaForged.data)}`);
    expect("in-scope current Legionella PUT works",
      await scopedStaff("PUT", alphaCurrentPath, { notes: "current staff edit" }), [200]);
    const staffLegionellaMove = await scopedStaff("PUT", alphaCurrentPath, {
      siteId: betaSite.data.id, notes: "cross-department move",
    });
    check("scoped staff cannot move current Legionella record",
      staffLegionellaMove.status === 403,
      `${staffLegionellaMove.status} ${JSON.stringify(staffLegionellaMove.data)}`);
    const legionellaAfterMove = await admin("GET", "/legionella");
    const alphaRecordAfterMove = legionellaAfterMove.data?.find?.(row => row.id === scopedAlphaCurrent.data.id);
    check("rejected Legionella move keeps original site",
      (alphaRecordAfterMove?.siteId ?? alphaRecordAfterMove?.site_id) === alphaSite.data.id,
      JSON.stringify(alphaRecordAfterMove));
    const adminLegionellaMove = await admin("PUT", alphaCurrentPath, {
      siteId: betaSite.data.id, notes: "admin site move",
    });
    expect("admin can move current Legionella record", adminLegionellaMove, [200]);
    check("admin Legionella move changes site",
      (adminLegionellaMove.data?.siteId ?? adminLegionellaMove.data?.site_id) === betaSite.data.id,
      JSON.stringify(adminLegionellaMove.data));
    check("out-of-scope old Legionella PUT is hidden",
      (await scopedStaff("PUT", betaOldPath, { notes: "foreign department edit" })).status === 403);
    expect("admin can correct beta Legionella record",
      await admin("PUT", betaOldPath, { notes: "admin correction" }), [200]);

    const scopedWeekly = await admin("POST", "/kitchen-weekly/weekly", {
      weekCommencing: today, checks: { temperatureControl: "yes" },
      managerSignature: "Lock Fixture", siteId: alphaSite.data.id,
    });
    expect("seed current scoped KitchenWeekly record", scopedWeekly, [201]);
    if (scopedWeekly.status === 201) {
      const weeklyPath = `/kitchen-weekly/weekly/${scopedWeekly.data?.id}`;
      expect("scoped staff can edit current KitchenWeekly record",
        await scopedStaff("PUT", weeklyPath, { checks: { temperatureControl: "no" } }), [200]);
      const staffWeeklyMove = await scopedStaff("PUT", weeklyPath, {
        checks: { temperatureControl: "yes" }, siteId: betaSite.data.id,
      });
      check("scoped staff cannot move current KitchenWeekly record",
        staffWeeklyMove.status === 403,
        `${staffWeeklyMove.status} ${JSON.stringify(staffWeeklyMove.data)}`);
      const weeklyAfterMove = await admin("GET", `/kitchen-weekly/weekly?siteId=${alphaSite.data.id}`);
      check("rejected KitchenWeekly move keeps original site",
        weeklyAfterMove.data?.some?.(row => row.id === scopedWeekly.data.id
          && row.site_id === alphaSite.data.id),
        JSON.stringify(weeklyAfterMove.data));
      const adminWeeklyMove = await admin("PUT", weeklyPath, { siteId: betaSite.data.id });
      expect("admin can move current KitchenWeekly record", adminWeeklyMove, [200]);
      check("admin KitchenWeekly move changes site",
        adminWeeklyMove.data?.site_id === betaSite.data.id,
        JSON.stringify(adminWeeklyMove.data));
    }

    const scopedTrain = await admin("POST", "/train-track/records", {
      recordType: "certificate", staffName: "Lock Fixture", trainingType: "Other",
      provider: "Lock Fixture", completedDate: today, expiryDate: iso(30),
      siteId: alphaSite.data.id, notes: "current scoped training",
    });
    expect("seed current scoped TrainTrack record", scopedTrain, [201]);
    if (scopedTrain.status === 201) {
      const trainPath = `/train-track/records/${scopedTrain.data?.id}`;
      expect("scoped staff can PATCH current TrainTrack record",
        await scopedStaff("PATCH", trainPath, { notes: "scoped staff edit" }), [200]);
      const staffTrainMove = await scopedStaff("PATCH", trainPath, { siteId: betaSite.data.id });
      check("scoped staff cannot PATCH TrainTrack site",
        staffTrainMove.status === 403,
        `${staffTrainMove.status} ${JSON.stringify(staffTrainMove.data)}`);
      const trainAfterMove = await admin("GET", "/train-track/records");
      const trainRecordAfterMove = trainAfterMove.data?.find?.(row => row.id === scopedTrain.data.id);
      check("rejected TrainTrack move keeps original site",
        trainRecordAfterMove?.site_id === alphaSite.data.id,
        JSON.stringify(trainRecordAfterMove));
      const adminTrainMove = await admin("PATCH", trainPath, { siteId: betaSite.data.id });
      expect("admin can PATCH TrainTrack site", adminTrainMove, [200]);
      check("admin TrainTrack move changes site",
        adminTrainMove.data?.site_id === betaSite.data.id,
        JSON.stringify(adminTrainMove.data));
    }

    const scopedAction = await admin("POST", "/track-actions", {
      module: "fire", title: "Scoped PATCH move fixture", severity: "monitor",
      siteId: alphaSite.data.id,
    });
    expect("seed current scoped track action", scopedAction, [201]);
    if (scopedAction.status === 201) {
      const actionPath = `/track-actions/${scopedAction.data?.id}`;
      expect("scoped staff can PATCH current track action",
        await scopedStaff("PATCH", actionPath, { ownerName: "Scoped Staff" }), [200]);
      const staffActionMove = await scopedStaff("PATCH", actionPath, { siteId: betaSite.data.id });
      check("scoped staff cannot PATCH track action site",
        staffActionMove.status === 403,
        `${staffActionMove.status} ${JSON.stringify(staffActionMove.data)}`);
      const actionsAfterMove = await admin("GET", "/track-actions?module=fire");
      const actionAfterMove = actionsAfterMove.data?.find?.(row => row.id === scopedAction.data.id);
      check("rejected track action move keeps original site",
        (actionAfterMove?.siteId ?? actionAfterMove?.site_id) === alphaSite.data.id,
        JSON.stringify(actionAfterMove));
      const adminActionMove = await admin("PATCH", actionPath, { siteId: betaSite.data.id });
      expect("admin can PATCH track action site", adminActionMove, [200]);
      check("admin track action move changes site",
        (adminActionMove.data?.siteId ?? adminActionMove.data?.site_id) === betaSite.data.id,
        JSON.stringify(adminActionMove.data));
    }

    const scopedHotTub = await admin("POST", "/hot-tub", {
      checkType: "water_chemistry", checkDate: today, result: "pass",
      phValue: 7.4, sanitiserLevel: 2, performedBy: "Lock Fixture",
      siteId: alphaSite.data.id,
    });
    expect("seed current scoped HotTub check", scopedHotTub, [201]);
    if (scopedHotTub.status === 201) {
      const hotTubPath = `/hot-tub/${scopedHotTub.data?.id}`;
      expect("scoped staff can edit current HotTub check",
        await scopedStaff("PUT", hotTubPath, { notes: "scoped staff edit" }), [200]);
      const staffHotTubMove = await scopedStaff("PUT", hotTubPath, { siteId: betaSite.data.id });
      check("scoped staff cannot move HotTub check",
        staffHotTubMove.status === 403,
        `${staffHotTubMove.status} ${JSON.stringify(staffHotTubMove.data)}`);
      const hotTubAfterMove = await admin("GET", "/hot-tub");
      const hotTubRecordAfterMove = hotTubAfterMove.data?.find?.(row => row.id === scopedHotTub.data.id);
      check("rejected HotTub move keeps original site",
        (hotTubRecordAfterMove?.siteId ?? hotTubRecordAfterMove?.site_id) === alphaSite.data.id,
        JSON.stringify(hotTubRecordAfterMove));
      const adminHotTubMove = await admin("PUT", hotTubPath, { siteId: betaSite.data.id });
      expect("admin can move HotTub check", adminHotTubMove, [200]);
      check("admin HotTub move changes site",
        (adminHotTubMove.data?.siteId ?? adminHotTubMove.data?.site_id) === betaSite.data.id,
        JSON.stringify(adminHotTubMove.data));
    }

    const scopedHotTubAsset = await admin("POST", "/hot-tub/tubs", {
      name: `Scoped tub ${suffix}`, siteId: alphaSite.data.id,
    });
    expect("seed scoped HotTub asset", scopedHotTubAsset, [201]);
    if (scopedHotTubAsset.status === 201) {
      const hotTubAssetPath = `/hot-tub/tubs/${scopedHotTubAsset.data?.id}`;
      expect("scoped staff can edit current HotTub asset",
        await scopedStaff("PUT", hotTubAssetPath, { name: `Scoped tub edited ${suffix}` }), [200]);
      const staffHotTubAssetMove = await scopedStaff("PUT", hotTubAssetPath, {
        siteId: betaSite.data.id,
      });
      check("scoped staff cannot move HotTub asset",
        staffHotTubAssetMove.status === 403,
        `${staffHotTubAssetMove.status} ${JSON.stringify(staffHotTubAssetMove.data)}`);
      const hotTubAssetsAfterMove = await admin("GET", "/hot-tub/tubs");
      const hotTubAssetAfterMove = hotTubAssetsAfterMove.data?.find?.(
        row => row.id === scopedHotTubAsset.data.id,
      );
      check("rejected HotTub asset move keeps original site",
        (hotTubAssetAfterMove?.siteId ?? hotTubAssetAfterMove?.site_id) === alphaSite.data.id,
        JSON.stringify(hotTubAssetAfterMove));
      const adminHotTubAssetMove = await admin("PUT", hotTubAssetPath, {
        siteId: betaSite.data.id,
      });
      expect("admin can move HotTub asset", adminHotTubAssetMove, [200]);
      check("admin HotTub asset move changes site",
        (adminHotTubAssetMove.data?.siteId ?? adminHotTubAssetMove.data?.site_id) === betaSite.data.id,
        JSON.stringify(adminHotTubAssetMove.data));
    }

    const scopedHotTubCreate = await scopedStaff("POST", "/hot-tub/tubs", {
      name: `Scoped created tub ${suffix}`, siteId: alphaSite.data.id,
    });
    expect("scoped staff can create HotTub asset in current department",
      scopedHotTubCreate, [201]);
    check("HotTub asset creation defaults to active",
      scopedHotTubCreate.data?.active === true,
      JSON.stringify(scopedHotTubCreate.data));
    const inactiveHotTub = await admin("POST", "/hot-tub/tubs", {
      name: `Inactive tub ${suffix}`, siteId: alphaSite.data.id, active: false,
    });
    expect("manager can create inactive HotTub asset", inactiveHotTub, [201]);
    check("inactive HotTub asset remains inactive",
      inactiveHotTub.data?.active === false,
      JSON.stringify(inactiveHotTub.data));
    const hotTubAssetsAfterInactiveCreate = await admin("GET", "/hot-tub/tubs");
    const inactiveHotTubAfterCreate = hotTubAssetsAfterInactiveCreate.data?.find?.(
      row => row.id === inactiveHotTub.data?.id,
    );
    check("inactive HotTub asset is stored as inactive",
      inactiveHotTubAfterCreate?.active === false,
      JSON.stringify(inactiveHotTubAfterCreate));
    const inactiveHotTubFilter = await admin("GET", "/hot-tub/tubs?active=false");
    check("HotTub inactive filter includes inactive asset",
      inactiveHotTubFilter.data?.some?.(row => row.id === inactiveHotTub.data?.id) &&
      inactiveHotTubFilter.data?.every?.(row => row.active === false),
      JSON.stringify(inactiveHotTubFilter.data));
    const activeHotTubFilter = await scopedStaff("GET", "/hot-tub/tubs?active=true");
    check("HotTub active filter keeps department visibility",
      activeHotTubFilter.data?.some?.(row => row.id === scopedHotTubCreate.data?.id) &&
      activeHotTubFilter.data?.every?.(row => row.active === true) &&
      !activeHotTubFilter.data?.some?.(row => row.id === inactiveHotTub.data?.id),
      JSON.stringify(activeHotTubFilter.data));
    const invalidHotTubFilter = await admin("GET", "/hot-tub/tubs?active=maybe");
    check("HotTub rejects invalid activity filter",
      invalidHotTubFilter.status === 400,
      `${invalidHotTubFilter.status} ${JSON.stringify(invalidHotTubFilter.data)}`);
    const reactivatedHotTub = await admin("PUT", `/hot-tub/tubs/${inactiveHotTub.data?.id}`, {
      active: true,
    });
    expect("manager can reactivate HotTub asset", reactivatedHotTub, [200]);
    check("reactivated HotTub asset is active",
      reactivatedHotTub.data?.active === true,
      JSON.stringify(reactivatedHotTub.data));
    const clientWideSite = await admin("POST", "/sites", {
      name: `Lock Client-Wide Site ${suffix}`, seedStarterChecks: false,
    });
    expect("create lock client-wide site", clientWideSite, [200, 201]);
    if (clientWideSite.status === 200 || clientWideSite.status === 201) {
      expect("scoped staff can create HotTub asset at client-wide site",
        await scopedStaff("POST", "/hot-tub/tubs", {
          name: `Scoped client-wide tub ${suffix}`, siteId: clientWideSite.data.id,
        }), [201]);
    }
    const blockedHotTubCreate = await scopedStaff("POST", "/hot-tub/tubs", {
      name: `Blocked cross-department tub ${suffix}`, siteId: betaSite.data.id,
    });
    check("scoped staff cannot create HotTub asset in another department",
      blockedHotTubCreate.status === 403,
      `${blockedHotTubCreate.status} ${JSON.stringify(blockedHotTubCreate.data)}`);
    const hotTubAssetsAfterBlockedCreate = await admin("GET", "/hot-tub/tubs");
    check("blocked HotTub create leaves no out-of-scope asset",
      !hotTubAssetsAfterBlockedCreate.data?.some?.(
        row => row.name === `Blocked cross-department tub ${suffix}`,
      ),
      JSON.stringify(hotTubAssetsAfterBlockedCreate.data));
    const adminBetaHotTub = await admin("POST", "/hot-tub/tubs", {
      name: `Admin beta tub ${suffix}`, siteId: betaSite.data.id,
    });
    expect("admin can create HotTub asset in another department", adminBetaHotTub, [201]);
    const scopedHotTubAssets = await scopedStaff("GET", "/hot-tub/tubs");
    check("scoped staff HotTub list includes current-department asset",
      scopedHotTubAssets.data?.some?.(row => row.id === scopedHotTubCreate.data?.id),
      JSON.stringify(scopedHotTubAssets.data));
    if (clientWideSite.status === 200 || clientWideSite.status === 201) {
      check("scoped staff HotTub list includes client-wide asset",
        scopedHotTubAssets.data?.some?.(row => row.name === `Scoped client-wide tub ${suffix}`),
        JSON.stringify(scopedHotTubAssets.data));
    }
    check("scoped staff HotTub list hides other-department assets",
      !scopedHotTubAssets.data?.some?.(row =>
        row.id === scopedHotTubAsset.data?.id || row.id === adminBetaHotTub.data?.id),
      JSON.stringify(scopedHotTubAssets.data));
    const adminHotTubAssets = await admin("GET", "/hot-tub/tubs");
    check("admin HotTub list includes other-department asset",
      adminHotTubAssets.data?.some?.(row => row.id === adminBetaHotTub.data?.id),
      JSON.stringify(adminHotTubAssets.data));

    const scopedPremises = await admin("POST", "/premises-track", {
      inspectionDate: today, nextInspectionDate: iso(30), inspectionType: "routine",
      area: "Alpha area", findings: "Current finding", status: "actioned",
      inspectedBy: "Lock Fixture", siteId: alphaSite.data.id,
    });
    expect("seed current scoped Premises inspection", scopedPremises, [201]);
    if (scopedPremises.status === 201) {
      const premisesPath = `/premises-track/${scopedPremises.data?.id}`;
      const premisesStaffBody = {
        inspectionDate: today, nextInspectionDate: iso(30), inspectionType: "routine",
        area: "Alpha area", findings: "Staff finding", status: "actioned",
        inspectedBy: "Lock Fixture", siteId: alphaSite.data.id,
      };
      expect("scoped staff can edit current Premises inspection",
        await scopedStaff("PUT", premisesPath, premisesStaffBody), [200]);
      const staffPremisesMove = await scopedStaff("PUT", premisesPath, {
        ...premisesStaffBody, siteId: betaSite.data.id,
      });
      check("scoped staff cannot move Premises inspection",
        staffPremisesMove.status === 400 || staffPremisesMove.status === 403,
        `${staffPremisesMove.status} ${JSON.stringify(staffPremisesMove.data)}`);
      const premisesAfterMove = await admin("GET", `/premises-track?siteId=${alphaSite.data.id}`);
      check("rejected Premises move keeps original site",
        premisesAfterMove.data?.some?.(row => row.id === scopedPremises.data.id
          && (row.siteId ?? row.site_id) === alphaSite.data.id),
        JSON.stringify(premisesAfterMove.data));
      const adminPremisesMove = await admin("PUT", premisesPath, {
        ...premisesStaffBody, siteId: betaSite.data.id,
      });
      expect("admin can move Premises inspection", adminPremisesMove, [200]);
      const premisesAtBeta = await admin("GET", `/premises-track?siteId=${betaSite.data.id}`);
      check("admin Premises move changes site",
        premisesAtBeta.data?.some?.(row => row.id === scopedPremises.data.id
          && (row.siteId ?? row.site_id) === betaSite.data.id),
        JSON.stringify(premisesAtBeta.data));
    }

    const scopedRoom = await admin("POST", "/room-track/rooms", {
      roomNumber: `SCOPED-${suffix}`, name: "Scoped Suite", floor: "1",
      siteId: alphaSite.data.id,
    });
    expect("seed scoped Room registry", scopedRoom, [201]);
    if (scopedRoom.status === 201) {
      const scopedRoomCheck = await admin("POST", "/room-track/checks", {
        roomId: scopedRoom.data?.id, siteId: alphaSite.data.id, checkDate: today,
        clean: true, tidy: true, toStandard: true, notes: "Lock Fixture",
      });
      expect("seed current scoped Room check", scopedRoomCheck, [201]);
      if (scopedRoomCheck.status === 201) {
        const roomCheckPath = `/room-track/checks/${scopedRoomCheck.data?.id}`;
        expect("scoped staff can edit current Room check",
          await scopedStaff("PUT", roomCheckPath, { notes: "scoped staff edit" }), [200]);
        const staffRoomMove = await scopedStaff("PUT", roomCheckPath, { siteId: betaSite.data.id });
        check("scoped staff cannot move Room check",
          staffRoomMove.status === 400 || staffRoomMove.status === 403,
          `${staffRoomMove.status} ${JSON.stringify(staffRoomMove.data)}`);
        const roomChecksAfterMove = await admin("GET", `/room-track/checks?roomId=${scopedRoom.data.id}`);
        const roomCheckAfterMove = roomChecksAfterMove.data?.find?.(
          row => row.id === scopedRoomCheck.data.id,
        );
        check("rejected Room move keeps original site",
          (roomCheckAfterMove?.siteId ?? roomCheckAfterMove?.site_id) === alphaSite.data.id,
          JSON.stringify(roomCheckAfterMove));
        const adminRoomMove = await admin("PUT", `/room-track/rooms/${scopedRoom.data.id}`, {
          roomNumber: `SCOPED-${suffix}`, name: "Scoped Suite", floor: "1",
          siteId: betaSite.data.id,
        });
        expect("admin can move Room registry", adminRoomMove, [200]);
        const adminRoomCheckMove = await admin("PUT", roomCheckPath, { siteId: betaSite.data.id });
        expect("admin can move Room check with its registry", adminRoomCheckMove, [200]);
        check("admin Room move changes site",
          (adminRoomCheckMove.data?.siteId ?? adminRoomCheckMove.data?.site_id) === betaSite.data.id,
          JSON.stringify(adminRoomCheckMove.data));
      }
    }
  }

  // Food-safety also supplies the metadata/config regression assertion.
  const configBefore = await admin("GET", "/food-safety/config");
  expect("read food config before", configBefore, [200]);
  const foodOld = await admin("POST", "/food-safety", { recordDate: old, correctives: "seed" });
  expect("seed old food record", foodOld, [201]);
  const foodId = foodOld.data?.id;
  const foodLockedPut = await staff("PUT", `/food-safety/${foodId}`, { correctives: "staff edit" });
  check("food old PUT is locked", foodLockedPut.status === 423 && foodLockedPut.data?.code === "TRACK_RECORD_LOCKED", `${foodLockedPut.status} ${JSON.stringify(foodLockedPut.data)}`);
  const foodForged = await staff("PUT", `/food-safety/${foodId}`, { recordDate: today, correctives: "forged date" });
  check("food forged fresh date remains locked", foodForged.status === 423, `got ${foodForged.status}`);
  const foodAdminFix = await admin("PUT", `/food-safety/${foodId}`, { correctives: "admin correction" });
  expect("food admin correction works", foodAdminFix, [200]);
  const foodDeleteSeed = await admin("POST", "/food-safety", { recordDate: iso(-4) });
  const foodLockedDelete = await staff("DELETE", `/food-safety/${foodDeleteSeed.data?.id}`);
  check("food old DELETE is locked", foodLockedDelete.status === 423, `got ${foodLockedDelete.status}`);
  const foodDraft = await staff("POST", "/food-safety", { recordDate: yesterday });
  expect("food yesterday draft create", foodDraft, [201]);
  expect("food yesterday draft update", await staff("PUT", `/food-safety/${foodDraft.data?.id}`, { correctives: "draft staff edit" }), [200]);
  const configAfter = await admin("GET", "/food-safety/config");
  check("food config unaffected by record lock", JSON.stringify(configAfter.data) === JSON.stringify(configBefore.data), "config changed");

  // Representative check-based family (fire safety).
  const fireOld = await admin("POST", "/fire-safety", { checkType: "alarm", checkDate: old, result: "pass", performedBy: "Admin" });
  expect("seed old fire record", fireOld, [201]);
  const fireId = fireOld.data?.id;
  check("fire old PUT is locked", (await staff("PUT", `/fire-safety/${fireId}`, { notes: "staff edit" })).status === 423);
  check("fire forged date remains locked", (await staff("PUT", `/fire-safety/${fireId}`, { checkDate: today, notes: "forged" })).status === 423);
  expect("fire admin correction works", await admin("PUT", `/fire-safety/${fireId}`, { notes: "admin correction" }), [200]);
  const fireDeleteSeed = await admin("POST", "/fire-safety", { checkType: "alarm", checkDate: iso(-4), result: "pass" });
  check("fire old DELETE is locked", (await staff("DELETE", `/fire-safety/${fireDeleteSeed.data?.id}`)).status === 423);
  const fireDraft = await staff("POST", "/fire-safety", { checkType: "alarm", checkDate: today, result: "pass" });
  expect("fire today draft create", fireDraft, [201]);
  expect("fire today draft update", await staff("PUT", `/fire-safety/${fireDraft.data?.id}`, { notes: "draft staff edit" }), [200]);

  // AM checklists exercise a route whose date is named checkDate.
  const amOld = await admin("POST", "/daily-track-am", {
    checklistType: "kitchen_opening", checkDate: old, items: [],
  });
  if (amOld.status === 403) {
    check("daily AM entitlement available", false, JSON.stringify(amOld.data));
  } else {
    expect("seed old daily AM record", amOld, [201]);
    const amId = amOld.data?.id;
    check("daily AM old PUT is locked", (await staff("PUT", `/daily-track-am/${amId}`, { managerNote: "staff edit" })).status === 423);
    check("daily AM forged date remains locked", (await staff("PUT", `/daily-track-am/${amId}`, { checkDate: today, managerNote: "forged" })).status === 423);
    expect("daily AM admin correction works", await admin("PUT", `/daily-track-am/${amId}`, { managerNote: "admin correction" }), [200]);
    const amDeleteSeed = await admin("POST", "/daily-track-am", { checklistType: "kitchen_opening", checkDate: iso(-4), items: [] });
    check("daily AM old DELETE is locked", (await staff("DELETE", `/daily-track-am/${amDeleteSeed.data?.id}`)).status === 423);
    const amDraft = await staff("POST", "/daily-track-am", { checklistType: "kitchen_opening", checkDate: yesterday, items: [] });
    expect("daily AM yesterday draft create", amDraft, [201]);
    expect("daily AM yesterday draft update", await staff("PUT", `/daily-track-am/${amDraft.data?.id}`, { managerNote: "draft staff edit" }), [200]);
  }

  // Additional families with deliberately small payloads.  A 403 here is a
  // failure (rather than an entitlement skip): self-registered fixtures must
  // expose the services exercised by this regression suite.
  const family = async (label, collection, createBody, freshBody, updateBody = { notes: "admin correction" }) => {
    const seeded = await admin("POST", collection, createBody);
    expect(`${label}: seed old record`, seeded, [201]);
    if (seeded.status !== 201) return;
    let id = seeded.data?.id;
    if (collection === "/pool-track" && !id) {
      // The legacy pool POST responds with an empty body; find this fixture
      // through the tenant-scoped list rather than assuming a returned id.
      const listed = await admin("GET", "/pool-track");
      id = listed.data?.find?.(row => row.notes === createBody.notes)?.id;
    }
    check(`${label}: seeded id available`, Number.isInteger(id));
    if (!Number.isInteger(id)) return;
    const locked = await staff("PUT", `${collection}/${id}`, updateBody);
    check(`${label}: old PUT is locked`, locked.status === 423, `got ${locked.status}`);
    const forged = await staff("PUT", `${collection}/${id}`, freshBody);
    check(`${label}: forged fresh date remains locked`, forged.status === 423, `got ${forged.status}`);
    expect(`${label}: admin correction works`, await admin("PUT", `${collection}/${id}`, updateBody), [200]);
    const deleteSeed = await admin("POST", collection, { ...createBody, notes: "delete seed" });
    expect(`${label}: seed delete record`, deleteSeed, [201]);
    if (deleteSeed.status === 201) {
      let deleteId = deleteSeed.data?.id;
      if (collection === "/pool-track" && !deleteId) {
        const listed = await admin("GET", "/pool-track");
        deleteId = listed.data?.find?.(row => row.notes === "delete seed")?.id;
      }
      check(`${label}: delete fixture id available`, Number.isInteger(deleteId));
      if (Number.isInteger(deleteId)) {
        check(`${label}: old DELETE is locked`, (await staff("DELETE", `${collection}/${deleteId}`)).status === 423);
      }
    }
  };

  // The remaining tracks have different response envelopes, and several have
  // manager-only metadata endpoints. Keep the assertions focused on the real
  // dated evidence mutation route rather than making the generic helper guess
  // where an id lives.
  const datedFamily = async ({
    label, createPath, updatePath = createPath, deletePath = updatePath,
    createBody, deleteBody, deleteCreateBody = deleteBody, forgedBody, updateBody,
    idFrom = (data) => data?.id,
    expectDelete = true,
  }) => {
    const seeded = await admin("POST", createPath, createBody);
    expect(`${label}: seed old record`, seeded, [201]);
    if (seeded.status !== 201) return null;
    const id = idFrom(seeded.data);
    check(`${label}: seeded id available`, Number.isInteger(id), JSON.stringify(seeded.data));
    if (!Number.isInteger(id)) return null;

    const path = `${updatePath}/${id}`;
    const locked = await staff("PUT", path, updateBody);
    check(`${label}: old PUT is locked`,
      locked.status === 423 && locked.data?.code === "TRACK_RECORD_LOCKED",
      `${locked.status} ${JSON.stringify(locked.data)}`);
    const forged = await staff("PUT", path, forgedBody);
    check(`${label}: forged fresh date remains locked`,
      forged.status === 423 && forged.data?.code === "TRACK_RECORD_LOCKED",
      `${forged.status} ${JSON.stringify(forged.data)}`);
    const corrected = await admin("PUT", path, updateBody);
    expect(`${label}: admin correction works`, corrected, [200]);

    if (expectDelete) {
      const deleteSeed = await admin("POST", createPath, deleteCreateBody);
      expect(`${label}: seed delete record`, deleteSeed, [201]);
      const deleteId = idFrom(deleteSeed.data);
      check(`${label}: delete fixture id available`, Number.isInteger(deleteId), JSON.stringify(deleteSeed.data));
      if (Number.isInteger(deleteId)) {
        const deleted = await staff("DELETE", `${deletePath}/${deleteId}`);
        check(`${label}: old DELETE is locked`,
          deleted.status === 423 && deleted.data?.code === "TRACK_RECORD_LOCKED",
          `${deleted.status} ${JSON.stringify(deleted.data)}`);
      }
    }
    return id;
  };

  // PAT tests are dated evidence; the appliance itself is an editable asset
  // and must remain editable even when its created_at is historical.
  let tenantProbeId = null;
  const patApplianceBody = { name: `Lock PAT appliance ${suffix}`, applianceType: "Kettle" };
  const patAppliance = await admin("POST", "/pat-track/appliances", patApplianceBody);
  expect("PAT: seed appliance asset", patAppliance, [201]);
  if (patAppliance.status === 201) {
    const applianceId = patAppliance.data?.id;
    const applianceEdit = await staff("PUT", `/pat-track/appliances/${applianceId}`, {
      ...patApplianceBody, name: `${patApplianceBody.name} edited`,
    });
    expect("PAT appliance asset remains editable", applianceEdit, [200]);
    const patTestBody = {
      applianceId, testDate: old, result: "pass", nextTestDate: iso(30), testedBy: "Lock Fixture",
    };
    tenantProbeId = await datedFamily({
      label: "PAT test", createPath: "/pat-track/tests", createBody: patTestBody,
      deleteBody: { ...patTestBody, testDate: iso(-4) },
      forgedBody: { ...patTestBody, testDate: today, result: "fail" },
      updateBody: { ...patTestBody, notes: "admin correction" },
    });
  }

  // Bike hires and service records both carry independent stored dates.
  const bike = await admin("POST", "/bike-track/bikes", {
    ref: `LOCK-BIKE-${suffix}`, type: "hybrid",
  });
  expect("Bike: seed asset", bike, [201]);
  if (bike.status === 201) {
    const bikeId = bike.data?.id;
    const bikeAssetEdit = await staff("PUT", `/bike-track/bikes/${bikeId}`, {
      ref: `LOCK-BIKE-EDIT-${suffix}`, type: "hybrid",
    });
    expect("Bike asset remains editable", bikeAssetEdit, [200]);
    const hireBody = {
      bikeId, guestName: "Lock Fixture Guest", hireDate: old,
      returnDateExpected: iso(-2), depositPence: 2500,
      preHireCheck: { overallResult: "pass", checkDate: old },
    };
    const hireDeleteBike = await admin("POST", "/bike-track/bikes", {
      ref: `LOCK-HIRE-DELETE-BIKE-${suffix}`, type: "hybrid",
    });
    expect("Bike hire delete: seed asset", hireDeleteBike, [201]);
    await datedFamily({
      label: "Bike hire", createPath: "/bike-track/hires", createBody: hireBody,
      idFrom: (data) => data?.hire?.id,
      deleteBody: { ...hireBody, hireDate: iso(-4), preHireCheck: { overallResult: "pass", checkDate: iso(-4) } },
      deleteCreateBody: {
        ...hireBody, bikeId: hireDeleteBike.data?.id, hireDate: iso(-4),
        preHireCheck: { overallResult: "pass", checkDate: iso(-4) },
      },
      forgedBody: { returnDateExpected: iso(1), notes: "forged fresh date" },
      updateBody: { notes: "admin correction" },
    });
    // A hire marks the bike as hired, so use a second asset for the service
    // fixture and keep the service route's own stored date authoritative.
    const serviceBike = await admin("POST", "/bike-track/bikes", {
      ref: `LOCK-SERVICE-BIKE-${suffix}`, type: "hybrid",
    });
    expect("Bike service: seed asset", serviceBike, [201]);
    if (serviceBike.status === 201) {
      const serviceBody = {
        bikeId: serviceBike.data?.id, serviceDate: old, serviceType: "annual",
        servicedBy: "Lock Fixture", nextServiceDate: iso(30),
      };
      await datedFamily({
        label: "Bike service", createPath: "/bike-track/services", createBody: serviceBody,
        deleteBody: { ...serviceBody, serviceDate: iso(-4) },
        forgedBody: { serviceDate: today, notes: "forged fresh date" },
        updateBody: { notes: "admin correction" },
      });
    }
  }

  // Green pre-use checks are staff-editable dated evidence. Machines and
  // manager-only service records are registry/workflow metadata for this suite.
  const machine = await admin("POST", "/green-track/machines", {
    name: `Lock mower ${suffix}`, type: "walk_behind",
  });
  expect("Green: seed machine asset", machine, [201]);
  if (machine.status === 201) {
    const machineId = machine.data?.id;
    const machineEdit = await admin("PUT", `/green-track/machines/${machineId}`, {
      name: `Lock mower edited ${suffix}`, type: "walk_behind",
    });
    expect("Green machine asset remains editable", machineEdit, [200]);
    const greenBody = {
      machineId, checkDate: old, operator: "Lock Fixture",
      fluidLevelsOk: true, tyresOk: true, bladesOk: true, guardsOk: true,
      controlsOk: true, lightsOk: true, cleanlinessOk: true,
    };
    await datedFamily({
      label: "Green pre-use check", createPath: "/green-track/pre-use-checks",
      createBody: greenBody, deleteBody: { ...greenBody, checkDate: iso(-4) },
      forgedBody: { checkDate: today, notes: "forged fresh date" },
      updateBody: { notes: "admin correction" },
    });
  }

  await datedFamily({
    label: "HotTub check", createPath: "/hot-tub", createBody: {
      checkType: "water_chemistry", checkDate: old, result: "pass",
      phValue: 7.4, sanitiserLevel: 2, performedBy: "Lock Fixture",
    },
    deleteBody: {
      checkType: "water_chemistry", checkDate: iso(-4), result: "pass",
      phValue: 7.4, sanitiserLevel: 2, performedBy: "Lock Fixture",
    },
    forgedBody: { checkDate: today, result: "fail", phValue: 7.1, sanitiserLevel: 1 },
    updateBody: { notes: "admin correction" },
  });
  const tub = await admin("POST", "/hot-tub/tubs", { name: `Lock tub ${suffix}` });
  expect("HotTub: seed asset", tub, [201]);
  if (tub.status === 201) {
    const tubEdit = await staff("PUT", `/hot-tub/tubs/${tub.data?.id}`, { name: `Lock tub edited ${suffix}` });
    expect("HotTub asset remains editable", tubEdit, [200]);
  }

  await datedFamily({
    label: "Legionella check", createPath: "/legionella", createBody: {
      checkType: "calorifier_temp", checkDate: old, result: "pass",
      temperature: 60, performedBy: "Lock Fixture",
    },
    deleteBody: {
      checkType: "calorifier_temp", checkDate: iso(-4), result: "pass",
      temperature: 60, performedBy: "Lock Fixture",
    },
    forgedBody: { checkDate: today, result: "pass", temperature: 60 },
    updateBody: { notes: "admin correction" },
  });

  await datedFamily({
    label: "Swim session", createPath: "/swim-track/sessions", createBody: {
      sessionDate: old, sessionType: "public_swim", preSessionResult: "pass",
      poolClosed: false, notes: "Lock Fixture",
    },
    deleteBody: {
      sessionDate: iso(-4), sessionType: "public_swim", preSessionResult: "pass",
      poolClosed: false, notes: "Lock Fixture delete",
    },
    forgedBody: { sessionDate: today, sessionType: "public_swim", preSessionResult: "fail", poolClosed: true },
    updateBody: {
      sessionDate: today, sessionType: "public_swim", preSessionResult: "pass",
      poolClosed: false, notes: "admin correction",
    },
  });

  await datedFamily({
    label: "Premises inspection", createPath: "/premises-track", createBody: {
      inspectionDate: old, nextInspectionDate: iso(30), inspectionType: "routine",
      area: "Main building", findings: "Old finding", hazardDetails: "Trip hazard",
      actionRequired: "Repair flooring", actionTaken: "Repair scheduled",
      status: "actioned", inspectedBy: "Lock Fixture",
    },
    deleteBody: {
      inspectionDate: iso(-4), nextInspectionDate: iso(30), inspectionType: "routine",
      area: "Delete area", findings: "Old finding", status: "open", inspectedBy: "Lock Fixture",
    },
    forgedBody: { inspectionDate: today, findings: "forged fresh date" },
    updateBody: {
      inspectionDate: today, nextInspectionDate: iso(30), inspectionType: "routine",
      area: "Main building", findings: "Admin correction", status: "closed", inspectedBy: "Lock Fixture",
    },
  });

  const room = await admin("POST", "/room-track/rooms", {
    roomNumber: `LOCK-${suffix}`, name: "Lock Suite", floor: "1",
  });
  expect("Room: seed metadata", room, [201]);
  if (room.status === 201) {
    const roomCheckBody = {
      roomId: room.data?.id, checkDate: old, clean: true, tidy: true, toStandard: true,
      notes: "Lock Fixture",
    };
    await datedFamily({
      label: "Room check", createPath: "/room-track/checks", createBody: roomCheckBody,
      expectDelete: false, forgedBody: { checkDate: today, clean: false },
      updateBody: { clean: true, tidy: true, toStandard: false, notes: "admin correction" },
    });
    // There is no check DELETE handler; the room registry itself is admin-only
    // metadata and is intentionally not treated as dated evidence.
    const roomEdit = await admin("PUT", `/room-track/rooms/${room.data?.id}`, {
      roomNumber: `LOCK-${suffix}`, name: "Lock Suite edited", floor: "1",
    });
    expect("Room metadata remains editable", roomEdit, [200]);
  }

  await datedFamily({
    label: "KitchenWeekly weekly", createPath: "/kitchen-weekly/weekly",
    createBody: {
      weekCommencing: old, checks: { temperatureControl: "yes" },
      submittedAt: `${old}T12:00:00.000Z`, managerSignature: "Lock Fixture",
    },
    deleteBody: {
      weekCommencing: iso(-10), checks: { temperatureControl: "yes" },
      submittedAt: `${iso(-10)}T12:00:00.000Z`, managerSignature: "Lock Fixture",
    },
    forgedBody: { weekCommencing: today, checks: { temperatureControl: "no" } },
    updateBody: { checks: { temperatureControl: "no" }, notes: "admin correction" },
    expectDelete: false,
  });
  await datedFamily({
    label: "KitchenWeekly probe", createPath: "/kitchen-weekly/probe",
    createBody: {
      checkDate: iso(-2),
      probes: [{ name: "Probe A", iceTemp: "0.2", boilingTemp: "99.8", accurateIce: true, accurateBoiling: true }],
      overallResult: "pass", checkedBy: "Lock Fixture",
    },
    deleteBody: {
      checkDate: iso(-11),
      probes: [{ name: "Probe Delete", iceTemp: "0.2", accurateIce: true }],
      overallResult: "pass", checkedBy: "Lock Fixture",
    },
    forgedBody: { checkDate: today, overallResult: "fail" },
    updateBody: { overallResult: "pass", notes: "admin correction" },
    expectDelete: false,
  });

  const fixBody = {
    title: `Historical issue ${suffix}`, issueType: "general", location: "Plant room",
    description: "Old persisted operational issue", priority: "medium",
    reportedBy: "Facilities", reportedDate: old, targetDate: iso(-2),
  };
  // FixTrack issues are workflow records, not dated evidence. Their
  // reportedDate/targetDate fields remain editable under FixTrack's normal
  // authorization; created_at must not turn an issue into a locked checklist.
  const fixIssue = await admin("POST", "/fix-track/issues", fixBody);
  expect("FixTrack: seed issue workflow record", fixIssue, [201]);
  if (fixIssue.status === 201) {
    const fixId = fixIssue.data?.id;
    expect("FixTrack workflow remains editable for staff", await staff("PUT", `/fix-track/issues/${fixId}`, {
      reportedDate: today, targetDate: today, status: "in_progress",
    }), [200]);
    const fixDelete = await staff("DELETE", `/fix-track/issues/${fixId}`);
    expect("FixTrack workflow delete uses existing authorization", fixDelete, [204]);
  }

  await family("SafeTrack training", "/safe-track/training-records", {
    staffName: "Lock Fixture", trainingType: "Manual handling", completedAt: old, notes: "seed",
  }, { completedAt: today, notes: "forged" });
  await family("pool-track", "/pool-track", {
    checkDate: old, checkType: "routine", result: "pass", performedBy: "Admin", phLevel: 7.4, notes: `pool-lock-${suffix}`,
  }, { checkDate: today, notes: "forged" });
  await family("tree-track", "/tree-track", {
    checkType: "visual_assessment", checkDate: old, result: "pass", treeRef: "LOCK-1", inspector: "Admin",
  }, { checkDate: today, notes: "forged" });
  await family("pest-track visits", "/pest-track/visits", {
    visitDate: old, contractorName: "Lock Pest Control", findings: "none",
  }, { visitDate: today, notes: "forged" }, { visitDate: old, notes: "admin correction" });

  const trainOld = await admin("POST", "/train-track/records", {
    recordType: "internal", staffName: "Lock Fixture", trainingType: "Safety",
    trainer: "Admin", completedDate: old,
  });
  expect("TrainTrack: seed old record", trainOld, [201]);
  if (trainOld.status === 201) {
    const path = `/train-track/records/${trainOld.data?.id}`;
    const locked = await staff("PATCH", path, { notes: "staff edit" });
    check("TrainTrack: old PATCH is locked", locked.status === 423 && locked.data?.code === "TRACK_RECORD_LOCKED");
    check("TrainTrack: forged date PATCH stays locked",
      (await staff("PATCH", path, { completedDate: today, notes: "forged" })).status === 423);
    expect("TrainTrack: admin PATCH correction works", await admin("PATCH", path, { notes: "admin correction" }), [200]);
  }

  // PAT, Green and Swim dated subroutes beyond the representative records
  // above. Each asserts the stored date wins over the body, that other path
  // spellings Express would still route cannot skip the lock, the route's own
  // authorization for current records, and that blocked attempts saved nothing.
  const bypassMarker = `staff-bypass-${suffix}`;
  const sqlRun = (statement) => execFileSync("psql",
    [process.env.DATABASE_URL, "-X", "-v", "ON_ERROR_STOP=1", "-Atc", statement],
    { encoding: "utf8" }).trim();
  const backdateCreatedAt = (table, id, days) => {
    if (!Number.isInteger(id)) return false;
    return sqlRun(`UPDATE ${table} SET created_at = now() - interval '${days} days' WHERE id = ${id} RETURNING id`)
      .split("\n")[0] === String(id);
  };
  const pathVariants = (path) => {
    const [, prefix, rest] = path.match(/^(\/[^/]+)(\/.*)$/);
    const id = path.match(/(\d+)$/)[1];
    return [
      ["trailing slash", `${path}/`],
      ["upper-case track", `${prefix.toUpperCase()}${rest}`],
      ["percent-encoded id", path.replace(/\d+$/, [...id].map((digit) => `%3${digit}`).join(""))],
      ["doubled slash", `${prefix}/${rest}`],
      // Routes parse ids with Number() or a Postgres integer cast; both accept these.
      ["signed id", path.replace(/\d+$/, `+${id}`)],
      ["space-padded id", path.replace(/\d+$/, `%20${id}`)],
      ["hex id", path.replace(/\d+$/, `0x${Number(id).toString(16)}`)],
    ];
  };
  const isLocked = (r) => r.status === 423 && r.data?.code === "TRACK_RECORD_LOCKED";
  const lockedSubroute = async ({
    label, path, listPath = path, createOld, createCurrent,
    staffEdit, forgedEdit, adminEdit, currentEdit, backdateEdit,
    staffCurrentPut, staffCurrentDelete, adminDelete,
  }) => {
    const oldRecord = await createOld();
    const currentRecord = await createCurrent();
    expect(`${label}: seed old record`, oldRecord, [201]);
    expect(`${label}: seed current record`, currentRecord, [201]);
    const oldId = oldRecord.data?.id, currentId = currentRecord.data?.id;
    check(`${label}: seeded ids available`, Number.isInteger(oldId) && Number.isInteger(currentId),
      `${JSON.stringify(oldRecord.data)} ${JSON.stringify(currentRecord.data)}`);
    if (!Number.isInteger(oldId) || !Number.isInteger(currentId)) return;
    const oldPath = `${path}/${oldId}`, currentPath = `${path}/${currentId}`;

    const lockedPut = await staff("PUT", oldPath, staffEdit);
    check(`${label}: old PUT is locked`, isLocked(lockedPut), `${lockedPut.status} ${JSON.stringify(lockedPut.data)}`);
    const forgedPut = await staff("PUT", oldPath, forgedEdit);
    check(`${label}: forged fresh date stays locked`, isLocked(forgedPut), `${forgedPut.status} ${JSON.stringify(forgedPut.data)}`);
    const lockedDelete = await staff("DELETE", oldPath);
    check(`${label}: old DELETE is locked`, isLocked(lockedDelete), `${lockedDelete.status} ${JSON.stringify(lockedDelete.data)}`);
    for (const [variant, variantPath] of pathVariants(oldPath)) {
      for (const [method, body] of [["PUT", forgedEdit], ["DELETE", undefined]]) {
        const attempt = await staff(method, variantPath, body);
        check(`${label}: old ${method} via ${variant} is not accepted`,
          attempt.status < 200 || attempt.status >= 300, `${attempt.status} ${JSON.stringify(attempt.data)}`);
      }
    }
    const afterAttempts = await admin("GET", listPath);
    const storedOld = afterAttempts.data?.find?.((row) => row.id === oldId);
    check(`${label}: blocked staff attempts kept the old record`, Boolean(storedOld), JSON.stringify(afterAttempts.data));
    check(`${label}: blocked staff attempts saved nothing`,
      Boolean(storedOld) && !JSON.stringify(storedOld).includes(bypassMarker), JSON.stringify(storedOld));

    expect(`${label}: admin correction works`, await admin("PUT", oldPath, adminEdit), [200]);
    expect(`${label}: staff PUT of current record`, await staff("PUT", currentPath, currentEdit), [staffCurrentPut]);
    if (backdateEdit) {
      const backdated = await staff("PUT", currentPath, backdateEdit);
      check(`${label}: staff cannot backdate a current record`, isLocked(backdated),
        `${backdated.status} ${JSON.stringify(backdated.data)}`);
    }
    expect(`${label}: staff DELETE of current record`, await staff("DELETE", currentPath), [staffCurrentDelete]);
    expect(`${label}: admin DELETE of old record`, await admin("DELETE", oldPath), [adminDelete]);
    return { oldId, currentId };
  };

  // PAT: certificates, replacements and failures are retained evidence. Their
  // DELETE handlers refuse every role (405); staff hit the lock first on old rows.
  const patSite = await admin("POST", "/sites", { name: `Lock PAT Site ${suffix}`, seedStarterChecks: false });
  expect("PAT subroutes: seed site", patSite, [200, 201]);
  const patRoom = await admin("POST", "/pat-track/rooms", { siteId: patSite.data?.id, name: `Lock PAT room ${suffix}` });
  expect("PAT subroutes: seed room", patRoom, [201]);
  if (patRoom.status === 201) {
    const siteId = patSite.data.id, roomId = patRoom.data.id;
    // Rooms are site metadata: an old room stays editable for staff.
    check("PAT room: backdate created_at", backdateCreatedAt("pat_rooms", roomId, 400));
    expect("PAT room metadata remains editable for staff",
      await staff("PUT", `/pat-track/rooms/${roomId}`, { siteId, name: `Lock PAT room edited ${suffix}` }), [200]);

    const certificate = (visitDate, extra = {}) => ({
      siteId, visitDate, certificateRef: `LOCK-CERT-${suffix}`, roomIds: [roomId], ...extra,
    });
    const certificates = await lockedSubroute({
      label: "PAT certificate", path: "/pat-track/certificates",
      createOld: () => admin("POST", "/pat-track/certificates", certificate(old)),
      createCurrent: () => admin("POST", "/pat-track/certificates", certificate(today)),
      staffEdit: certificate(old, { notes: bypassMarker }),
      forgedEdit: certificate(today, { notes: bypassMarker }),
      adminEdit: certificate(old, { notes: "admin correction" }),
      currentEdit: certificate(today, { notes: "staff edit" }),
      backdateEdit: certificate(old, { notes: "backdated" }),
      staffCurrentPut: 200, staffCurrentDelete: 405, adminDelete: 405,
    });

    const replacement = (replacedOn, extra = {}) => ({
      roomId, applianceName: "Lock kettle", replacedOn, ...extra,
    });
    await lockedSubroute({
      label: "PAT replacement", path: "/pat-track/replacements",
      createOld: () => admin("POST", "/pat-track/replacements", replacement(old)),
      createCurrent: () => admin("POST", "/pat-track/replacements", replacement(today)),
      staffEdit: replacement(old, { notes: bypassMarker }),
      forgedEdit: replacement(today, { notes: bypassMarker }),
      adminEdit: replacement(old, { notes: "admin correction" }),
      currentEdit: replacement(today, { notes: "staff edit" }),
      backdateEdit: replacement(old, { notes: "backdated" }),
      staffCurrentPut: 200, staffCurrentDelete: 405, adminDelete: 405,
    });

    // A failure is dated by when it was recorded (created_at), which no body
    // can set, so the old fixture is backdated in the database.
    if (certificates) {
      const failure = (extra = {}) => ({
        certificateId: certificates.oldId, roomId, applianceName: "Lock toaster", ...extra,
      });
      await lockedSubroute({
        label: "PAT failure", path: "/pat-track/failures",
        createOld: async () => {
          const created = await admin("POST", "/pat-track/failures", failure());
          if (created.status === 201) check("PAT failure: backdate created_at", backdateCreatedAt("pat_failures", created.data?.id, 3));
          return created;
        },
        createCurrent: () => admin("POST", "/pat-track/failures", failure()),
        staffEdit: failure({ actionTaken: bypassMarker }),
        forgedEdit: failure({ actionTaken: bypassMarker, resolvedDate: today, createdAt: today }),
        adminEdit: failure({ actionTaken: "admin correction", resolution: "Replaced", resolvedDate: today }),
        currentEdit: failure({ actionTaken: "staff edit" }),
        staffCurrentPut: 200, staffCurrentDelete: 405, adminDelete: 405,
      });
      const failures = await admin("GET", "/pat-track/failures");
      const oldFailure = failures.data?.find?.((row) => row.action_taken === "admin correction");
      if (oldFailure) {
        // The reasoned location correction is the manager-only route for old
        // failures; it appends history instead of editing the failure.
        const correctionPath = `/pat-track/failures/${oldFailure.id}/location-corrections`;
        const correction = { correctedLocationText: "Lock corrected location", reason: "Lock fixture correction" };
        check("PAT failure location correction stays manager-only",
          (await staff("POST", correctionPath, correction)).status === 403);
        expect("PAT failure location correction works for admin on an old failure",
          await admin("POST", correctionPath, correction), [201]);
      } else {
        check("PAT failure: corrected old failure listed", false, JSON.stringify(failures.data));
      }
    }
  }

  // Green: defects and fuel logs are staff records with manager-only DELETE;
  // PUWER inspections are manager-only for every write. The machine register
  // stays manager-editable however old the machine is.
  const greenMachine = await admin("POST", "/green-track/machines", {
    name: `Lock subroute mower ${suffix}`, type: "walk_behind",
  });
  expect("Green subroutes: seed machine", greenMachine, [201]);
  if (greenMachine.status === 201) {
    const machineId = greenMachine.data.id;
    check("Green machine: backdate created_at", backdateCreatedAt("green_machines", machineId, 400));
    const machineBody = { name: `Lock subroute mower edited ${suffix}`, type: "walk_behind" };
    expect("Green machine register stays manager-only",
      await staff("PUT", `/green-track/machines/${machineId}`, machineBody), [403]);
    expect("Green old machine remains editable for admin",
      await admin("PUT", `/green-track/machines/${machineId}`, machineBody), [200]);

    const defect = (reportDate, extra = {}) => ({
      machineId, reportDate, description: "Lock fixture defect", severity: "minor", ...extra,
    });
    await lockedSubroute({
      label: "Green defect", path: "/green-track/defects",
      createOld: () => admin("POST", "/green-track/defects", defect(old)),
      createCurrent: () => admin("POST", "/green-track/defects", defect(today)),
      staffEdit: { notes: bypassMarker, status: "resolved" },
      forgedEdit: { reportDate: today, notes: bypassMarker },
      adminEdit: { status: "resolved", resolution: "Admin resolved", resolvedDate: today, notes: "admin correction" },
      currentEdit: { notes: "staff edit" },
      backdateEdit: { reportDate: old, notes: "backdated" },
      staffCurrentPut: 200, staffCurrentDelete: 403, adminDelete: 200,
    });

    const fuel = (logDate, extra = {}) => ({ machineId, logDate, fuelType: "diesel", quantityLitres: 5, ...extra });
    await lockedSubroute({
      label: "Green fuel log", path: "/green-track/fuel-logs",
      createOld: () => admin("POST", "/green-track/fuel-logs", fuel(old)),
      createCurrent: () => admin("POST", "/green-track/fuel-logs", fuel(today)),
      staffEdit: { notes: bypassMarker },
      forgedEdit: { logDate: today, notes: bypassMarker },
      adminEdit: { notes: "admin correction" },
      currentEdit: { notes: "staff edit" },
      backdateEdit: { logDate: old, notes: "backdated" },
      staffCurrentPut: 200, staffCurrentDelete: 403, adminDelete: 200,
    });

    const puwer = (inspectionDate, extra = {}) => ({
      machineId, inspectionDate, nextInspectionDate: iso(300), inspectorName: "Lock Fixture", ...extra,
    });
    await lockedSubroute({
      label: "Green PUWER inspection", path: "/green-track/puwer-inspections",
      createOld: () => admin("POST", "/green-track/puwer-inspections", puwer(old)),
      createCurrent: () => admin("POST", "/green-track/puwer-inspections", puwer(today)),
      staffEdit: { notes: bypassMarker },
      forgedEdit: { inspectionDate: today, notes: bypassMarker },
      adminEdit: { notes: "admin correction" },
      currentEdit: { notes: "staff edit" },
      backdateEdit: { inspectionDate: old, notes: "backdated" },
      staffCurrentPut: 403, staffCurrentDelete: 403, adminDelete: 200,
    });
  }

  // Swim: surveillance, first-aid and incident records are staff evidence
  // with manager-only DELETE. Surveillance and incident PUTs replace the row,
  // so their edits send the full record.
  const surveillance = (checkDate, observations = "Lock Fixture") => ({
    checkDate, checkTime: "10:00", batherCount: 12, scanCompleted: true, observations,
  });
  await lockedSubroute({
    label: "Swim surveillance", path: "/swim-track/surveillance",
    createOld: () => admin("POST", "/swim-track/surveillance", surveillance(old)),
    createCurrent: () => admin("POST", "/swim-track/surveillance", surveillance(today)),
    staffEdit: surveillance(old, bypassMarker),
    forgedEdit: surveillance(today, bypassMarker),
    adminEdit: surveillance(old, "admin correction"),
    currentEdit: surveillance(today, "staff edit"),
    backdateEdit: surveillance(old, "backdated"),
    staffCurrentPut: 200, staffCurrentDelete: 403, adminDelete: 200,
  });

  const firstAid = (checkDate, extra = {}) => ({ checkDate, aedOk: true, firstAidKitOk: true, ...extra });
  await lockedSubroute({
    label: "Swim first-aid", path: "/swim-track/first-aid",
    createOld: () => admin("POST", "/swim-track/first-aid", firstAid(old)),
    createCurrent: () => admin("POST", "/swim-track/first-aid", firstAid(today)),
    staffEdit: { notes: bypassMarker },
    forgedEdit: { checkDate: today, notes: bypassMarker, aedOk: false },
    adminEdit: { notes: "admin correction" },
    currentEdit: { notes: "staff edit" },
    backdateEdit: { checkDate: old, notes: "backdated" },
    staffCurrentPut: 200, staffCurrentDelete: 403, adminDelete: 200,
  });

  const swimIncident = (incidentDate, notes = "Lock Fixture") => ({
    incidentDate, incidentTime: "11:00", incidentType: "near_miss", severity: "low",
    description: "Lock fixture incident", notes,
  });
  await lockedSubroute({
    label: "Swim incident", path: "/swim-track/incidents",
    createOld: () => admin("POST", "/swim-track/incidents", swimIncident(old)),
    createCurrent: () => admin("POST", "/swim-track/incidents", swimIncident(today)),
    staffEdit: swimIncident(old, bypassMarker),
    forgedEdit: swimIncident(today, bypassMarker),
    adminEdit: swimIncident(old, "admin correction"),
    currentEdit: swimIncident(today, "staff edit"),
    backdateEdit: swimIncident(old, "backdated"),
    staffCurrentPut: 200, staffCurrentDelete: 403, adminDelete: 200,
  });

  // Staff DELETE across departments: the department boundary answers before
  // the date lock, so an out-of-scope old record gives a plain 403 that says
  // nothing about its date, while an in-scope one is locked as usual.
  const lockLeakFields = ["TRACK_RECORD_LOCKED", "cutoffDate", "lockAfterHours", "correction window"];
  const departmentDelete = async ({ label, createPath, path = createPath, body, adminDelete, prepare = () => true }) => {
    if (![200, 201].includes(alphaSite.status) || ![200, 201].includes(betaSite.status)) return;
    const alphaOld = await admin("POST", createPath, body(alphaSite.data.id));
    const betaOld = await admin("POST", createPath, body(betaSite.data.id));
    expect(`${label}: seed in-department old record`, alphaOld, [201]);
    expect(`${label}: seed other-department old record`, betaOld, [201]);
    const alphaId = alphaOld.data?.id, betaId = betaOld.data?.id;
    if (!Number.isInteger(alphaId) || !Number.isInteger(betaId)) {
      check(`${label}: seeded ids available`, false, `${JSON.stringify(alphaOld.data)} ${JSON.stringify(betaOld.data)}`);
      return;
    }
    check(`${label}: prepare old fixtures`, prepare(alphaId) && prepare(betaId));
    const inScope = await scopedStaff("DELETE", `${path}/${alphaId}`);
    check(`${label}: in-department old DELETE is locked`, isLocked(inScope), `${inScope.status} ${JSON.stringify(inScope.data)}`);
    const outOfScope = await scopedStaff("DELETE", `${path}/${betaId}`);
    check(`${label}: other-department old DELETE is forbidden`, outOfScope.status === 403,
      `${outOfScope.status} ${JSON.stringify(outOfScope.data)}`);
    check(`${label}: other-department DELETE does not reveal the lock`,
      !lockLeakFields.some((field) => JSON.stringify(outOfScope.data ?? "").includes(field)),
      JSON.stringify(outOfScope.data));
    const outOfScopePut = await scopedStaff("PUT", `${path}/${betaId}`, { notes: bypassMarker });
    check(`${label}: other-department old PUT is forbidden`, outOfScopePut.status === 403,
      `${outOfScopePut.status} ${JSON.stringify(outOfScopePut.data)}`);
    expect(`${label}: admin DELETE of other-department record unchanged`,
      await admin("DELETE", `${path}/${betaId}`), adminDelete);
  };
  const withSite = (fields) => (siteId) => ({ ...fields, siteId });
  await departmentDelete({
    label: "Dept Fire check", createPath: "/fire-safety", adminDelete: [200, 204],
    body: withSite({ checkType: "alarm", checkDate: old, result: "pass", performedBy: "Lock Fixture" }),
  });
  await departmentDelete({
    label: "Dept Legionella check", createPath: "/legionella", adminDelete: [200, 204],
    body: withSite({ checkType: "calorifier_temp", checkDate: old, result: "pass", temperature: 60, performedBy: "Lock Fixture" }),
  });
  await departmentDelete({
    // 409 is HotTub's own rule: a check with a linked safety action is kept.
    label: "Dept HotTub check", createPath: "/hot-tub", adminDelete: [200, 204, 409],
    body: withSite({ checkType: "water_chemistry", checkDate: old, result: "pass", phValue: 7.4, sanitiserLevel: 2, performedBy: "Lock Fixture" }),
  });
  await departmentDelete({
    label: "Dept Tree inspection", createPath: "/tree-track", adminDelete: [200, 204],
    body: withSite({ checkType: "visual_assessment", checkDate: old, result: "pass", treeRef: "LOCK-DEPT", inspector: "Lock Fixture" }),
  });
  await departmentDelete({
    // Incidents keep their RIDDOR trail, so even an admin DELETE is refused.
    label: "Dept Incident", createPath: "/incidents", adminDelete: [409],
    body: withSite({ incidentDate: old, location: "Lock room", description: "Lock fixture incident", involvedName: "Lock Fixture", reportedBy: "Lock Fixture", riddorRationale: "Lock fixture: not reportable" }),
  });
  await departmentDelete({
    label: "Dept Premises inspection", createPath: "/premises-track", adminDelete: [200, 204],
    body: withSite({ inspectionDate: old, nextInspectionDate: iso(30), inspectionType: "routine", area: "Lock area", findings: "None", status: "closed", inspectedBy: "Lock Fixture" }),
  });
  await departmentDelete({
    label: "Dept TrainTrack record", createPath: "/train-track/records", adminDelete: [200, 204],
    body: withSite({ recordType: "internal", staffName: "Lock Fixture", trainingType: "Safety", trainer: "Admin", completedDate: old }),
  });
  for (const [label, collection, fields] of [
    ["Dept Swim session", "/swim-track/sessions", { sessionDate: old, sessionType: "public_swim", preSessionResult: "pass", poolClosed: false }],
    ["Dept Swim surveillance", "/swim-track/surveillance", { checkDate: old, checkTime: "10:00", scanCompleted: true }],
    ["Dept Swim first-aid", "/swim-track/first-aid", { checkDate: old, aedOk: true }],
    ["Dept Swim incident", "/swim-track/incidents", { incidentDate: old, description: "Lock fixture incident" }],
  ]) {
    await departmentDelete({ label, createPath: collection, body: withSite(fields), adminDelete: [200] });
  }
  if ([200, 201].includes(alphaSite.status) && [200, 201].includes(betaSite.status)) {
    // PAT evidence is never deleted (405 for everyone), but staff in another
    // department must still get the boundary response rather than the lock.
    const roomFor = async (siteId) => (await admin("POST", "/pat-track/rooms", { siteId, name: `Dept lock room ${siteId} ${suffix}` })).data?.id;
    const roomIds = { [alphaSite.data.id]: await roomFor(alphaSite.data.id), [betaSite.data.id]: await roomFor(betaSite.data.id) };
    const certificateIds = {};
    await departmentDelete({
      label: "Dept PAT certificate", createPath: "/pat-track/certificates", adminDelete: [405],
      body: (siteId) => ({ siteId, visitDate: old, certificateRef: `DEPT-LOCK-${siteId}`, roomIds: [roomIds[siteId]] }),
    });
    for (const siteId of [alphaSite.data.id, betaSite.data.id]) {
      certificateIds[siteId] = (await admin("POST", "/pat-track/certificates", {
        siteId, visitDate: old, certificateRef: `DEPT-LOCK-FAIL-${siteId}`, roomIds: [roomIds[siteId]],
      })).data?.id;
    }
    await departmentDelete({
      label: "Dept PAT replacement", createPath: "/pat-track/replacements", adminDelete: [405],
      body: (siteId) => ({ roomId: roomIds[siteId], applianceName: "Lock kettle", replacedOn: old }),
    });
    await departmentDelete({
      label: "Dept PAT failure", createPath: "/pat-track/failures", adminDelete: [405],
      body: (siteId) => ({ certificateId: certificateIds[siteId], roomId: roomIds[siteId], applianceName: "Lock toaster" }),
      prepare: (id) => backdateCreatedAt("pat_failures", id, 3),
    });
  }

  // Another department's record id must answer exactly like an id that does
  // not exist, so department-scoped staff cannot probe for records. Nothing
  // foreign changes, and client admins still reach every record.
  if ([200, 201].includes(alphaSite.status) && [200, 201].includes(betaSite.status)) {
    const missingId = 2_000_000_000;
    const sameAsMissing = async (label, method, path, body, readBack) => {
      const foreign = await scopedStaff(method, path(readBack.id), body);
      const missing = await scopedStaff(method, path(missingId), body);
      check(`${label}: other-department id is refused`, [403, 404].includes(foreign.status),
        `${foreign.status} ${JSON.stringify(foreign.data)}`);
      check(`${label}: other-department id answers like a missing id`,
        foreign.status === missing.status && JSON.stringify(foreign.data) === JSON.stringify(missing.data),
        `foreign ${foreign.status} ${JSON.stringify(foreign.data)} / missing ${missing.status} ${JSON.stringify(missing.data)}`);
      const stored = await readBack.read();
      check(`${label}: other-department record unchanged`,
        Boolean(stored) && !JSON.stringify(stored).includes(bypassMarker), JSON.stringify(stored));
    };

    const betaTrain = await admin("POST", "/train-track/records", {
      recordType: "internal", staffName: "Lock Fixture", trainingType: "Safety", trainer: "Admin",
      completedDate: today, siteId: betaSite.data.id,
    });
    expect("Foreign TrainTrack: seed current record", betaTrain, [201]);
    if (betaTrain.status === 201) {
      const readTrain = async () => (await admin("GET", "/train-track/records")).data?.find?.((row) => row.id === betaTrain.data.id);
      const trainPath = (id) => `/train-track/records/${id}`;
      await sameAsMissing("Foreign TrainTrack PATCH", "PATCH", trainPath, { notes: bypassMarker },
        { id: betaTrain.data.id, read: readTrain });
      await sameAsMissing("Foreign TrainTrack DELETE", "DELETE", trainPath, undefined,
        { id: betaTrain.data.id, read: readTrain });
      expect("Foreign TrainTrack: admin PATCH still works",
        await admin("PATCH", trainPath(betaTrain.data.id), { notes: "admin edit" }), [200]);
    }

    const betaAction = await admin("POST", "/track-actions", {
      module: "fire", title: `Foreign action ${suffix}`, severity: "monitor", siteId: betaSite.data.id,
    });
    expect("Foreign TrackAction: seed action", betaAction, [201]);
    if (betaAction.status === 201) {
      const readAction = async () => (await admin("GET", "/track-actions?module=fire")).data?.find?.((row) => row.id === betaAction.data.id);
      await sameAsMissing("Foreign TrackAction PATCH", "PATCH", (id) => `/track-actions/${id}`,
        { ownerName: bypassMarker }, { id: betaAction.data.id, read: readAction });
      await sameAsMissing("Foreign TrackAction FixTrack decision", "POST", (id) => `/track-actions/${id}/fix-track`,
        { create: false }, { id: betaAction.data.id, read: readAction });
      const afterDecision = await readAction();
      check("Foreign TrackAction: FixTrack decision not recorded",
        (afterDecision?.fixTrackDisposition ?? afterDecision?.fix_track_disposition) !== "not_needed",
        JSON.stringify(afterDecision));
      expect("Foreign TrackAction: admin PATCH still works",
        await admin("PATCH", `/track-actions/${betaAction.data.id}`, { ownerName: "Admin owner" }), [200]);
    }

    // DocTrack uploads need object storage, so the document row is seeded
    // directly; every request below still goes through the API.
    const betaDocId = Number(sqlRun(`INSERT INTO doc_track_documents (client_id, site_id, title, category)
      VALUES (${Number(clientId)}, ${Number(betaSite.data.id)}, 'Foreign lock document', 'policy') RETURNING id`).split("\n")[0]);
    check("Foreign DocTrack: seed document", Number.isInteger(betaDocId) && betaDocId > 0);
    if (Number.isInteger(betaDocId) && betaDocId > 0) {
      const readDoc = async () => (await admin("GET", "/doc-track/documents")).data?.find?.((row) => row.id === betaDocId);
      const docPath = (id) => `/doc-track/documents/${id}`;
      await sameAsMissing("Foreign DocTrack PATCH", "PATCH", docPath, { description: bypassMarker },
        { id: betaDocId, read: readDoc });
      await sameAsMissing("Foreign DocTrack DELETE", "DELETE", docPath, undefined, { id: betaDocId, read: readDoc });
      expect("Foreign DocTrack: admin PATCH still works",
        await admin("PATCH", docPath(betaDocId), { description: "admin edit" }), [200]);
    }
  }

  // A different tenant must not be able to reach a mapped record. Use a real
  // foreign staff session so this also exercises the staff lock path's
  // client-scoped lookup rather than relying only on an admin 404.
  if (Number.isInteger(tenantProbeId)) {
    const foreignAdmin = session();
    const foreignEmail = `stored-lock-foreign-admin-${suffix}@test.local`;
    const foreignRegistered = await foreignAdmin("POST", "/auth/register", {
      name: "Stored Date Lock Foreign Admin", email: foreignEmail, password: "password-123",
    });
    expect("register foreign tenant admin", foreignRegistered, [200, 201]);
    const foreignToken = foreignRegistered.data?.verificationToken;
    if (foreignToken) expect("verify foreign tenant admin",
      await foreignAdmin("GET", `/auth/verify-email?token=${encodeURIComponent(foreignToken)}`), [200]);
    expect("login foreign tenant admin",
      await foreignAdmin("POST", "/auth/login", { email: foreignEmail, password: "password-123" }), [200]);
    const foreignMe = await foreignAdmin("GET", "/auth/me");
    const foreignClientId = foreignMe.data?.user?.clientId ?? foreignMe.data?.clientId;
    const foreignStaffEmail = `stored-lock-foreign-staff-${suffix}@test.local`;
    expect("create foreign tenant staff", await foreignAdmin("POST", "/users", {
      name: "Stored Date Lock Foreign Staff", email: foreignStaffEmail,
      password: "password-123", role: "client_staff", clientId: foreignClientId,
    }), [200, 201]);
    const foreignStaff = session();
    expect("login foreign tenant staff",
      await foreignStaff("POST", "/auth/login", { email: foreignStaffEmail, password: "password-123" }), [200]);
    const foreignAttempt = await foreignStaff("PUT", `/pat-track/tests/${tenantProbeId}`, {
      applianceId: 1, testDate: today, result: "pass",
    });
    // Staff get one answer for any record they cannot reach (403 on
    // department-scoped tracks), so another tenant's id looks like a missing one.
    const missingAttempt = await foreignStaff("PUT", "/pat-track/tests/2000000000", {
      applianceId: 1, testDate: today, result: "pass",
    });
    check("foreign tenant cannot mutate mapped record",
      [403, 404].includes(foreignAttempt.status), `${foreignAttempt.status} ${JSON.stringify(foreignAttempt.data)}`);
    check("foreign tenant id answers like a missing id",
      foreignAttempt.status === missingAttempt.status
        && JSON.stringify(foreignAttempt.data) === JSON.stringify(missingAttempt.data),
      `${foreignAttempt.status} ${JSON.stringify(foreignAttempt.data)} / ${missingAttempt.status} ${JSON.stringify(missingAttempt.data)}`);
  }

  console.log(`stored-track-lock: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  }
}
main().catch((error) => { console.error("stored-track-lock crashed:", error); process.exitCode = 1; });