// GreenTrack hour meter readings: standalone readings and readings taken from
// pre-use checks, fuel logs and services; each machine's current hours and
// hours used; a service due by hours on GreenTrack's status, the dashboard and
// the QR scan page; the "lower than an earlier reading" guard; tenant
// isolation. Runs only through tests/run-fresh-schema.sh (disposable database).
const BASE = process.env.API_BASE;
if (process.env.FRESH_SCHEMA_TEST !== "1" || !BASE) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/green-hours.mjs (disposable database only)");
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
  const user = session({ "X-Override-Reason": encodeURIComponent("Hours fixture: historic readings") });
  const email = `green-hours-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `Hours ${label}`, email, password: "password-123" });
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

async function main() {
  const stamp = Date.now();
  const owner = await registerTenant("owner", stamp);
  const other = await registerTenant("other", stamp);

  const mower = await owner("POST", "/green-track/machines", { name: "Fairway mower", type: "fairway_mower" });
  expectStatus("create mower", mower, [201]);
  const tractor = await owner("POST", "/green-track/machines", { name: "Compact tractor", type: "tractor" });
  expectStatus("create tractor", tractor, [201]);
  const mowerId = mower.data.id, tractorId = tractor.data.id;

  // ── Readings from every source ─────────────────────────────────────────────
  expectStatus("service with hours", await owner("POST", "/green-track/service-records", {
    machineId: mowerId, serviceDate: iso(-40), serviceType: "routine", hoursAtService: 400, nextServiceHours: 650,
  }), [201]);
  expectStatus("standalone reading", await owner("POST", "/green-track/hour-readings", {
    machineId: mowerId, readingDate: iso(-10), hours: 600,
  }), [201]);
  const fuel = await owner("POST", "/green-track/fuel-logs", { machineId: mowerId, logDate: iso(-3), fuelType: "diesel", engineHours: 620 });
  expectStatus("fuel log with engine hours", fuel, [201]);
  const preUse = await owner("POST", "/green-track/pre-use-checks", {
    machineId: mowerId, checkDate: iso(0), fluidLevelsOk: true, hourMeter: "640.46",
  });
  expectStatus("pre-use check with hour meter", preUse, [201]);
  check("pre-use hour meter stored to a tenth", Number(preUse.data?.hour_meter) === 640.5, JSON.stringify(preUse.data?.hour_meter));
  expectStatus("pre-use hour meter must be a number",
    await owner("POST", "/green-track/pre-use-checks", { machineId: mowerId, checkDate: iso(0), hourMeter: "lots" }), [400]);

  let hours = await owner("GET", "/green-track/hours");
  expectStatus("hours summary", hours, [200]);
  let mowerHours = hours.data?.machines?.find((m) => m.machineId === mowerId);
  check("current hours follow the latest reading", mowerHours?.currentHours === 640.5 && mowerHours?.lastReadingDate === iso(0), JSON.stringify(mowerHours));
  check("hours used in the last 7 days", mowerHours?.hoursLast7Days === 40.5, JSON.stringify(mowerHours));
  check("hours used in the last 30 days", mowerHours?.hoursLast30Days === 240.5, JSON.stringify(mowerHours));
  check("service due soon by hours", mowerHours?.serviceHoursState === "due_soon" && mowerHours?.hoursToService === 9.5, JSON.stringify(mowerHours));
  const tractorHours = hours.data?.machines?.find((m) => m.machineId === tractorId);
  check("machine without readings has no hours", tractorHours?.currentHours === null && tractorHours?.serviceHoursState === "none", JSON.stringify(tractorHours));

  const readings = await owner("GET", `/green-track/hour-readings?machineId=${mowerId}`);
  expectStatus("list readings", readings, [200]);
  check("readings list every source, newest first",
    JSON.stringify(readings.data?.map((r) => r.source)) === JSON.stringify(["pre_use_check", "fuel_log", "reading", "service"]), JSON.stringify(readings.data));
  check("only standalone readings carry an id", readings.data?.filter((r) => r.id != null).length === 1, JSON.stringify(readings.data));

  // ── Meters only go up ──────────────────────────────────────────────────────
  const lower = await owner("POST", "/green-track/hour-readings", { machineId: mowerId, readingDate: iso(0), hours: 12 });
  check("a lower reading is queried", lower.status === 409 && lower.data?.code === "HOURS_LOWER_THAN_EARLIER", `${lower.status} ${JSON.stringify(lower.data)}`);
  expectStatus("hours must be a number", await owner("POST", "/green-track/hour-readings", { machineId: mowerId, readingDate: iso(0), hours: -1 }), [400]);

  // ── Reaching the service hours ─────────────────────────────────────────────
  const reached = await owner("POST", "/green-track/hour-readings", { machineId: mowerId, readingDate: iso(0), hours: 655 });
  expectStatus("reading past the service hours", reached, [201]);
  hours = await owner("GET", "/green-track/hours");
  mowerHours = hours.data?.machines?.find((m) => m.machineId === mowerId);
  check("service overdue by hours", mowerHours?.serviceHoursState === "overdue" && mowerHours?.hoursToService === -5, JSON.stringify(mowerHours));
  const status = await owner("GET", "/green-track/status");
  check("status counts the service overdue by hours", status.data?.overdueService === 1 && status.data?.overdueServiceByHours === 1, JSON.stringify(status.data));
  const card = (await owner("GET", "/dashboard/summary")).data?.tracks?.find((t) => t.trackId === "green");
  check("dashboard shows GreenTrack overdue", card?.status === "overdue" && /service overdue/.test(card?.badge ?? ""), JSON.stringify(card));
  check("dashboard names the hours", card?.items?.some((i) => i.label === "Fairway mower" && /655 hours, due at 650/.test(i.detail)), JSON.stringify(card?.items));

  // Correcting the reading below the service hours clears it.
  const edited = await owner("PUT", `/green-track/hour-readings/${reached.data.id}`, { hours: 645 });
  expectStatus("correct a reading", edited, [200]);
  hours = await owner("GET", "/green-track/hours");
  mowerHours = hours.data?.machines?.find((m) => m.machineId === mowerId);
  check("corrected reading is used", mowerHours?.currentHours === 645 && mowerHours?.serviceHoursState === "due_soon", JSON.stringify(mowerHours));

  // A replaced meter starts again once confirmed.
  const replaced = await owner("POST", "/green-track/hour-readings", { machineId: tractorId, readingDate: iso(-2), hours: 900 });
  expectStatus("tractor reading", replaced, [201]);
  const reset = await owner("POST", "/green-track/hour-readings", { machineId: tractorId, readingDate: iso(0), hours: 3, meterReplaced: true });
  expectStatus("confirmed meter replacement", reset, [201]);
  const afterReset = await owner("POST", "/green-track/hour-readings", { machineId: tractorId, readingDate: iso(0), hours: 4 });
  expectStatus("readings after a replacement compare with the new meter", afterReset, [201]);
  hours = await owner("GET", "/green-track/hours");
  check("tractor follows the new meter", hours.data?.machines?.find((m) => m.machineId === tractorId)?.currentHours === 4, JSON.stringify(hours.data?.machines));

  // ── QR scan page ───────────────────────────────────────────────────────────
  expectStatus("print a label for the mower",
    await owner("POST", "/equipment-labels/sheet", { items: [{ kind: "green_machine", ref: String(mowerId) }] }), [200, 201]);
  const labels = await owner("GET", "/equipment-labels");
  const mowerLabel = labels.data?.find?.((l) => l.kind === "green_machine" && l.name === "Fairway mower");
  check("mower label listed", Boolean(mowerLabel?.code), JSON.stringify(labels.data)?.slice(0, 400));
  if (mowerLabel?.code) {
    const scan = await owner("GET", `/equipment-labels/scan/${mowerLabel.code}`);
    const meter = scan.data?.statuses?.find?.((s) => s.label === "Hour meter");
    check("scan shows the hour meter", meter && /645 hours/.test(meter.text) && meter.state === "due_soon", JSON.stringify(scan.data?.statuses));
    check("scan offers to log hours", scan.data?.actions?.some?.((a) => a.href === `/green-track?machine=${mowerId}&open=hours`), JSON.stringify(scan.data?.actions));
  }

  // ── Tenant isolation ───────────────────────────────────────────────────────
  expectStatus("other business cannot log hours on this machine",
    await other("POST", "/green-track/hour-readings", { machineId: mowerId, readingDate: iso(0), hours: 999 }), [404]);
  expectStatus("other business cannot edit this reading",
    await other("PUT", `/green-track/hour-readings/${reached.data.id}`, { hours: 1 }), [404]);
  const otherReadings = await other("GET", `/green-track/hour-readings?machineId=${mowerId}`);
  check("other business sees no readings", Array.isArray(otherReadings.data) && otherReadings.data.length === 0, JSON.stringify(otherReadings.data));
  const otherHours = await other("GET", "/green-track/hours");
  check("other business sees no machines", Array.isArray(otherHours.data?.machines) && otherHours.data.machines.length === 0, JSON.stringify(otherHours.data));
  await other("DELETE", `/green-track/hour-readings/${reached.data.id}`);
  const still = await owner("GET", `/green-track/hour-readings?machineId=${mowerId}`);
  check("other business cannot delete this reading", still.data?.some((r) => r.id === reached.data.id), JSON.stringify(still.data));

  console.log(`green hour meter tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
