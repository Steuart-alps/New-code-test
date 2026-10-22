// DocTrack read-and-sign documents in TrainTrack: a document marked "staff
// must read and sign" is a task for active staff in its department and at its
// site. Covers the manager overview TrainTrack shows (who still has to sign,
// with the site), a Viewer's own list in My training (/train-track/my-documents),
// signing there (signature required, only their documents, the TrainTrack
// record written, no second signature), and an expired annual sign-off asking
// them to sign again.
// Run: pnpm --filter @workspace/api-server run test:doc-sign-offs
import assert from "node:assert/strict";
import { createTenant, createUser, isoDay, pool } from "./approval-workflow-fixtures.mjs";

async function ok(promise, status, label) {
  const result = await promise;
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

const owner = await createTenant("doc-sign-offs");
const foreign = await createTenant("doc-sign-offs-foreign");
const kitchen = await ok(owner.request("POST", "/departments", { name: "Kitchen" }), 201, "department");
const siteA = await ok(owner.request("POST", "/sites", { name: "Main kitchen", departmentId: kitchen.id }), 201, "site A");
const siteB = await ok(owner.request("POST", "/sites", { name: "Second kitchen" }), 201, "site B");

const cook = await ok(owner.request("POST", "/staff-roster", { name: "Casey Cook", siteId: siteA.id, department: "Kitchen" }), 201, "roster cook");
const porter = await ok(owner.request("POST", "/staff-roster", { name: "Pat Porter", siteId: siteA.id, department: "Porters" }), 201, "roster porter");
const fitter = await ok(owner.request("POST", "/staff-roster", { name: "Fran Chef", siteId: siteB.id, department: "Kitchen" }), 201, "roster other site");
await ok(owner.request("POST", "/staff-roster", { name: "Lee Leaver", siteId: siteA.id, department: "Kitchen", active: false }), 201, "inactive roster");

// Uploading needs file storage; the document rows are the prerequisite here.
async function addDocument(clientId, { title, siteId = null, department = null, requiresAck = true, annual = false }) {
  const result = await pool.query(
    `INSERT INTO doc_track_documents
       (client_id, site_id, title, category, file_name, mime_type, object_path, requires_acknowledgement, annual_acknowledgement, department)
     VALUES ($1, $2, $3, 'risk_assessment', 'document.pdf', 'application/pdf', $4, $5, $6, $7)
     RETURNING id`,
    [clientId, siteId, title, `/objects/uploads/tenant-${clientId}/${title.replace(/\W+/g, "-")}`, requiresAck, annual, department],
  );
  return result.rows[0].id;
}
const kitchenDoc = await addDocument(owner.clientId, { title: "Kitchen knives risk assessment", siteId: siteA.id, department: "Kitchen" });
const everyoneDoc = await addDocument(owner.clientId, { title: "Fire safety policy", annual: true });
const readOnlyDoc = await addDocument(owner.clientId, { title: "Menu", requiresAck: false });
const foreignDoc = await addDocument(foreign.clientId, { title: "Foreign policy" });

// ── Manager overview (TrainTrack's Documents tab) ────────────────────────────
const overviewFor = async (who, label) => (await ok(who.request("GET", "/doc-track/acknowledgements/outstanding"), 200, label)).documents;
let overview = await overviewFor(owner, "overview");
assert.deepEqual(overview.map((d) => d.id).sort(), [kitchenDoc, everyoneDoc].sort(), "only documents staff must sign, own business only");
let kitchenRow = overview.find((d) => d.id === kitchenDoc);
assert.deepEqual(kitchenRow.outstanding.map((m) => m.id), [cook.id], "department and site both limit who must sign");
assert.equal(kitchenRow.siteId, siteA.id);
assert.equal(kitchenRow.siteName, "Main kitchen");
assert.deepEqual(overview.find((d) => d.id === everyoneDoc).outstanding.map((m) => m.id).sort(), [cook.id, porter.id, fitter.id].sort(),
  "no department or site: every active member of staff");

// ── A Viewer's own documents (My training) ────────────────────────────────────
const cookViewer = await createUser(owner, { role: "client_viewer", departmentId: kitchen.id });
const unlinked = await ok(cookViewer.request("GET", "/train-track/my-documents"), 200, "unlinked viewer");
assert.deepEqual(unlinked, { rosterLinked: false, pending: [], completed: [] });
await ok(owner.request("PUT", `/users/${cookViewer.userId}`, { staffRosterId: cook.id }), 200, "link the cook's Viewer account");

let mine = await ok(cookViewer.request("GET", "/train-track/my-documents"), 200, "viewer's documents");
assert.equal(mine.rosterLinked, true);
assert.deepEqual(mine.pending.map((d) => d.id).sort(), [kitchenDoc, everyoneDoc].sort());
assert.deepEqual(mine.completed, []);

await ok(owner.request("GET", "/train-track/my-documents"), 403, "owners don't use the Viewer list");
await ok(cookViewer.request("GET", "/doc-track/acknowledgements/outstanding"), 403, "viewer can't see everyone's sign-offs");
await ok(cookViewer.request("GET", `/doc-track/documents/${kitchenDoc}/download-url`), 403, "viewer can't use DocTrack itself");
await ok(cookViewer.request("GET", `/train-track/my-documents/${readOnlyDoc}/download-url`), 404, "not a document to sign");
await ok(cookViewer.request("GET", `/train-track/my-documents/${foreignDoc}/download-url`), 404, "another business's document");

const signature = "data:image/png;base64,iVBORw0KGgo=";
await ok(cookViewer.request("POST", `/train-track/my-documents/${kitchenDoc}/sign`, {}), 400, "signature required");
await ok(cookViewer.request("POST", `/train-track/my-documents/${readOnlyDoc}/sign`, { signature }), 404, "document with no sign-off");
await ok(cookViewer.request("POST", `/train-track/my-documents/${foreignDoc}/sign`, { signature }), 404, "foreign document");
mine = await ok(cookViewer.request("POST", `/train-track/my-documents/${kitchenDoc}/sign`, { signature }), 200, "viewer signs");
assert.deepEqual(mine.pending.map((d) => d.id), [everyoneDoc]);
assert.deepEqual(mine.completed.map((d) => d.id), [kitchenDoc]);
await ok(cookViewer.request("POST", `/train-track/my-documents/${kitchenDoc}/sign`, { signature }), 409, "viewer signs twice");

const records = await pool.query(
  "SELECT record_type, document_title, document_type, signature, site_id, expiry_date FROM train_track_records WHERE client_id = $1 AND staff_roster_id = $2",
  [owner.clientId, cook.id],
);
assert.equal(records.rows.length, 1, "one TrainTrack record written");
assert.equal(records.rows[0].record_type, "signoff");
assert.equal(records.rows[0].document_title, "Kitchen knives risk assessment");
assert.equal(records.rows[0].document_type, "risk_assessment");
assert.equal(records.rows[0].signature, signature);
assert.equal(records.rows[0].site_id, siteA.id);
assert.equal(records.rows[0].expiry_date, null);

const ownRecords = await ok(cookViewer.request("GET", "/train-track/my-records"), 200, "viewer's training records");
assert.ok(ownRecords.records.some((r) => r.document_title === "Kitchen knives risk assessment" && r.signed), "sign-off is in their training record");

overview = await overviewFor(owner, "overview after signing");
kitchenRow = overview.find((d) => d.id === kitchenDoc);
assert.equal(kitchenRow.acknowledgedCount, 1);
assert.deepEqual(kitchenRow.outstanding, [], "signed by everyone who must");

// ── Annual documents: an expired sign-off asks them again ─────────────────────
mine = await ok(cookViewer.request("POST", `/train-track/my-documents/${everyoneDoc}/sign`, { signature }), 200, "viewer signs the annual document");
assert.deepEqual(mine.pending, []);
const annual = await pool.query(
  "SELECT id, expiry_date FROM train_track_records WHERE client_id = $1 AND staff_roster_id = $2 AND document_title = 'Fire safety policy'",
  [owner.clientId, cook.id],
);
assert.ok(annual.rows[0].expiry_date, "annual sign-off expires");
await pool.query("UPDATE train_track_records SET expiry_date = $1 WHERE id = $2", [isoDay(-1), annual.rows[0].id]);
mine = await ok(cookViewer.request("GET", "/train-track/my-documents"), 200, "after the sign-off expired");
assert.deepEqual(mine.pending.map((d) => d.id), [everyoneDoc], "expired: sign again");
mine = await ok(cookViewer.request("POST", `/train-track/my-documents/${everyoneDoc}/sign`, { signature }), 200, "viewer signs again");
assert.deepEqual(mine.pending, []);

// Left the business: nothing to sign.
await ok(owner.request("PATCH", `/staff-roster/${cook.id}`, { active: false }), 200, "cook leaves");
await ok(cookViewer.request("POST", `/train-track/my-documents/${kitchenDoc}/sign`, { signature }), 404, "inactive roster entry");

console.log("doc-sign-offs: all checks passed");
await pool.end();
