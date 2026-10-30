// GreenTrack machine services done in house or by a contractor: an in-house
// service needs who did it, every checklist line answered (a problem needs a
// note) and whether the machine is safe to use; each problem becomes an open
// defect linked to the service, and "not safe" takes the machine out of
// service; a contractor's service names a contractor of the same business;
// older free-form services still save; tenant isolation. Runs only through
// tests/run-fresh-schema.sh (disposable database).
const BASE = process.env.API_BASE;
if (process.env.FRESH_SCHEMA_TEST !== "1" || !BASE) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/green-service-in-house.mjs (disposable database only)");
}
let passed = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) passed++;
  else { failures.push(`${name}: ${detail}`); console.error(`FAIL: ${name}: ${detail}`); }
}
const expectStatus = (name, response, expected) => check(name, expected.includes(response.status), `expected ${expected.join("/")}, got ${response.status} ${JSON.stringify(response.data)}`);
function session(defaultHeaders = {}) {
  let cookie = "";
  const request = async (method, path, body) => {
    const response = await fetch(`${BASE}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...defaultHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const data = (response.headers.get("content-type") || "").includes("application/json") ? await response.json().catch(() => null) : null;
    return { status: response.status, data };
  };
  return request;
}

async function registerTenant(label, stamp) {
  // Historic test dates need an override reason.
  const user = session({ "X-Override-Reason": encodeURIComponent("Service fixture: historic services") });
  const email = `green-service-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `Service ${label}`, email, password: "password-123" });
  expectStatus(`register ${label}`, registered, [200, 201]);
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  expectStatus(`verify ${label}`, await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
  expectStatus(`login ${label}`, await user("POST", "/auth/login", { email, password: "password-123" }), [200]);
  return user;
}

const day = (value) => (typeof value === "string" ? value.slice(0, 10) : value);

function iso(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const CHECKLIST_KEYS = [
  "engine_oil", "air_filter", "fuel_system", "plugs", "coolant", "hydraulics", "greasing", "belts_chains",
  "tyres", "cutting_units", "battery_electrics", "brakes", "safety_devices", "guards", "test_run",
];
const allDone = () => CHECKLIST_KEYS.map((key) => ({ key, result: "done" }));

async function main() {
  const stamp = Date.now();
  const owner = await registerTenant("owner", stamp);
  const other = await registerTenant("other", stamp);

  const mower = await owner("POST", "/green-track/machines", { name: "Greens mower 2", type: "greens_mower_ride_on" });
  expectStatus("create mower", mower, [201]);
  const tractor = await owner("POST", "/green-track/machines", { name: "Compact tractor", type: "tractor" });
  expectStatus("create tractor", tractor, [201]);
  const mowerId = mower.data.id, tractorId = tractor.data.id;
  const base = { machineId: mowerId, serviceDate: iso(-1), serviceType: "scheduled" };

  // ── In-house rules ─────────────────────────────────────────────────────────
  expectStatus("in house needs who did it", await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "in_house", checklist: allDone(), safeToUse: true,
  }), [400]);
  expectStatus("in house needs every line answered", await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "in_house", servicedBy: "Alex Mechanic", checklist: allDone().slice(1), safeToUse: true,
  }), [400]);
  const noNote = allDone().map((line) => line.key === "brakes" ? { ...line, result: "problem" } : line);
  expectStatus("a problem needs a note", await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "in_house", servicedBy: "Alex Mechanic", checklist: noNote, safeToUse: true,
  }), [400]);
  expectStatus("in house needs safe to use", await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "in_house", servicedBy: "Alex Mechanic", checklist: allDone(),
  }), [400]);
  expectStatus("doneBy must be known", await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "someone", servicedBy: "Alex Mechanic",
  }), [400]);
  let defects = await owner("GET", "/green-track/defects");
  check("refused services raise no defects", Array.isArray(defects.data) && defects.data.length === 0, JSON.stringify(defects.data));

  // ── A clean in-house service ───────────────────────────────────────────────
  const clean = await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "in_house", servicedBy: "Alex Mechanic", nextServiceDate: iso(180),
    checklist: allDone().map((line) => line.key === "coolant" ? { ...line, result: "na" } : line), safeToUse: true,
  });
  expectStatus("clean in-house service", clean, [201]);
  check("clean service raises nothing", clean.data?.defects_raised === 0, JSON.stringify(clean.data));

  // ── Problems found, machine not safe ───────────────────────────────────────
  const problems = allDone().map((line) => {
    if (line.key === "brakes") return { ...line, result: "problem", note: "Parking brake does not hold on a slope" };
    if (line.key === "guards") return { ...line, result: "problem", note: "Belt guard cracked" };
    return line;
  });
  const unsafe = await owner("POST", "/green-track/service-records", {
    machineId: tractorId, serviceDate: iso(0), doneBy: "in_house", servicedBy: "Alex Mechanic", checklist: problems, safeToUse: false,
  });
  expectStatus("in-house service with problems", unsafe, [201]);
  check("two defects raised", unsafe.data?.defects_raised === 2, JSON.stringify(unsafe.data));
  defects = await owner("GET", "/green-track/defects");
  const raised = (defects.data ?? []).filter((d) => d.serviceRecordId === unsafe.data?.id);
  check("defects linked to the service", raised.length === 2, JSON.stringify(defects.data));
  check("defects are open, critical and out of service",
    raised.every((d) => d.status === "open" && d.severity === "critical" && d.outOfService === true && d.machineId === tractorId),
    JSON.stringify(raised));
  check("defect says what was found", raised.some((d) => /Brakes and parking brake tested\. Parking brake does not hold/.test(d.description)), JSON.stringify(raised));
  const status = await owner("GET", "/green-track/status");
  check("tractor counted out of service", status.data?.outOfService === 1, JSON.stringify(status.data));

  const unsafeNoProblem = await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "in_house", servicedBy: "Alex Mechanic", checklist: allDone(), safeToUse: false, notes: "Steering feels loose",
  });
  check("not safe without a listed problem still raises one defect", unsafeNoProblem.data?.defects_raised === 1, JSON.stringify(unsafeNoProblem.data));

  const list = await owner("GET", `/green-track/service-records?machineId=${tractorId}`);
  const listed = list.data?.find?.((s) => s.id === unsafe.data?.id);
  check("list shows who did it and the checklist", listed?.doneBy === "in_house" && listed?.safeToUse === false
    && Array.isArray(listed?.checklist) && listed.checklist.length === CHECKLIST_KEYS.length && listed?.defectsRaised === 2, JSON.stringify(listed));

  // Editing keeps the checklist and raises nothing more.
  expectStatus("edit an in-house service", await owner("PUT", `/green-track/service-records/${unsafe.data.id}`, { notes: "Parts ordered" }), [200]);
  defects = await owner("GET", "/green-track/defects");
  check("an edit raises no new defects", (defects.data ?? []).filter((d) => d.serviceRecordId === unsafe.data.id).length === 2, JSON.stringify(defects.data));

  // ── Contractor services ────────────────────────────────────────────────────
  const dealer = await owner("POST", "/contractors", { name: "Turf Machinery Ltd", email: `dealer-${stamp}@test.local`, trades: ["grounds_machinery"] });
  expectStatus("add a grounds machinery contractor", dealer, [201]);
  const byDealer = await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "contractor", contractorId: dealer.data?.id, servicedBy: "Engineer Sam",
  });
  expectStatus("contractor service", byDealer, [201]);
  const dealerRow = (await owner("GET", `/green-track/service-records?machineId=${mowerId}`)).data?.find?.((s) => s.id === byDealer.data?.id);
  check("list names the contractor", dealerRow?.contractorName === "Turf Machinery Ltd" && dealerRow?.servicedBy === "Engineer Sam", JSON.stringify(dealerRow));

  const otherDealer = await other("POST", "/contractors", { name: "Elsewhere Mowers", email: `elsewhere-${stamp}@test.local`, trades: [] });
  expectStatus("other business contractor", otherDealer, [201]);
  expectStatus("cannot name another business's contractor", await owner("POST", "/green-track/service-records", {
    ...base, doneBy: "contractor", contractorId: otherDealer.data?.id,
  }), [404]);

  // ── Older free-form services still save ────────────────────────────────────
  expectStatus("service without doneBy", await owner("POST", "/green-track/service-records", { ...base, servicedBy: "Someone" }), [201]);

  // ── Tenant isolation ───────────────────────────────────────────────────────
  expectStatus("other business cannot service this machine", await other("POST", "/green-track/service-records", {
    ...base, doneBy: "in_house", servicedBy: "Intruder", checklist: allDone(), safeToUse: false,
  }), [404]);
  const otherDefects = await other("GET", "/green-track/defects");
  check("other business sees no defects", Array.isArray(otherDefects.data) && otherDefects.data.length === 0, JSON.stringify(otherDefects.data));

  console.log(`green in-house service tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
