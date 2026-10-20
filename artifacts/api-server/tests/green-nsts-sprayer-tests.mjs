// GreenTrack NSTS sprayer tests: a sprayer's type and purchase date on the
// machine, the NSTS test record with its next date worked out, the per-sprayer
// status (including never-tested sprayers past their first-test deadline) and
// the certificate download route. Runs only through tests/run-fresh-schema.sh,
// which gives it a disposable database and API.
const BASE = process.env.API_BASE;
if (process.env.FRESH_SCHEMA_TEST !== "1" || !BASE) {
  throw new Error("Run via tests/run-fresh-schema.sh tests/green-nsts-sprayer-tests.mjs (disposable database only)");
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
  const user = session({ "X-Override-Reason": encodeURIComponent("NSTS fixture: historic sprayer tests") });
  const email = `green-nsts-${label}-${stamp}@test.local`;
  const registered = await user("POST", "/auth/register", { name: `NSTS ${label}`, email, password: "password-123" });
  expectStatus(`register ${label}`, registered, [200, 201]);
  if (typeof registered.data?.verificationToken !== "string") throw new Error("Verification token unavailable; run via the test runner");
  expectStatus(`verify ${label}`, await user("GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`), [200]);
  expectStatus(`login ${label}`, await user("POST", "/auth/login", { email, password: "password-123" }), [200]);
  return user;
}

const day = (value) => (typeof value === "string" ? value.slice(0, 10) : value);

async function main() {
  const stamp = Date.now();
  const owner = await registerTenant("owner", stamp);
  const other = await registerTenant("other", stamp);

  // ── Machines keep a sprayer type and purchase date ─────────────────────────
  const bad = await owner("POST", "/green-track/machines", { name: "Bad sprayer", type: "sprayer_spreader", sprayerCategory: "toString" });
  expectStatus("unknown sprayer type is refused", bad, [400]);
  const badDate = await owner("POST", "/green-track/machines", { name: "Bad date", type: "sprayer_spreader", purchaseDate: "next week" });
  expectStatus("a purchase date must be a date", badDate, [400]);

  const boom = await owner("POST", "/green-track/machines", {
    name: "Boom sprayer 24 m", type: "sprayer_spreader", sprayerCategory: "boom_over_3m", purchaseDate: "2018-03-01",
  });
  expectStatus("create wide boom sprayer", boom, [201]);
  check("sprayer type stored", boom.data?.sprayer_category === "boom_over_3m", JSON.stringify(boom.data));
  const knapsack = await owner("POST", "/green-track/machines", {
    name: "Knapsack 15 L", type: "sprayer_spreader", sprayerCategory: "knapsack_handheld", purchaseDate: "2099-01-01",
  });
  expectStatus("create knapsack", knapsack, [201]);
  const mower = await owner("POST", "/green-track/machines", { name: "Ride-on mower", type: "ride_on_rotary", sprayerCategory: "boom_over_3m" });
  expectStatus("create mower", mower, [201]);
  check("only sprayers keep a sprayer type", mower.data?.sprayer_category == null, JSON.stringify(mower.data));

  // A save that leaves the sprayer fields out (older phone app) keeps them.
  const renamed = await owner("PUT", `/green-track/machines/${boom.data.id}`, { name: "Boom sprayer (24 m)", type: "sprayer_spreader" });
  expectStatus("rename sprayer without the sprayer fields", renamed, [200]);
  const machines = await owner("GET", "/green-track/machines");
  const storedBoom = machines.data?.find((m) => m.id === boom.data.id);
  check("sprayer type kept when not sent", storedBoom?.sprayerCategory === "boom_over_3m", JSON.stringify(storedBoom));
  check("purchase date kept when not sent", day(storedBoom?.purchaseDate) === "2018-03-01", JSON.stringify(storedBoom));

  // ── Never tested: the first test was due before the sprayer was 5 ──────────
  let status = await owner("GET", "/green-track/status");
  expectStatus("status", status, [200]);
  let boomStatus = status.data?.nstsSprayers?.find((s) => s.machineId === boom.data.id);
  check("never-tested sprayer past 5 years is overdue", boomStatus?.state === "overdue" && boomStatus?.dueDate === "2023-03-01" && boomStatus?.basis === "first_test", JSON.stringify(boomStatus));
  check("overdue count", status.data?.nstsOverdue === 1, JSON.stringify(status.data?.nstsOverdue));
  check("mowers are not listed", !status.data?.nstsSprayers?.some((s) => s.machineId === mower.data.id));

  // ── An NSTS test gets its next date from the sprayer type ──────────────────
  const test = await owner("POST", "/green-track/puwer-inspections", {
    machineId: boom.data.id, inspectionType: "nsts_test", inspectionDate: "2024-05-10", inspectorCompany: "Sprayer Testing Ltd",
  });
  expectStatus("log NSTS test", test, [201]);
  check("next test 3 years on for a wide boom", day(test.data?.next_inspection_date) === "2027-05-10", JSON.stringify(test.data?.next_inspection_date));
  const typed = await owner("POST", "/green-track/puwer-inspections", {
    machineId: knapsack.data.id, inspectionType: "nsts_test", inspectionDate: "2026-01-15", nextInspectionDate: "2026-07-15",
  });
  expectStatus("log knapsack check with a typed date", typed, [201]);

  status = await owner("GET", "/green-track/status");
  boomStatus = status.data?.nstsSprayers?.find((s) => s.machineId === boom.data.id);
  check("tested sprayer follows its latest test", boomStatus?.lastTestDate === "2024-05-10" && boomStatus?.dueDate === "2027-05-10" && boomStatus?.basis === "latest_test", JSON.stringify(boomStatus));
  const knapsackStatus = status.data?.nstsSprayers?.find((s) => s.machineId === knapsack.data.id);
  check("a typed next date wins", knapsackStatus?.dueDate === "2026-07-15", JSON.stringify(knapsackStatus));

  // Changing the test date with the next date cleared works it out again.
  const edited = await owner("PUT", `/green-track/puwer-inspections/${test.data.id}`, { inspectionDate: "2025-06-01", nextInspectionDate: null });
  expectStatus("edit NSTS test date", edited, [200]);
  status = await owner("GET", "/green-track/status");
  boomStatus = status.data?.nstsSprayers?.find((s) => s.machineId === boom.data.id);
  check("edited test recomputes the next date", boomStatus?.dueDate === "2028-06-01", JSON.stringify(boomStatus));

  // A PUWER examination is not an NSTS test and gets no worked-out date.
  const puwer = await owner("POST", "/green-track/puwer-inspections", { machineId: mower.data.id, inspectionDate: "2026-01-10" });
  expectStatus("log PUWER examination", puwer, [201]);
  check("PUWER examination has no automatic date", puwer.data?.next_inspection_date == null, JSON.stringify(puwer.data));

  // ── Certificates ───────────────────────────────────────────────────────────
  const noCert = await owner("GET", `/green-track/puwer-inspections/${test.data.id}/certificate-url`);
  expectStatus("no certificate attached", noCert, [404]);
  const forged = await owner("POST", "/green-track/puwer-inspections", {
    machineId: boom.data.id, inspectionType: "nsts_test", inspectionDate: "2026-02-01",
    certificateObjectPath: "/objects/finalized/tenant-1/someone-elses-file", certificateFileName: "cert.pdf",
  });
  check("an unverified certificate path is refused", forged.status >= 400, `${forged.status} ${JSON.stringify(forged.data)}`);
  const list = await owner("GET", `/green-track/puwer-inspections?machineId=${boom.data.id}`);
  check("refused certificate leaves no record", list.data?.length === 1, JSON.stringify(list.data?.map((r) => r.id)));
  check("list carries certificate fields", list.data?.[0] && "certificateObjectPath" in list.data[0], JSON.stringify(list.data?.[0]));

  // ── Tenant isolation ───────────────────────────────────────────────────────
  expectStatus("other business cannot read the certificate route", await other("GET", `/green-track/puwer-inspections/${test.data.id}/certificate-url`), [404]);
  expectStatus("other business cannot log a test on this sprayer",
    await other("POST", "/green-track/puwer-inspections", { machineId: boom.data.id, inspectionType: "nsts_test", inspectionDate: "2026-01-01" }), [404]);
  const otherStatus = await other("GET", "/green-track/status");
  check("other business sees no sprayers", Array.isArray(otherStatus.data?.nstsSprayers) && otherStatus.data.nstsSprayers.length === 0, JSON.stringify(otherStatus.data?.nstsSprayers));

  console.log(`green NSTS sprayer tests: ${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
