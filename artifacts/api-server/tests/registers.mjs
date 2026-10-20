// Site registers (/registers): allergen records, COSHH register and asbestos.
// Covers tenant isolation (lists, foreign ids, foreign sites, foreign
// clientId), client_viewer refused, department scoping for staff, the
// allergen tick change log, soft delete, default review dates, overdue flags
// and the upload path ownership check.
// Run: pnpm --filter @workspace/api-server run test:registers
import assert from "node:assert/strict";
import { createTenant, createUser, isoDay, pool } from "./approval-workflow-fixtures.mjs";

function addMonths(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

async function ok(promise, status, label) {
  const result = await promise;
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

const owner = await createTenant("registers");
const foreign = await createTenant("registers-foreign");
const kitchen = await ok(owner.request("POST", "/departments", { name: "Kitchen" }), 201, "department");
const other = await ok(owner.request("POST", "/departments", { name: "Lodges" }), 201, "second department");
const siteA = await ok(owner.request("POST", "/sites", { name: "Main restaurant", departmentId: kitchen.id }), 201, "site A");
const siteB = await ok(owner.request("POST", "/sites", { name: "Lodge block", departmentId: other.id }), 201, "site B");
const foreignSite = await ok(foreign.request("POST", "/sites", { name: "Foreign site" }), 201, "foreign site");
const viewer = await createUser(owner, { role: "client_viewer", departmentId: kitchen.id });
// Unassigned staff only see site-neutral records (as on GET /sites).
const unassignedStaff = await createUser(owner, { role: "client_staff" });
const staff = await createUser(owner, { role: "client_staff", departmentId: kitchen.id });

// ── Allergens ────────────────────────────────────────────────────────────────
const dish = await ok(owner.request("POST", "/registers/allergens", {
  siteId: siteA.id, name: "Fish pie", allergens: ["milk", "fish", "fish", "gluten"], ppds: true,
  lastReviewedAt: isoDay(0), reviewedBy: "Head chef",
}), 201, "create allergen item");
assert.deepEqual(dish.allergens, ["gluten", "fish", "milk"], "ticks are de-duplicated in the regulated order");
assert.equal(dish.ppds, true);
await ok(owner.request("POST", "/registers/allergens", { siteId: siteA.id, name: "Bad", allergens: ["kiwi"] }), 400, "unknown allergen rejected");
await ok(owner.request("POST", "/registers/allergens", { siteId: foreignSite.id, name: "X", allergens: [] }), 400, "foreign site rejected");
const lodgeDish = await ok(owner.request("POST", "/registers/allergens", { siteId: siteB.id, name: "Lodge breakfast", allergens: ["eggs"] }), 201, "site B item");

// Changing ticks needs a recipe/supplier reason and writes one audit row.
await ok(owner.request("PUT", `/registers/allergens/${dish.id}`, {
  siteId: siteA.id, name: "Fish pie", allergens: ["milk", "fish", "gluten", "mustard"], ppds: true,
}), 400, "tick change without a reason");
await ok(owner.request("PUT", `/registers/allergens/${dish.id}`, {
  siteId: siteA.id, name: "Fish pie", allergens: ["milk", "fish", "gluten", "mustard"], ppds: true,
  changeReason: "New supplier for the white sauce",
}), 200, "tick change with a reason");
await ok(owner.request("PUT", `/registers/allergens/${dish.id}`, {
  siteId: siteA.id, name: "Fish pie (large)", allergens: ["mustard", "milk", "fish", "gluten"], ppds: true,
}), 200, "edit without a tick change needs no reason");
let changes = await ok(owner.request("GET", `/registers/allergens/${dish.id}/changes`), 200, "change log");
assert.deepEqual(changes.map((c) => c.changeType), ["allergens_changed", "created"]);
assert.deepEqual(changes[0].allergensBefore, ["gluten", "fish", "milk"]);
assert.deepEqual(changes[0].allergensAfter, ["gluten", "fish", "milk", "mustard"]);
assert.equal(changes[0].reason, "New supplier for the white sauce");

// Viewer: read-only.
const kitchenStaffList = await ok(staff.request("GET", "/registers/allergens"), 200, "kitchen staff list");
assert.ok(kitchenStaffList.some((i) => i.id === dish.id));
assert.equal((await ok(unassignedStaff.request("GET", "/registers/allergens"), 200, "unassigned staff list")).length, 0);
// Viewers see only their own training records.
await ok(viewer.request("GET", "/registers/allergens"), 403, "viewer list");
await ok(viewer.request("POST", "/registers/allergens", { siteId: siteA.id, name: "V", allergens: [] }), 403, "viewer create");
await ok(viewer.request("PUT", `/registers/allergens/${dish.id}`, { siteId: siteA.id, name: "V", allergens: [] }), 403, "viewer edit");
await ok(viewer.request("DELETE", `/registers/allergens/${dish.id}`), 403, "viewer delete");

// Staff limited to their department's sites.
const staffList = await ok(staff.request("GET", "/registers/allergens"), 200, "staff list");
assert.ok(staffList.some((i) => i.id === dish.id), "staff sees own department site");
assert.ok(!staffList.some((i) => i.id === lodgeDish.id), "staff does not see other department site");
await ok(staff.request("PUT", `/registers/allergens/${lodgeDish.id}`, { siteId: siteB.id, name: "x", allergens: [] }), 404, "staff edit other department");
await ok(staff.request("POST", "/registers/allergens", { siteId: siteB.id, name: "x", allergens: [] }), 400, "staff create on other department site");
await ok(staff.request("GET", `/registers/allergens/${lodgeDish.id}/changes`), 404, "staff change log other department");

// Foreign tenant.
const foreignList = await ok(foreign.request("GET", "/registers/allergens"), 200, "foreign list");
assert.equal(foreignList.length, 0, "foreign tenant sees none of the owner's items");
await ok(foreign.request("PUT", `/registers/allergens/${dish.id}`, { siteId: foreignSite.id, name: "x", allergens: [] }), 404, "foreign edit");
await ok(foreign.request("DELETE", `/registers/allergens/${dish.id}`), 404, "foreign delete");
await ok(foreign.request("GET", `/registers/allergens/${dish.id}/changes`), 404, "foreign change log");
await ok(foreign.request("GET", `/registers/allergens?clientId=${owner.clientId}`), 403, "foreign clientId");

// Soft delete keeps the row and logs the removal.
await ok(owner.request("DELETE", `/registers/allergens/${dish.id}`), 204, "delete item");
assert.ok(!(await ok(owner.request("GET", "/registers/allergens"), 200, "list after delete")).some((i) => i.id === dish.id));
const stored = await pool.query("SELECT deleted_at FROM allergen_items WHERE id = $1", [dish.id]);
assert.ok(stored.rows[0]?.deleted_at, "row kept with deleted_at");
changes = await ok(owner.request("GET", `/registers/allergens/${dish.id}/changes`), 200, "change log after delete");
assert.equal(changes[0].changeType, "removed");
await ok(owner.request("PUT", `/registers/allergens/${dish.id}`, { siteId: siteA.id, name: "x", allergens: [] }), 404, "edit deleted item");

// ── COSHH ────────────────────────────────────────────────────────────────────
const assessed = isoDay(-30);
const bleach = await ok(owner.request("POST", "/registers/coshh", {
  siteId: siteA.id, productName: "Thick bleach", supplier: "Cleanco", hazardPictograms: ["ghs05", "ghs09"],
  whereUsed: "Toilets", assessmentDate: assessed, controls: "Gloves and goggles",
}), 201, "create substance");
assert.equal(bleach.reviewDue, addMonths(assessed, 12), "review defaults to 12 months after assessment");
assert.equal(bleach.reviewOverdue, false);
assert.equal(bleach.status, "in_use");
const overdue = await ok(owner.request("POST", "/registers/coshh", {
  siteId: siteB.id, productName: "Oven cleaner", assessmentDate: isoDay(-400), reviewDue: isoDay(-35),
}), 201, "create overdue substance");
assert.equal(overdue.reviewOverdue, true, "past review date is overdue");
const withdrawn = await ok(owner.request("PUT", `/registers/coshh/${overdue.id}`, {
  siteId: siteB.id, productName: "Oven cleaner", assessmentDate: isoDay(-400), reviewDue: isoDay(-35), status: "withdrawn",
}), 200, "withdraw substance");
assert.equal(withdrawn.reviewOverdue, false, "withdrawn substances are not overdue");
await ok(owner.request("POST", "/registers/coshh", { siteId: siteA.id, productName: "X", hazardPictograms: ["ghs10"] }), 400, "unknown pictogram");
await ok(owner.request("POST", "/registers/coshh", {
  siteId: siteA.id, productName: "Stolen", objectPath: `/objects/uploads/tenant-${foreign.clientId}/abc.pdf`, fileName: "x.pdf",
}), 403, "another tenant's upload path rejected");
await ok(owner.request("GET", `/registers/coshh/${bleach.id}/sds-url`), 404, "no data sheet attached");
await ok(owner.request("POST", "/registers/uploads/request-url", { contentType: "text/html" }), 400, "upload type rejected");
await ok(viewer.request("POST", "/registers/uploads/request-url", { contentType: "application/pdf" }), 403, "viewer upload");
await ok(viewer.request("POST", "/registers/coshh", { siteId: siteA.id, productName: "V" }), 403, "viewer create substance");
await ok(viewer.request("DELETE", `/registers/coshh/${bleach.id}`), 403, "viewer delete substance");
assert.equal((await ok(foreign.request("GET", "/registers/coshh"), 200, "foreign coshh list")).length, 0);
await ok(foreign.request("PUT", `/registers/coshh/${bleach.id}`, { siteId: foreignSite.id, productName: "x" }), 404, "foreign edit substance");
await ok(foreign.request("GET", `/registers/coshh/${bleach.id}/sds-url`), 404, "foreign data sheet link");
const staffCoshh = await ok(staff.request("GET", "/registers/coshh"), 200, "staff coshh");
assert.deepEqual(staffCoshh.map((s) => s.id), [bleach.id], "staff sees only own department substances");
await ok(staff.request("DELETE", `/registers/coshh/${overdue.id}`), 404, "staff delete other department");
await ok(owner.request("DELETE", `/registers/coshh/${bleach.id}`), 204, "delete substance");
assert.ok((await pool.query("SELECT deleted_at FROM coshh_substances WHERE id = $1", [bleach.id])).rows[0]?.deleted_at, "substance soft-deleted");

// ── Asbestos ─────────────────────────────────────────────────────────────────
await ok(owner.request("POST", "/registers/asbestos", { siteId: siteA.id, builtBefore2000: "yes", noAsbestosExpected: true }), 400, "no-asbestos option needs a post-2000 build");
const surveyDate = isoDay(-10);
const record = await ok(owner.request("POST", "/registers/asbestos", {
  siteId: siteA.id, builtBefore2000: "yes", surveyType: "management", surveyDate, surveyor: "Survey Ltd",
}), 201, "create asbestos record");
assert.equal(record.planReviewDue, addMonths(surveyDate, 12), "plan review defaults to 12 months after the survey");
await ok(owner.request("POST", "/registers/asbestos", { siteId: siteA.id, builtBefore2000: "unknown" }), 409, "one current record per site");
const modern = await ok(owner.request("POST", "/registers/asbestos", { siteId: siteB.id, builtBefore2000: "no", noAsbestosExpected: true }), 201, "post-2000 record");
assert.equal(modern.planReviewDue, null);
assert.equal(modern.planReviewOverdue, false);
const lapsed = await ok(owner.request("PUT", `/registers/asbestos/${record.id}`, {
  siteId: siteA.id, builtBefore2000: "yes", surveyType: "management", surveyDate, planReviewDue: isoDay(-1),
}), 200, "edit plan review date");
assert.equal(lapsed.planReviewOverdue, true);
const entry = await ok(owner.request("POST", `/registers/asbestos/${record.id}/entries`, {
  location: "Boiler room ceiling", material: "Asbestos insulating board", condition: "low_damage", riskScore: 9, priority: "medium", action: "encapsulate",
}), 201, "create register entry");
await ok(owner.request("POST", `/registers/asbestos/${record.id}/entries`, {
  location: "X", material: "Y", condition: "good", riskScore: 30, priority: "low", action: "manage",
}), 400, "risk score out of range");
await ok(owner.request("PUT", `/registers/asbestos/entries/${entry.id}`, {
  location: "Boiler room ceiling", material: "Asbestos insulating board", condition: "low_damage", priority: "medium", action: "remove",
}), 200, "edit register entry");
const list = await ok(owner.request("GET", "/registers/asbestos"), 200, "asbestos list");
const listed = list.find((r) => r.id === record.id);
assert.equal(listed.entries.length, 1);
assert.equal(listed.entries[0].action, "remove");
// Survey history: detaching (or replacing) the report keeps the previous one
// listed. Storage is not available here, so the stored report is seeded.
const oldReport = `/objects/uploads/tenant-${owner.clientId}/asbestos-history-${record.id}.pdf`;
await pool.query("UPDATE asbestos_records SET report_object_path = $1, report_file_name = 'survey-2019.pdf' WHERE id = $2", [oldReport, record.id]);
await ok(owner.request("PUT", `/registers/asbestos/${record.id}`, {
  siteId: siteA.id, builtBefore2000: "yes", surveyType: "management", surveyDate, surveyor: "Survey Ltd", objectPath: oldReport,
}), 200, "unchanged report is kept");
assert.equal((await pool.query("SELECT count(*)::int AS n FROM asbestos_survey_history WHERE record_id = $1", [record.id])).rows[0].n, 0, "keeping the report adds no history");
const detached = await ok(owner.request("PUT", `/registers/asbestos/${record.id}`, {
  siteId: siteA.id, builtBefore2000: "yes", surveyType: "refurbishment_demolition", surveyDate: isoDay(-2), objectPath: null,
}), 200, "detach survey report");
assert.equal(detached.reportObjectPath, null);
const history = (await ok(owner.request("GET", "/registers/asbestos"), 200, "asbestos list with history")).find((r) => r.id === record.id).surveyHistory;
assert.equal(history.length, 1, "previous survey kept");
assert.equal(history[0].reportObjectPath, oldReport);
assert.equal(history[0].reportFileName, "survey-2019.pdf");
assert.equal(history[0].surveyType, "management");
assert.equal(history[0].surveyDate, surveyDate);
assert.equal(history[0].surveyor, "Survey Ltd");
await ok(foreign.request("GET", `/registers/asbestos/${record.id}/history/${history[0].id}/report-url`), 404, "foreign history report link");
await ok(owner.request("GET", `/registers/asbestos/${modern.id}/history/${history[0].id}/report-url`), 404, "history entry of another record");
await ok(viewer.request("GET", "/registers/asbestos"), 403, "viewer can't read the register");
await ok(viewer.request("POST", `/registers/asbestos/${record.id}/entries`, { location: "x", material: "y", condition: "good", priority: "low", action: "manage" }), 403, "viewer add entry");
await ok(viewer.request("PUT", `/registers/asbestos/${record.id}`, { siteId: siteA.id, builtBefore2000: "no" }), 403, "viewer edit record");
await ok(viewer.request("DELETE", `/registers/asbestos/entries/${entry.id}`), 403, "viewer delete entry");
assert.equal((await ok(foreign.request("GET", "/registers/asbestos"), 200, "foreign asbestos list")).length, 0);
await ok(foreign.request("POST", `/registers/asbestos/${record.id}/entries`, { location: "x", material: "y", condition: "good", priority: "low", action: "manage" }), 404, "foreign add entry");
await ok(foreign.request("PUT", `/registers/asbestos/entries/${entry.id}`, { location: "x", material: "y", condition: "good", priority: "low", action: "manage" }), 404, "foreign edit entry");
await ok(foreign.request("DELETE", `/registers/asbestos/${record.id}`), 404, "foreign delete record");
await ok(foreign.request("GET", `/registers/asbestos/${record.id}/report-url`), 404, "foreign report link");
const staffAsbestos = await ok(staff.request("GET", "/registers/asbestos"), 200, "staff asbestos");
assert.deepEqual(staffAsbestos.map((r) => r.id), [record.id], "staff sees only own department records");
await ok(staff.request("POST", `/registers/asbestos/${modern.id}/entries`, { location: "x", material: "y", condition: "good", priority: "low", action: "manage" }), 404, "staff add entry other department");
await ok(owner.request("DELETE", `/registers/asbestos/entries/${entry.id}`), 204, "delete entry");
await ok(owner.request("DELETE", `/registers/asbestos/${record.id}`), 204, "delete record");
assert.ok((await pool.query("SELECT deleted_at FROM asbestos_records WHERE id = $1", [record.id])).rows[0]?.deleted_at, "record soft-deleted");
assert.ok((await pool.query("SELECT deleted_at FROM asbestos_register_entries WHERE id = $1", [entry.id])).rows[0]?.deleted_at, "entry soft-deleted");
// A soft-deleted record frees the site for a new current record.
await ok(owner.request("POST", "/registers/asbestos", { siteId: siteA.id, builtBefore2000: "yes" }), 201, "new record after removal");

await pool.end();
console.log("Registers: allergen, COSHH and asbestos routes passed.");
