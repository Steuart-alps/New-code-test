// Integration coverage for the date lock's authoritative, server-side lookup.
// This deliberately uses separate admin and staff cookies: a request body must
// not be able to make an old stored record look current.
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

  // Food-safety also supplies the metadata/config regression assertion.
  const configBefore = await admin("GET", "/food-safety/config");
  expect("read food config before", configBefore, [200]);
  const old = iso(-3), yesterday = iso(-1), today = iso(0);
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
    check("foreign tenant cannot mutate mapped record",
      foreignAttempt.status === 404, `${foreignAttempt.status} ${JSON.stringify(foreignAttempt.data)}`);
  }

  console.log(`stored-track-lock: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  }
}
main().catch((error) => { console.error("stored-track-lock crashed:", error); process.exitCode = 1; });