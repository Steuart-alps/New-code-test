// Upgrade-path check: the disposable database started as an older, populated
// install (tests/upgrade-fixtures/legacy-shapes.ts), then the runtime
// migrations ran twice. Every older record must still be there, unchanged in
// its original columns, readable through today's routes, and the kitchen diary
// must still hold one record per business, site and day.
//
// Run with tests/run-fresh-schema.sh only (see test:schema:upgrade); it refuses
// anything but its own Unix-socket database.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE = process.env.API_BASE;
const DATABASE_URL = process.env.DATABASE_URL;
const SHAPE = process.env.FRESH_SCHEMA_UPGRADE_FIXTURE;
if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1") {
  throw new Error("Run through tests/run-fresh-schema.sh (NODE_ENV=test, FRESH_SCHEMA_TEST=1)");
}
if (!BASE || !DATABASE_URL || !SHAPE) throw new Error("API_BASE, DATABASE_URL and FRESH_SCHEMA_UPGRADE_FIXTURE are required");
// The harness's private cluster listens on a socket only; never a TCP host.
if (!/^postgresql:\/\/schema_test@\/schema_test\?host=\//.test(DATABASE_URL)) {
  throw new Error("Refusing to run against anything but the disposable fresh-schema database");
}
const RUNTIME = SHAPE === "replit-runtime";
const LEGACY = 101;
const OTHER = 202;

let assertions = 0;
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };

/** Rows of a read-only query, as JSON. */
function rows(query) {
  const out = execFileSync("psql", [DATABASE_URL, "-AtX", "-v", "ON_ERROR_STOP=1", "-c",
    `SELECT coalesce(json_agg(_r), '[]') FROM (${query}) _r`], { encoding: "utf8" });
  return JSON.parse(out);
}
function exec(statement) {
  execFileSync("psql", [DATABASE_URL, "-AtX", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" });
}

let cookie = "";
async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}
async function ok(method, path, body, expected = 200) {
  const response = await request(method, path, body);
  assertions++;
  assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${JSON.stringify(response.data)}`);
  return response.data;
}

// Routes return snake_case from raw SQL and camelCase from Drizzle (some are
// moving to camelCase); read either so the check is about the value.
const field = (row, camel) => row[camel] !== undefined ? row[camel] : row[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
const day = (value) => value == null ? null : String(value).slice(0, 10);
const num = (value) => value == null ? null : Number(value);
const byId = (list) => new Map(list.map((row) => [Number(row.id), row]));

// ---- 1. Nothing lost or duplicated in the database itself ----
const expectedCounts = {
  legionella_checks: [3, 1], hot_tub_checks: [2, 1], food_safety_records: [2, 1],
  bikes: [2, 1], bike_hire_records: [2, 1], bike_checks: [2, 1], bike_services: [2, 1],
};
for (const [table, [legacy, other]] of Object.entries(expectedCounts)) {
  const [counts] = rows(`SELECT count(*) FILTER (WHERE client_id = ${LEGACY})::int AS legacy,
    count(*) FILTER (WHERE client_id = ${OTHER})::int AS other FROM ${table}`);
  equal(counts, { legacy, other }, `${table}: every older row survives the upgrade, none duplicated`);
}

if (RUNTIME) {
  // The old columns keep their values: copies are made, nothing is rewritten.
  equal(rows(`SELECT id, temperature_c::float AS t FROM legionella_checks ORDER BY id`),
    [{ id: 1, t: 55.5 }, { id: 2, t: 21.4 }, { id: 3, t: null }, { id: 4, t: 60 }], "legionella temperature_c kept");
  equal(rows(`SELECT id, temperature_c::float AS t, ph_level::float AS ph, chlorine_level::float AS cl, bromine_level::float AS br
    FROM hot_tub_checks ORDER BY id`), [
    { id: 1, t: 38.5, ph: 7.4, cl: 3.2, br: null }, { id: 2, t: 37, ph: 7.6, cl: null, br: 4.5 },
    { id: 3, t: 39, ph: 7.2, cl: 2, br: null }], "hot tub legacy readings kept");
  equal(rows(`SELECT id, fridge1_temp::float AS f1, freezer1_temp::float AS z1, hot_holding_temp::float AS hh, probe_cleaned, notes
    FROM food_safety_records ORDER BY id`), [
    { id: 1, f1: 3.5, z1: -18, hh: 65, probe_cleaned: true, notes: "Delivery late" },
    { id: 2, f1: 2.5, z1: null, hh: null, probe_cleaned: false, notes: null },
    { id: 3, f1: 5, z1: null, hh: null, probe_cleaned: null, notes: null }], "fixed-column diary readings kept");
  equal(rows(`SELECT id, name, bike_type, serial_number, colour, size FROM bikes ORDER BY id`), [
    { id: 1, name: "Blue Raleigh", bike_type: "standard", serial_number: "SN-001", colour: "Blue", size: "M" },
    { id: 2, name: "Kids bike", bike_type: "kids", serial_number: null, colour: "Red", size: "S" },
    { id: 3, name: "Other bike", bike_type: "standard", serial_number: null, colour: null, size: null }], "old bike columns kept");
  equal(rows(`SELECT id, hirer_name, hire_fee::float AS fee, deposit_taken::float AS deposit, pre_check_passed, post_check_passed
    FROM bike_hire_records ORDER BY id`), [
    { id: 1, hirer_name: "Pat Guest", fee: 25, deposit: 50, pre_check_passed: true, post_check_passed: null },
    { id: 2, hirer_name: "Lee Visitor", fee: 10, deposit: null, pre_check_passed: true, post_check_passed: true },
    { id: 3, hirer_name: "Other hirer", fee: null, deposit: null, pre_check_passed: true, post_check_passed: null }], "old hire columns kept");
  equal(rows(`SELECT id, result, items_checked FROM bike_checks ORDER BY id`), [
    { id: 1, result: "pass", items_checked: { brakes: "pass", tyres: "pass" } },
    { id: 2, result: "fail", items_checked: { brakes: "fail" } },
    { id: 3, result: "pass", items_checked: null }], "old check columns kept");
  // Copies into today's columns are audited like any other change.
  const audited = rows(`SELECT table_name, row_id, diff FROM audit_log
    WHERE action = 'update' AND client_id = ${LEGACY} AND table_name IN ('legionella_checks', 'food_safety_records')
    ORDER BY table_name, row_id, id`);
  check(audited.some((a) => a.table_name === "legionella_checks" && a.row_id === 1
    && a.diff.temperature?.before === null && Number(a.diff.temperature?.after) === 55.5),
    "the copy of a legionella reading is in the audit log with its before and after values");
  check(audited.some((a) => a.table_name === "food_safety_records" && a.row_id === 1 && a.diff.cold_food),
    "the copy of a diary's fixed readings is in the audit log");
}
equal(rows(`SELECT id, performed_by, cost::float AS cost, work_carried_out, parts_replaced FROM bike_services ORDER BY id`), [
  { id: 1, performed_by: "Cycle Fix Ltd", cost: 45.5, work_carried_out: "Full service", parts_replaced: "Chain" },
  { id: 2, performed_by: null, cost: null, work_carried_out: null, parts_replaced: null },
  { id: 3, performed_by: "Other mechanic", cost: 12, work_carried_out: null, parts_replaced: null }], "old service columns kept");

// The diary's whole-table (business, date) uniqueness is retired: only the
// per-scope partial unique indexes remain.
equal(rows(`SELECT conname FROM pg_constraint WHERE conrelid = 'food_safety_records'::regclass AND contype = 'u'`), [],
  "old (client_id, record_date) unique constraint dropped");
equal(rows(`SELECT i.relname AS name, x.indpred IS NOT NULL AS partial FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = 'food_safety_records'::regclass AND x.indisunique
    AND NOT x.indisprimary ORDER BY 1`).filter((index) => !index.partial), [],
  "no whole-table unique index left on the diary");

// ---- 2. Sign in as a manager of the older business ----
const stamp = randomUUID().slice(0, 8);
const email = `upgrade-${stamp}@example.test`;
const password = `Upgrade-${stamp}-pass1!`;
const registered = await ok("POST", "/auth/register", { name: "Upgrade Manager", email, password });
await ok("GET", `/auth/verify-email?token=${encodeURIComponent(registered.verificationToken)}`);
// Test plumbing: this disposable database's new account joins the older business.
exec(`UPDATE users SET client_id = ${LEGACY} WHERE email = '${email}'`);
await ok("POST", "/auth/login", { email, password });
const me = await ok("GET", "/auth/me");
equal((me.user ?? me).clientId, LEGACY, "signed in to the older business");

// ---- 3. Records readable through today's routes ----
const legionella = byId(await ok("GET", "/legionella"));
equal([...legionella.keys()].sort(), [1, 2, 3], "LegionellaTrack lists this business's older checks only");
equal(num(legionella.get(1).temperature), 55.5, "older Legionella reading shows as the temperature");
equal(legionella.get(1).location, "Kitchen sink", "older Legionella location kept");
equal(legionella.get(2).temperature, null, "a reading cleared after the upgrade stays cleared after the next restart");
equal(legionella.get(3).notes, "No reading taken", "older Legionella notes kept");

const hotTub = byId(await ok("GET", "/hot-tub"));
equal([...hotTub.keys()].sort(), [1, 2], "hot tub lists this business's older checks only");
equal([num(hotTub.get(1).temperature), num(hotTub.get(1).phValue), num(hotTub.get(1).sanitiserLevel)], [38.5, 7.4, 3.2],
  "older chlorine-tub readings show as temperature, pH and sanitiser");
equal([num(hotTub.get(2).temperature), num(hotTub.get(2).phValue), num(hotTub.get(2).sanitiserLevel)], [37, 7.6, 4.5],
  "older bromine-tub readings show as temperature, pH and sanitiser");

const bikes = byId(await ok("GET", "/bike-track/bikes"));
equal([...bikes.keys()].sort(), [1, 2], "BikeTrack lists this business's older bikes only");
equal([bikes.get(1).ref, bikes.get(1).name, bikes.get(1).type, bikes.get(1).status],
  RUNTIME ? ["Blue Raleigh", "Blue Raleigh", "standard", "hired"] : ["BIKE-01", "Blue Raleigh", "hybrid", "hired"],
  "older bike shows its label, name, type and status");
equal(bikes.get(2).type, "kids", "older bike type kept");

const hires = byId(await ok("GET", "/bike-track/hires"));
equal([...hires.keys()].sort(), [1, 2], "BikeTrack lists this business's older hires only");
const hire = hires.get(1);
equal([field(hire, "guestName"), field(hire, "guestContact"), day(field(hire, "hireDate")),
  day(field(hire, "returnDateExpected")), num(field(hire, "depositPence")), hire.status],
  ["Pat Guest", "07700 900001", "2026-09-01", "2026-09-03", 5000, "active"], "older open hire readable");
equal([day(field(hires.get(2), "returnDateActual")), hires.get(2).status], ["2026-08-20", "returned"], "older returned hire readable");

const checks = byId(await ok("GET", "/bike-track/checks"));
equal([...checks.keys()].sort(), [1, 2], "BikeTrack lists this business's older checks only");
equal([field(checks.get(1), "overallResult"), field(checks.get(2), "overallResult")], ["pass", "fail"], "older check results readable");
equal([day(field(checks.get(1), "checkDate")), field(checks.get(2), "notes")], ["2026-09-01", "Rear brake worn"], "older check date and notes kept");

const services = byId(await ok("GET", "/bike-track/services"));
equal([...services.keys()].sort(), [1, 2], "BikeTrack lists this business's older services only");
equal([field(services.get(1), "servicedBy"), num(field(services.get(1), "costPence")), day(field(services.get(1), "nextServiceDate"))],
  ["Cycle Fix Ltd", 4550, "2027-08-01"], "older service shows who serviced it and its cost in pence");

const diaryDates = await ok("GET", "/food-safety");
equal(diaryDates.map((r) => day(r.recordDate)), RUNTIME ? ["2026-09-01", "2026-09-02"] : ["2026-09-01"],
  "whole-business diary lists its older days");
const diary = await ok("GET", "/food-safety?date=2026-09-01");
equal(diary.id, 1, "older whole-business diary day readable");
if (RUNTIME) {
  const cold = diary.coldFood.map((r) => [r.unit, r.tempAm]);
  equal(cold, [["Fridge 1", "3.5"], ["Fridge 2", "4.0"], ["Freezer 1", "-18.0"]], "fixed fridge and freezer readings show in cold food");
  equal(diary.hotHolding.map((r) => [r.item, r.coreTemp]), [["Hot holding", "65.0"]], "fixed hot-holding reading shows in hot holding");
  check(/Delivery late/.test(diary.correctives ?? "") && /Probe cleaned: yes/.test(diary.correctives ?? ""),
    "older diary notes and probe-cleaned answer show with the day's notes");
  equal(diary.performedBy, "Chef Jo", "older diary keeps who filled it in");
  const second = await ok("GET", "/food-safety?date=2026-09-02");
  check(/Probe cleaned: no/.test(second.correctives ?? ""), "a 'no' probe answer is shown too");
} else {
  equal(diary.coldFood, [{ unit: "Fridge 1", tempAm: "3.5", tempPm: "4.0", correctiveAction: "" }], "older diary rows unchanged");
  const siteDay = await ok("GET", "/food-safety?date=2026-09-02&siteId=1101");
  equal(siteDay.id, 2, "older per-site diary day readable");
}
// A second boot must not copy the fixed readings in again.
const coldCount = diary.coldFood.length;

// ---- 4. No duplicate diary days after the upgrade ----
const appended = await ok("POST", "/food-safety/append",
  { recordDate: "2026-09-01", section: "coldFood", row: { unit: "Upgrade fridge", tempAm: "4", tempPm: "", correctiveAction: "" } }, 201);
equal(appended.id, 1, "adding to an older day appends to that day's record");
const afterAppend = await ok("GET", "/food-safety?date=2026-09-01");
equal(afterAppend.coldFood.length, coldCount + 1, "the older readings are still there after the append");
equal(afterAppend.coldFood.slice(0, coldCount), diary.coldFood, "older readings unchanged by the append");
const conflict = await request("POST", "/food-safety", { recordDate: "2026-09-01" });
equal([conflict.status, conflict.data?.id], [409, 1], "creating an older day again points at the existing record");
// Two sites (and the whole business) may now share a date, once each.
const siteAppend = { recordDate: "2026-09-01", section: "coldFood", row: { unit: "Site fridge", tempAm: "3", tempPm: "", correctiveAction: "" } };
const siteFirst = await ok("POST", "/food-safety/append?siteId=1101", siteAppend, 201);
const siteSecond = await ok("POST", "/food-safety/append?siteId=1101", siteAppend, 201);
equal(siteSecond.id, siteFirst.id, "a site's day is one record however many readings are added");
check(siteFirst.id !== 1, "a site's diary day is separate from the whole-business day");
equal(rows(`SELECT site_id, count(*)::int AS n FROM food_safety_records
  WHERE client_id = ${LEGACY} AND record_date = '2026-09-01' GROUP BY site_id ORDER BY site_id NULLS FIRST`),
  [{ site_id: null, n: 1 }, { site_id: 1101, n: 1 }], "one diary record per business, site and day");

// ---- 5. Today's writes work on the upgraded tables ----
const newCheck = await ok("POST", "/legionella",
  { checkType: "hot_sentinel_temp", checkDate: "2026-10-01", result: "pass", temperature: 58, siteId: 1101, location: "New outlet" }, 201);
check(Number.isInteger(newCheck.id) && newCheck.id > 1000, "new Legionella check saved after the upgrade");
const newService = await ok("POST", "/bike-track/services",
  { bikeId: 1, serviceDate: "2026-10-01", serviceType: "interim", servicedBy: "Upgrade mechanic", costPence: 1200 }, 201);
check(Number(newService.id) > 1000, "new bike service saved after the upgrade");
const newHire = await ok("POST", "/bike-track/hires",
  { bikeId: 2, guestName: "New guest", hireDate: "2026-10-01", siteId: 1102 }, 201);
check(Number(newHire.hire?.id) > 1000, "new hire saved after the upgrade");

// The other business's older records were not touched.
equal(rows(`SELECT temperature::float AS t FROM legionella_checks WHERE client_id = ${OTHER}`), [{ t: 60 }], "other business's reading copied for that business only");

console.log(`Upgrade-path checks passed for ${SHAPE} (${assertions} assertions).`);
