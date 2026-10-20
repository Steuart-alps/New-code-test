// COSHHTrack (/coshh-track): COSHH assessments linked to the COSHH register,
// and the checks that follow from them. Covers tenant isolation, viewers
// refused, assessments limited to owners and managers, substance and
// assessment site matching, default review/next-due dates, the AI-draft
// "checked against the safety data sheet" stamp, the status list (review,
// next due, missing health checks), failed checks opening a track action,
// and soft delete.
// Run: pnpm --filter @workspace/api-server run test:coshh-track
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

const owner = await createTenant("coshh-track");
const foreign = await createTenant("coshh-track-foreign");
const kitchen = await ok(owner.request("POST", "/departments", { name: "Kitchen" }), 201, "department");
const other = await ok(owner.request("POST", "/departments", { name: "Workshop" }), 201, "second department");
const siteA = await ok(owner.request("POST", "/sites", { name: "Main kitchen", departmentId: kitchen.id }), 201, "site A");
const siteB = await ok(owner.request("POST", "/sites", { name: "Workshop", departmentId: other.id }), 201, "site B");
const foreignSite = await ok(foreign.request("POST", "/sites", { name: "Foreign site" }), 201, "foreign site");
const viewer = await createUser(owner, { role: "client_viewer", departmentId: kitchen.id });
const staff = await createUser(owner, { role: "client_staff", departmentId: kitchen.id });
const lead = await createUser(owner, { role: "client_staff", departmentId: kitchen.id, isDepartmentManager: true });

const degreaser = await ok(owner.request("POST", "/registers/coshh", {
  siteId: siteA.id, productName: "Oven degreaser", hazardPictograms: ["ghs05"],
}), 201, "substance at site A");
const solvent = await ok(owner.request("POST", "/registers/coshh", { siteId: siteB.id, productName: "Solvent" }), 201, "substance at site B");

// ── Assessments ──────────────────────────────────────────────────────────────
const assessed = isoDay(-10);
const base = {
  siteId: siteA.id, substanceId: degreaser.id, task: "Deep cleaning ovens", assessmentDate: assessed,
  exposureRoutes: ["skin", "eyes", "skin"], ppe: ["gloves", "eye_protection"], riskLevel: "medium",
  hazardStatements: "H314 Causes severe skin burns and eye damage", signalWord: "danger",
  healthSurveillanceRequired: true,
};
const assessment = await ok(owner.request("POST", "/coshh-track/assessments", base), 201, "create assessment");
assert.equal(assessment.reviewDue, addMonths(assessed, 12), "review defaults to 12 months after the assessment");
assert.deepEqual(assessment.exposureRoutes, ["skin", "eyes"], "routes de-duplicated");
assert.equal(assessment.reviewOverdue, false);
assert.equal(assessment.draftSource, null);
assert.equal(assessment.checkedAt, null);

await ok(owner.request("POST", "/coshh-track/assessments", { ...base, substanceId: solvent.id }), 400, "substance from another site");
await ok(owner.request("POST", "/coshh-track/assessments", { ...base, siteId: foreignSite.id, substanceId: null }), 400, "foreign site");
await ok(owner.request("POST", "/coshh-track/assessments", { ...base, exposureRoutes: ["telepathy"] }), 400, "unknown route");
await ok(owner.request("POST", "/coshh-track/assessments", { ...base, task: "" }), 400, "task required");

// AI drafts: saved only once someone ticks that they checked the sheet.
const draft = { ...base, task: "Descaling the dishwasher", draftSource: "ai", draftedAt: new Date().toISOString() };
const unchecked = await ok(owner.request("POST", "/coshh-track/assessments", draft), 400, "unchecked AI draft");
assert.match(unchecked.error, /checked this draft/);
const aiAssessment = await ok(owner.request("POST", "/coshh-track/assessments", { ...draft, checkedAgainstSds: true }), 201, "checked AI draft");
assert.equal(aiAssessment.draftSource, "ai");
assert.ok(aiAssessment.draftedAt, "drafted time kept");
assert.ok(aiAssessment.checkedAt, "checked time stamped");
assert.equal(aiAssessment.checkedBy, owner.userId);
await ok(owner.request("PUT", `/coshh-track/assessments/${aiAssessment.id}`, { ...draft, task: "Descaling" }), 400, "editing an AI draft needs the tick again");
await ok(owner.request("PUT", `/coshh-track/assessments/${aiAssessment.id}`, { ...draft, task: "Descaling", checkedAgainstSds: true }), 200, "edit AI draft with the tick");

// Staff record checks; only owners and managers change assessments.
await ok(staff.request("POST", "/coshh-track/assessments", base), 403, "staff create assessment");
await ok(staff.request("PUT", `/coshh-track/assessments/${assessment.id}`, base), 403, "staff edit assessment");
await ok(staff.request("DELETE", `/coshh-track/assessments/${assessment.id}`), 403, "staff delete assessment");
const leadAssessment = await ok(lead.request("POST", "/coshh-track/assessments", { ...base, task: "Floor cleaning", healthSurveillanceRequired: false }), 201, "department manager create");
await ok(lead.request("POST", "/coshh-track/assessments", { ...base, siteId: siteB.id, substanceId: null }), 400, "manager create on another department's site");

// Viewers and other tenants.
await ok(viewer.request("GET", "/coshh-track/assessments"), 403, "viewer list");
await ok(viewer.request("POST", "/coshh-track/checks", { siteId: siteA.id, checkType: "staff_briefing", checkDate: isoDay(0) }), 403, "viewer create check");
assert.equal((await ok(foreign.request("GET", "/coshh-track/assessments"), 200, "foreign list")).length, 0);
await ok(foreign.request("PUT", `/coshh-track/assessments/${assessment.id}`, { ...base, siteId: foreignSite.id, substanceId: null }), 404, "foreign edit");
await ok(foreign.request("DELETE", `/coshh-track/assessments/${assessment.id}`), 404, "foreign delete");
await ok(foreign.request("GET", `/coshh-track/assessments/${assessment.id}/document-url`), 404, "foreign document link");
await ok(foreign.request("GET", `/coshh-track/status?clientId=${owner.clientId}`), 403, "foreign clientId");
await ok(owner.request("POST", "/coshh-track/assessments", {
  ...base, objectPath: `/objects/uploads/tenant-${foreign.clientId}/abc.pdf`, fileName: "x.pdf",
}), 403, "another tenant's upload path rejected");

// ── Status: missing health checks, then the next due date ───────────────────
let status = await ok(owner.request("GET", "/coshh-track/status"), 200, "status");
const missing = status.items.find((i) => i.status === "missing" && i.assessmentId === assessment.id);
assert.ok(missing, "health checks needed but not recorded");
assert.equal(missing.kind, "health_surveillance");
assert.equal(status.missing >= 1, true);

const check = await ok(staff.request("POST", "/coshh-track/checks", {
  siteId: siteA.id, assessmentId: assessment.id, checkType: "health_surveillance", checkDate: isoDay(0), subject: "Sam Cook", result: "pass",
}), 201, "staff record health check");
assert.equal(check.nextDueDate, addMonths(isoDay(0), 12), "next health check defaults to 12 months");
await ok(staff.request("POST", "/coshh-track/checks", {
  siteId: siteA.id, assessmentId: assessment.id, checkType: "health_surveillance", checkDate: isoDay(1),
}), 400, "future check date");
await ok(owner.request("POST", "/coshh-track/checks", {
  siteId: siteB.id, assessmentId: assessment.id, checkType: "staff_briefing", checkDate: isoDay(0),
}), 400, "assessment from another site");
await ok(owner.request("POST", "/coshh-track/checks", {
  siteId: siteA.id, checkType: "nap", checkDate: isoDay(0),
}), 400, "unknown check type");

status = await ok(owner.request("GET", "/coshh-track/status"), 200, "status after check");
assert.ok(!status.items.some((i) => i.status === "missing" && i.assessmentId === assessment.id), "missing item cleared");
assert.ok(status.items.some((i) => i.kind === "health_surveillance" && i.recordId === check.id && i.status === "ok"), "next check listed");

// An LEV examination whose next date has passed is overdue; a newer one in the same series replaces it.
const oldLev = await ok(owner.request("POST", "/coshh-track/checks", {
  siteId: siteB.id, checkType: "lev_examination", checkDate: isoDay(-1), subject: "Spray booth", nextDueDate: isoDay(-1), result: "pass",
}), 201, "LEV examination already due");
status = await ok(owner.request("GET", `/coshh-track/status?siteId=${siteB.id}`), 200, "site B status");
assert.ok(status.items.some((i) => i.recordId === oldLev.id && i.status === "overdue"), "overdue LEV listed");
assert.ok(status.overdue >= 1);
assert.ok(status.items.every((i) => i.siteId === siteB.id), "site filter applied");

// A failed check needs the action and opens a COSHHTrack action.
await ok(owner.request("POST", "/coshh-track/checks", {
  siteId: siteB.id, checkType: "lev_examination", checkDate: isoDay(0), subject: "Spray booth", result: "fail",
}), 400, "failed check without an action");
const failed = await ok(owner.request("POST", "/coshh-track/checks", {
  siteId: siteB.id, checkType: "lev_examination", checkDate: isoDay(0), subject: " spray booth ", result: "fail",
  actionRequired: "Replace the filter and re-test",
}), 201, "failed LEV examination");
assert.equal(failed.nextDueDate, addMonths(isoDay(0), 14), "LEV defaults to 14 months");
status = await ok(owner.request("GET", `/coshh-track/status?siteId=${siteB.id}`), 200, "site B status after re-test");
assert.ok(!status.items.some((i) => i.recordId === oldLev.id), "older examination in the same series replaced");
const action = await pool.query(
  "SELECT title, module FROM track_actions WHERE client_id = $1 AND source_kind = 'coshh_checks' AND source_record_id = $2",
  [owner.clientId, failed.id],
);
assert.equal(action.rows[0]?.module, "coshh", "failed check opens a track action");
assert.match(action.rows[0]?.title ?? "", /Extraction \(LEV\) examination failed/);

// Staff see only their department's checks.
const staffChecks = await ok(staff.request("GET", "/coshh-track/checks"), 200, "staff checks");
assert.deepEqual(staffChecks.map((c) => c.id), [check.id], "staff sees own department only");
await ok(staff.request("PUT", `/coshh-track/checks/${failed.id}`, { siteId: siteB.id, checkType: "lev_examination", checkDate: isoDay(0) }), 403, "staff edit other department (refused by the record lock site check)");
assert.equal((await ok(foreign.request("GET", "/coshh-track/checks"), 200, "foreign checks")).length, 0);
await ok(foreign.request("DELETE", `/coshh-track/checks/${check.id}`), 404, "foreign delete check");
await ok(foreign.request("GET", `/coshh-track/checks/${check.id}/report-url`), 404, "foreign report link");

// Archived assessments are no longer chased.
await ok(owner.request("PUT", `/coshh-track/assessments/${assessment.id}`, { ...base, status: "archived" }), 200, "archive assessment");
status = await ok(owner.request("GET", "/coshh-track/status"), 200, "status after archive");
assert.ok(!status.items.some((i) => i.assessmentId === assessment.id), "archived assessment and its checks dropped");

// Soft delete.
await ok(lead.request("DELETE", `/coshh-track/assessments/${leadAssessment.id}`), 204, "manager delete assessment");
await ok(owner.request("DELETE", `/coshh-track/checks/${failed.id}`), 204, "delete check");
assert.ok((await pool.query("SELECT deleted_at FROM coshh_assessments WHERE id = $1", [leadAssessment.id])).rows[0]?.deleted_at, "assessment soft-deleted");
assert.ok((await pool.query("SELECT deleted_at FROM coshh_checks WHERE id = $1", [failed.id])).rows[0]?.deleted_at, "check soft-deleted");
assert.ok(!(await ok(owner.request("GET", "/coshh-track/checks"), 200, "checks after delete")).some((c) => c.id === failed.id));
await ok(owner.request("PUT", `/coshh-track/checks/${failed.id}`, { siteId: siteB.id, checkType: "lev_examination", checkDate: isoDay(0) }), 404, "edit deleted check");

await pool.end();
console.log("COSHHTrack: assessments, checks, due dates and access passed.");
