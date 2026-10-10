// Focused Task 84 attribution integration coverage (FireTrack and SwimTrack).
const BASE = process.env.API_BASE || "http://localhost:8080/api";
let passed = 0; const failures = [];
const check = (name, ok, detail = "") => ok ? passed++ : failures.push(`${name}: ${detail}`);
const session = () => {
  let cookie = "";
  return async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get("set-cookie"); if (c) cookie = c.split(";")[0];
    return { status: r.status, data: r.headers.get("content-type")?.includes("json") ? await r.json().catch(() => null) : null };
  };
};
async function account(label) {
  const s = session(), email = `staff-attribution-${label}-${Date.now()}-${Math.random()}@test.local`;
  const reg = await s("POST", "/auth/register", { name: `Attribution ${label}`, email, password: "password-123" });
  const token = reg.data?.verificationToken;
  await s("GET", `/auth/verify-email?token=${encodeURIComponent(token || "")}`);
  await s("POST", "/auth/login", { email, password: "password-123" });
  return s;
}
const main = async () => {
  const a = await account("a"), b = await account("b");
  const roster = await a("POST", "/staff-roster", { name: "Server Snapshot", active: true });
  const other = await b("POST", "/staff-roster", { name: "Other Tenant", active: true });
  const inactive = await a("POST", "/staff-roster", { name: "Inactive Worker", active: false });
  // These records are edited after creation, so date them inside the 24-hour
  // correction window instead of a fixed day that later ages into a locked one.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const base = { checkType: "alarm", checkDate: today, result: "pass", performedBy: "client supplied" };
  const created = await a("POST", "/fire-safety", { ...base, staffRosterId: roster.data?.id });
  check("same-tenant create", created.status === 201, `got ${created.status}`);
  check("roster id persists", created.data?.staffRosterId === roster.data?.id, JSON.stringify(created.data));
  check("server snapshot wins", created.data?.performedBy === "Server Snapshot", JSON.stringify(created.data));
  const renamed = await a("PATCH", `/staff-roster/${roster.data?.id}`, { name: "Renamed Worker" });
  check("roster rename succeeds", renamed.status === 200, `got ${renamed.status}`);
  const unchanged = await a("PUT", `/fire-safety/${created.data?.id}`, { notes: "Unrelated edit" });
  check("unrelated edit preserves historical snapshot", unchanged.data?.performedBy === "Server Snapshot" && unchanged.data?.staffRosterId === roster.data?.id, JSON.stringify(unchanged.data));
  const deactivated = await a("PATCH", `/staff-roster/${roster.data?.id}`, { active: false });
  check("roster deactivation succeeds", deactivated.status === 200, `got ${deactivated.status}`);
  const afterDeactivate = await a("PUT", `/fire-safety/${created.data?.id}`, { result: "fail" });
  check("inactive historical assignment remains editable", afterDeactivate.status === 200 && afterDeactivate.data?.performedBy === "Server Snapshot", JSON.stringify(afterDeactivate.data));
  const replacement = await a("POST", "/staff-roster", { name: "Replacement Worker", active: true });
  const reassigned = await a("PUT", `/fire-safety/${created.data?.id}`, { staffRosterId: replacement.data?.id });
  check("active reassignment updates snapshot", reassigned.status === 200 && reassigned.data?.staffRosterId === replacement.data?.id && reassigned.data?.performedBy === "Replacement Worker", JSON.stringify(reassigned.data));
  const cross = await a("POST", "/fire-safety", { ...base, staffRosterId: other.data?.id });
  check("cross-tenant roster rejected", cross.status === 400, `got ${cross.status}`);
  const off = await a("POST", "/fire-safety", { ...base, staffRosterId: inactive.data?.id });
  check("inactive roster rejected", off.status === 400, `got ${off.status}`);

  // First-aid create/update coverage: the create route must not depend on a
  // path parameter, and updates must retain immutable historical snapshots.
  const swimRoster = await a("POST", "/staff-roster", { name: "Lifeguard Snapshot", active: true });
  const swimCreated = await a("POST", "/swim-track/first-aid", {
    checkDate: today,
    aedOk: false,
    checkedBy: "client supplied",
    checkedByRosterId: swimRoster.data?.id,
  });
  const swimId = swimCreated.data?.id;
  const swimRosterId = swimCreated.data?.checkedByRosterId ?? swimCreated.data?.checked_by_roster_id;
  const swimName = swimCreated.data?.checkedBy ?? swimCreated.data?.checked_by;
  check("first-aid create succeeds without path id", swimCreated.status === 201, `got ${swimCreated.status}`);
  check("first-aid create stores roster attribution", swimRosterId === swimRoster.data?.id && swimName === "Lifeguard Snapshot", JSON.stringify(swimCreated.data));

  const swimRenamed = await a("PATCH", `/staff-roster/${swimRoster.data?.id}`, { name: "Renamed Lifeguard" });
  check("first-aid roster rename succeeds", swimRenamed.status === 200, `got ${swimRenamed.status}`);
  const swimOmitted = await a("PUT", `/swim-track/first-aid/${swimId}`, { notes: "Unrelated edit" });
  check("first-aid omitted id preserves snapshot", swimOmitted.status === 200 &&
    (swimOmitted.data?.checkedByRosterId ?? swimOmitted.data?.checked_by_roster_id) === swimRoster.data?.id &&
    (swimOmitted.data?.checkedBy ?? swimOmitted.data?.checked_by) === "Lifeguard Snapshot", JSON.stringify(swimOmitted.data));
  check("first-aid partial update preserves omitted fields",
    (swimOmitted.data?.checkDate ?? swimOmitted.data?.check_date) === today &&
    (swimOmitted.data?.aedOk ?? swimOmitted.data?.aed_ok) === false &&
    swimOmitted.data?.result === "fail", JSON.stringify(swimOmitted.data));

  const swimInactive = await a("PATCH", `/staff-roster/${swimRoster.data?.id}`, { active: false });
  check("first-aid roster deactivation succeeds", swimInactive.status === 200, `got ${swimInactive.status}`);
  const swimSame = await a("PUT", `/swim-track/first-aid/${swimId}`, { checkedByRosterId: swimRoster.data?.id });
  check("first-aid same inactive id preserves snapshot", swimSame.status === 200 &&
    (swimSame.data?.checkedByRosterId ?? swimSame.data?.checked_by_roster_id) === swimRoster.data?.id &&
    (swimSame.data?.checkedBy ?? swimSame.data?.checked_by) === "Lifeguard Snapshot", JSON.stringify(swimSame.data));

  const swimReplacement = await a("POST", "/staff-roster", { name: "Replacement Lifeguard", active: true });
  const swimReassigned = await a("PUT", `/swim-track/first-aid/${swimId}`, { checkedByRosterId: swimReplacement.data?.id });
  check("first-aid active reassignment updates snapshot", swimReassigned.status === 200 &&
    (swimReassigned.data?.checkedByRosterId ?? swimReassigned.data?.checked_by_roster_id) === swimReplacement.data?.id &&
    (swimReassigned.data?.checkedBy ?? swimReassigned.data?.checked_by) === "Replacement Lifeguard", JSON.stringify(swimReassigned.data));
  const swimCleared = await a("PUT", `/swim-track/first-aid/${swimId}`, { checkedByRosterId: null });
  check("first-aid explicit null clears attribution", swimCleared.status === 200 &&
    (swimCleared.data?.checkedByRosterId ?? swimCleared.data?.checked_by_roster_id) == null &&
    (swimCleared.data?.checkedBy ?? swimCleared.data?.checked_by) == null, JSON.stringify(swimCleared.data));
  const swimCrossTenant = await a("POST", "/swim-track/first-aid", {
    checkDate: today,
    checkedByRosterId: other.data?.id,
  });
  check("first-aid cross-tenant roster rejected", swimCrossTenant.status === 400, `got ${swimCrossTenant.status}`);
  const swimOff = await a("POST", "/swim-track/first-aid", {
    checkDate: today,
    checkedByRosterId: inactive.data?.id,
  });
  check("first-aid inactive roster rejected", swimOff.status === 400, `got ${swimOff.status}`);

  // GreenTrack attribution coverage for every roster-backed workflow.
  const greenRoster = await a("POST", "/staff-roster", { name: "Green Snapshot", active: true });
  const greenReplacement = await a("POST", "/staff-roster", { name: "Green Replacement", active: true });
  const greenMachine = await a("POST", "/green-track/machines", { name: "Attribution Mower", type: "walk_behind" });
  const machineId = greenMachine.data?.id;
  const preUseBody = { machineId, checkDate: today, operator: "client supplied", operatorRosterId: greenRoster.data?.id };
  const preUse = await a("POST", "/green-track/pre-use-checks", preUseBody);
  check("GreenTrack pre-use create stores roster snapshot",
    preUse.status === 201 && (preUse.data?.operator_roster_id ?? preUse.data?.operatorRosterId) === greenRoster.data?.id &&
    (preUse.data?.operator ?? preUse.data?.operator_name) === "Green Snapshot", JSON.stringify(preUse.data));
  const preUseUpdated = await a("PUT", `/green-track/pre-use-checks/${preUse.data?.id}`, { notes: "Unrelated edit" });
  check("GreenTrack pre-use omitted attribution preserves snapshot",
    preUseUpdated.status === 200 && (preUseUpdated.data?.operator_roster_id ?? preUseUpdated.data?.operatorRosterId) === greenRoster.data?.id &&
    (preUseUpdated.data?.operator ?? preUseUpdated.data?.operator_name) === "Green Snapshot", JSON.stringify(preUseUpdated.data));
  const preUseReassigned = await a("PUT", `/green-track/pre-use-checks/${preUse.data?.id}`, { operatorRosterId: greenReplacement.data?.id });
  check("GreenTrack pre-use active reassignment updates snapshot",
    preUseReassigned.status === 200 && (preUseReassigned.data?.operator_roster_id ?? preUseReassigned.data?.operatorRosterId) === greenReplacement.data?.id &&
    (preUseReassigned.data?.operator ?? preUseReassigned.data?.operator_name) === "Green Replacement", JSON.stringify(preUseReassigned.data));
  const preUseCleared = await a("PUT", `/green-track/pre-use-checks/${preUse.data?.id}`, { operatorRosterId: null });
  check("GreenTrack pre-use explicit null clears attribution",
    preUseCleared.status === 200 && (preUseCleared.data?.operator_roster_id ?? preUseCleared.data?.operatorRosterId) == null &&
    (preUseCleared.data?.operator ?? preUseCleared.data?.operator_name) == null, JSON.stringify(preUseCleared.data));
  const preUseCross = await a("POST", "/green-track/pre-use-checks", { ...preUseBody, operatorRosterId: other.data?.id });
  check("GreenTrack pre-use cross-tenant roster rejected", preUseCross.status === 400, `got ${preUseCross.status}`);
  const preUseInactive = await a("POST", "/green-track/pre-use-checks", { ...preUseBody, operatorRosterId: inactive.data?.id });
  check("GreenTrack pre-use inactive roster rejected", preUseInactive.status === 400, `got ${preUseInactive.status}`);
  const attr = (row, idKey, nameKey) => ({
    id: row?.[idKey] ?? row?.[idKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)],
    name: row?.[nameKey] ?? row?.[nameKey.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)],
  });
  const greenCases = [
    ["service", "/green-track/service-records",
      { machineId, serviceDate: today, serviceType: "scheduled", servicedBy: "client supplied", servicedByRosterId: greenRoster.data?.id },
      "servicedByRosterId", "servicedBy"],
    ["defect", "/green-track/defects",
      { machineId, reportDate: today, description: "Loose guard", reportedBy: "client supplied", reportedByRosterId: greenRoster.data?.id },
      "reportedByRosterId", "reportedBy"],
    ["PUWER", "/green-track/puwer-inspections",
      { machineId, inspectionDate: today, inspectorName: "client supplied", inspectorRosterId: greenRoster.data?.id },
      "inspectorRosterId", "inspectorName"],
    ["fuel", "/green-track/fuel-logs",
      { machineId, logDate: today, fuelType: "diesel", filledBy: "client supplied", filledByRosterId: greenRoster.data?.id },
      "filledByRosterId", "filledBy"],
  ];
  for (const [label, path, body, idKey, nameKey] of greenCases) {
    const made = await a("POST", path, body);
    const got = attr(made.data, idKey, nameKey);
    check(`GreenTrack ${label} create succeeds`, made.status === 201, `got ${made.status}: ${JSON.stringify(made.data)}`);
    check(`GreenTrack ${label} stores roster snapshot`,
      got.id === greenRoster.data?.id && got.name === "Green Snapshot", JSON.stringify(made.data));
    const updated = await a("PUT", `${path}/${made.data?.id}`, label === "defect" ? { notes: "Unrelated edit" } : { notes: "Unrelated edit" });
    const after = attr(updated.data, idKey, nameKey);
    check(`GreenTrack ${label} omitted attribution preserves snapshot`,
      updated.status === 200 && after.id === greenRoster.data?.id && after.name === "Green Snapshot", JSON.stringify(updated.data));
    const reassigned = await a("PUT", `${path}/${made.data?.id}`, { [idKey]: greenReplacement.data?.id });
    const reassignedAttribution = attr(reassigned.data, idKey, nameKey);
    check(`GreenTrack ${label} active reassignment updates snapshot`,
      reassigned.status === 200 && reassignedAttribution.id === greenReplacement.data?.id &&
      reassignedAttribution.name === "Green Replacement", JSON.stringify(reassigned.data));
    const cleared = await a("PUT", `${path}/${made.data?.id}`, { [idKey]: null });
    const clearedAttribution = attr(cleared.data, idKey, nameKey);
    check(`GreenTrack ${label} explicit null clears attribution`,
      cleared.status === 200 && clearedAttribution.id == null && clearedAttribution.name == null, JSON.stringify(cleared.data));
    const cross = await a("POST", path, { ...body, [idKey]: other.data?.id });
    check(`GreenTrack ${label} cross-tenant roster rejected`, cross.status === 400, `got ${cross.status}`);
    const off = await a("POST", path, { ...body, [idKey]: inactive.data?.id });
    check(`GreenTrack ${label} inactive roster rejected`, off.status === 400, `got ${off.status}`);
  }

  // Regression coverage for the create-only/custom-name path.  Both omitted
  // and explicit null roster ids must retain the supplied legacy name with a
  // null foreign key (rather than silently dropping the name).
  const customCreate = async (label, path, bodies, idKey, nameKey) => {
    for (const [suffix, body] of bodies) {
      const made = await a("POST", path, body);
      const got = attr(made.data, idKey, nameKey);
      check(`${label} ${suffix} custom create succeeds`, made.status === 201,
        `got ${made.status}: ${JSON.stringify(made.data)}`);
      check(`${label} ${suffix} custom name/null roster persists`,
        got.id == null && got.name === body[nameKey], JSON.stringify(made.data));
    }
  };
  await customCreate("Daily AM", "/daily-track-am", [
    ["omitted roster", { checklistType: "kitchen_opening", checkDate: today, completedBy: "AM Custom Omitted", items: [] }],
    ["null roster", { checklistType: "premises_opening", checkDate: today, completedBy: "AM Custom Null", staffRosterId: null, items: [] }],
  ], "staffRosterId", "completedBy");
  await customCreate("Daily PM", "/daily-track-pm", [
    ["omitted roster", { checklistType: "kitchen_closing", checkDate: today, completedBy: "PM Custom Omitted", items: [] }],
    ["null roster", { checklistType: "premises_closing", checkDate: today, completedBy: "PM Custom Null", staffRosterId: null, items: [] }],
  ], "staffRosterId", "completedBy");
  await customCreate("Kitchen probe", "/kitchen-weekly/probe", [
    ["omitted roster", { checkDate: today, checkedBy: "Probe Custom Omitted", probes: [] }],
    ["null roster", { checkDate: yesterday, checkedBy: "Probe Custom Null", checkedByRosterId: null, probes: [] }],
  ], "checkedByRosterId", "checkedBy");
  const room = await a("POST", "/room-track/rooms", { roomNumber: `ATTR-${Date.now()}` });
  check("room fixture creates", room.status === 201, `got ${room.status}: ${JSON.stringify(room.data)}`);
  await customCreate("Room check", "/room-track/checks", [
    ["omitted roster", { roomId: room.data?.id, checkDate: today, checkedBy: "Room Custom Omitted" }],
    ["null roster", { roomId: room.data?.id, checkDate: yesterday, checkedBy: "Room Custom Null", checkedByRosterId: null }],
  ], "checkedByRosterId", "checkedBy");
  await customCreate("Pest visit", "/pest-track/visits", [
    ["omitted roster", { visitDate: today, signedOffBy: "Visit Custom Omitted" }],
    ["null roster", { visitDate: today, signedOffBy: "Visit Custom Null", signedOffByRosterId: null }],
  ], "signedOffByRosterId", "signedOffBy");
  await customCreate("Pest activity", "/pest-track/activity", [
    ["omitted roster", { recordedDate: today, recordedBy: "Activity Custom Omitted" }],
    ["null roster", { recordedDate: today, recordedBy: "Activity Custom Null", recordedByRosterId: null }],
  ], "recordedByRosterId", "recordedBy");
  await customCreate("Fire safety", "/fire-safety", [
    ["omitted roster", { ...base, performedBy: "Fire Custom Omitted" }],
    ["null roster", { ...base, performedBy: "Fire Custom Null", staffRosterId: null }],
  ], "staffRosterId", "performedBy");

  console.log(`staff attribution: ${passed} passed${failures.length ? `, ${failures.length} failed` : ""}`);
  if (failures.length) { for (const f of failures) console.error(`FAIL: ${f}`); process.exitCode = 1; }
};
main().catch((e) => { console.error(e); process.exitCode = 1; });