// Endpoint coverage for the public, tenant-wide staff sign-off link
// (src/routes/sign-off.ts). The link lists, downloads and acknowledges
// documents from four sources (DocTrack plus SafeTrack risk assessments, SOPs
// and handbook entries). Each staff member's department is derived on the
// server from their roster row; a request can only name a staff member, a
// document type and a document id. Proves that:
//   - another client's staff and documents are refused for list, download and
//     acknowledgement, and another department's documents likewise;
//   - direct department scope, site-derived department scope (direct wins) and
//     global documents reach exactly the right staff;
//   - DocTrack and SafeTrack rows sharing one numeric id stay distinct;
//   - concurrent duplicate SafeTrack acknowledgements create one row;
//   - fileless SOP/handbook content and attachments without a file name work.
// Run via run-sign-off-access.sh, which boots the API with a tenant-owned
// test object store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required; use run-sign-off-access.sh");
if (process.env.NODE_ENV !== "test") throw new Error("NODE_ENV=test is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const execFile = promisify(execFileCallback);

// ── Database fixtures ─────────────────────────────────────────────────────────

const lit = (value) => value === null || value === undefined
  ? "NULL"
  : typeof value === "number" ? String(Number(value))
  : typeof value === "boolean" ? String(value)
  : `'${String(value).replace(/'/g, "''")}'`;

async function query(text) {
  const { stdout } = await execFile("psql", [
    process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c",
    `WITH q AS (${text}) SELECT COALESCE(json_agg(q), '[]'::json) FROM q`,
  ]);
  return JSON.parse(stdout.trim());
}

async function insertRow(table, values) {
  const columns = Object.keys(values);
  const [row] = await query(`INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${columns.map((column) => lit(values[column])).join(", ")}) RETURNING id`);
  return row.id;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

let forwardedFor = 0;
async function send(method, path, { body, cookie } = {}) {
  // Every public request appears to come from a new address so the per-IP
  // public-link limit never trips; the per-token limit is handled by rotation.
  forwardedFor++;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": `10.${(forwardedFor >> 16) & 255}.${(forwardedFor >> 8) & 255}.${forwardedFor & 255}`,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: response.status, data, setCookie: response.headers.get("set-cookie") };
}

function expectStatus(label, response, status) {
  assert.equal(response.status, status, `${label}: status=${response.status} body=${JSON.stringify(response.data)}`);
  return response.data;
}

// The runner restarts the API between the two phases on one database, so the
// second phase reuses the first phase's stamp (and so its accounts).
const STATE_FILE = process.env.SIGN_OFF_STATE_FILE;
const phase = process.argv[2] ?? "main";
if (!["main", "after-restart"].includes(phase)) throw new Error(`Unknown phase ${phase}`);
const savedState = phase === "after-restart" ? JSON.parse(await readFile(STATE_FILE, "utf8")) : null;
const stamp = savedState?.stamp ?? `${Date.now()}-${process.pid}`;

async function openTenant(label, { register = true } = {}) {
  let cookie = "";
  const as = async (method, path, body) => {
    const response = await send(method, path, { body, cookie });
    if (response.setCookie) cookie = response.setCookie.split(";")[0];
    return response;
  };
  const email = `sign-off-${label.toLowerCase()}-${stamp}@test.local`;
  const password = "password-123";
  if (register) {
    const registered = expectStatus(`${label} register`, await as("POST", "/auth/register", {
      name: `Sign-off ${label}`, email, password,
    }), 200);
    expectStatus(`${label} verify`, await as("GET", `/auth/verify-email?token=${encodeURIComponent(registered.verificationToken)}`), 200);
  }
  expectStatus(`${label} login`, await as("POST", "/auth/login", { email, password }), 200);
  const me = expectStatus(`${label} me`, await as("GET", "/auth/me"), 200);
  const clientId = (me.user ?? me).clientId;
  assert.ok(Number.isInteger(clientId), `${label} has a client`);

  // The public link allows 60 requests a minute per token; a fresh token from
  // the manager endpoint starts a fresh budget (and revokes the old one).
  let token = "";
  let uses = 0;
  const rotate = async () => {
    token = expectStatus(`${label} sign-off link`, await as("POST", "/doc-track/sign-off-info"), 201).token;
    uses = 0;
  };
  await rotate();
  const pub = async (method, path, body) => {
    if (++uses > 50) { await rotate(); uses = 1; }
    return send(method, `/sign-off/${encodeURIComponent(token)}${path}`, { body });
  };
  // Reserve a burst of public requests on the current token (concurrency checks).
  const reserve = async (count) => { if (uses + count > 50) await rotate(); };
  return { label, as, clientId, pub, reserve };
}

async function addStaff(tenant, name, department) {
  return expectStatus(`${tenant.label} staff ${name}`, await tenant.as("POST", "/staff-roster", {
    name, department, email: `sign-off-${name.toLowerCase().replace(/\W+/g, "-")}-${stamp}@test.local`,
  }), 201).id;
}

const objectPath = (tenant, slug) => `/objects/uploads/tenant-${tenant.clientId}/sign-off-${slug}-${stamp}.pdf`;

// One document fixture: `type` is the public document type, `values` the
// table columns besides client_id and the acknowledgement flag.
async function addDocument(tenant, type, values, { id, requiresAcknowledgement = true } = {}) {
  const table = { doc: "doc_track_documents", ra: "safe_risk_assessments", sop: "safe_sops", handbook: "safe_handbook" }[type];
  const row = { ...(id ? { id } : {}), client_id: tenant.clientId, requires_acknowledgement: requiresAcknowledgement, ...values };
  if (type === "doc") row.category ??= "policy";
  return { type, id: await insertRow(table, row), title: values.title, objectPath: values.object_path ?? null, fileName: values.file_name ?? null };
}

// ── Public-link helpers ───────────────────────────────────────────────────────

const key = (doc) => `${doc.type}:${doc.id}`;

async function listFor(tenant, staffId, extraQuery = "") {
  const rows = expectStatus(`${tenant.label} list for staff ${staffId}`,
    await tenant.pub("GET", `/documents?staffId=${staffId}${extraQuery}`), 200);
  return new Map(rows.map((row) => [`${row.document_type}:${row.id}`, row]));
}

const download = (tenant, staffId, doc, type = doc.type) =>
  tenant.pub("GET", `/documents/${doc.id}/download?staffId=${staffId}${type === undefined ? "" : `&documentType=${type}`}`);

const acknowledge = (tenant, staffId, doc, type = doc.type) =>
  tenant.pub("POST", "/acknowledge", { documentType: type, documentId: doc.id, staffRosterId: staffId, typedName: "Signed in test" });

async function ackRows(clientId, doc, staffId) {
  return doc.type === "doc"
    ? query(`SELECT id FROM doc_acknowledgements WHERE client_id = ${lit(clientId)} AND document_id = ${lit(doc.id)} AND staff_roster_id = ${lit(staffId)}`)
    : query(`SELECT id FROM safe_track_acknowledgements WHERE client_id = ${lit(clientId)} AND document_type = ${lit(doc.type)}
        AND document_id = ${lit(doc.id)} AND staff_roster_id = ${lit(staffId)}`);
}

// A granted download names the document's own object: the issued URL's token
// row (stored as a digest) points at exactly that path, for the right tenant.
async function expectDownloadOf(label, response, tenant, doc) {
  const body = expectStatus(label, response, 200);
  assert.equal(body.fileName, doc.fileName, `${label}: file name`);
  const raw = /\/api\/storage\/download\/([A-Za-z0-9_-]+)$/.exec(body.downloadUrl ?? "")?.[1];
  assert.ok(raw, `${label}: download URL shape ${body.downloadUrl}`);
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  const [token] = await query(`SELECT client_id, object_path FROM storage_download_tokens WHERE token_digest = ${lit(digest)}`);
  assert.deepEqual(token, { client_id: tenant.clientId, object_path: doc.objectPath }, `${label}: token names the document's object`);
}

async function expectRefused(label, tenant, staffId, doc, { listStatus = 200 } = {}) {
  if (listStatus === 200) {
    assert.equal((await listFor(tenant, staffId)).has(key(doc)), false, `${label}: not listed`);
  }
  const before = (await ackRows(tenant.clientId, doc, staffId)).length;
  const trainBefore = await query(`SELECT id FROM train_track_records WHERE client_id = ${lit(tenant.clientId)}`);
  const dl = await download(tenant, staffId, doc);
  expectStatus(`${label}: download`, dl, 404);
  assert.equal(dl.data?.downloadUrl, undefined, `${label}: no download URL`);
  const ack = await acknowledge(tenant, staffId, doc);
  expectStatus(`${label}: acknowledge`, ack, 404);
  assert.equal((await ackRows(tenant.clientId, doc, staffId)).length, before, `${label}: no acknowledgement row`);
  assert.equal((await query(`SELECT id FROM train_track_records WHERE client_id = ${lit(tenant.clientId)}`)).length,
    trainBefore.length, `${label}: no TrainTrack sign-off record`);
}

// ── After a restart: SafeTrack → DocTrack copies keep their scope ────────────

// Every API start copies SafeTrack documents not yet copied into DocTrack
// (migrateDoctrackSafetrackMerge). A copy must carry its source's effective
// department, or a department-scoped document becomes visible to every staff
// member as a global DocTrack document.
if (phase === "after-restart") {
  const alpha = await openTenant("Alpha", { register: false });
  const { staff, safeDocs } = savedState;
  const copies = new Map();
  for (const doc of safeDocs) {
    const table = { ra: "safe_risk_assessments", sop: "safe_sops", handbook: "safe_handbook" }[doc.type];
    const [copy] = await query(`SELECT c.id, c.department, c.title, c.requires_acknowledgement FROM ${table} s
      JOIN doc_track_documents c ON c.id = s.migrated_doc_id AND c.client_id = s.client_id
      WHERE s.id = ${lit(doc.id)} AND s.client_id = ${lit(alpha.clientId)}`);
    assert.ok(copy, `${doc.type}:${doc.id} was copied into DocTrack on restart`);
    assert.equal(copy.title, doc.title, `${doc.type}:${doc.id} copy title`);
    assert.equal(copy.department, doc.department, `${doc.type}:${doc.id} (${doc.title}) copy keeps department ${doc.department}`);
    copies.set(copy.id, doc);
  }
  for (const [name, staffId] of Object.entries(staff)) {
    const listed = await listFor(alpha, staffId);
    for (const [copyId, source] of copies) {
      assert.equal(listed.has(`doc:${copyId}`), listed.has(`${source.type}:${source.id}`),
        `${name}: DocTrack copy of ${source.title} is listed exactly when the source is`);
    }
  }
  console.log("sign-off access tests passed (after restart)");
  process.exit(0);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const alpha = await openTenant("Alpha");
const bravo = await openTenant("Bravo");
assert.notEqual(alpha.clientId, bravo.clientId);

const department = async (tenant, name) => insertRow("departments", { client_id: tenant.clientId, name });
const kitchenDept = await department(alpha, "Kitchen");
const housekeepingDept = await department(alpha, "Housekeeping");
const site = async (tenant, name, departmentId) => insertRow("sites", {
  client_id: tenant.clientId, name: `${name} ${stamp}`, department_id: departmentId,
});
const kitchenSite = await site(alpha, "Alpha kitchen site", kitchenDept);
const housekeepingSite = await site(alpha, "Alpha housekeeping site", housekeepingDept);
const sharedSite = await site(alpha, "Alpha shared site", null);

const kim = await addStaff(alpha, "Kim Kitchen", "Kitchen");
const hal = await addStaff(alpha, "Hal Housekeeping", "Housekeeping");
const nia = await addStaff(alpha, "Nia No Department", null);
const leaver = await addStaff(alpha, "Lee Leaver", "Kitchen");
expectStatus("deactivate leaver", await alpha.as("PATCH", `/staff-roster/${leaver}`, { active: false }), 200);

const file = (tenant, slug, fileName = `${slug}.pdf`) => ({
  object_path: objectPath(tenant, slug), file_name: fileName, mime_type: "application/pdf",
});

const docs = {
  // DocTrack: text department, or NULL for everyone.
  docKitchen: await addDocument(alpha, "doc", { title: "Kitchen allergen policy", department: "Kitchen", ...file(alpha, "doc-kitchen") }),
  docHousekeeping: await addDocument(alpha, "doc", { title: "Housekeeping chemicals policy", department: "Housekeeping", ...file(alpha, "doc-housekeeping") }),
  docGlobal: await addDocument(alpha, "doc", { title: "Fire evacuation policy", department: null, ...file(alpha, "doc-global") }),
  docOptional: await addDocument(alpha, "doc", { title: "Optional reading", department: null, ...file(alpha, "doc-optional") },
    { requiresAcknowledgement: false }),
  // Risk assessments: direct department, site-derived department, direct
  // department overriding the site's, and global.
  raDirectKitchen: await addDocument(alpha, "ra", { title: "Knife handling RA", department_id: kitchenDept, ...file(alpha, "ra-direct-kitchen") }),
  raSiteHousekeeping: await addDocument(alpha, "ra", { title: "Linen trolley RA", site_id: housekeepingSite, ...file(alpha, "ra-site-housekeeping") }),
  raDirectOverSite: await addDocument(alpha, "ra", {
    title: "Kitchen deliveries RA", department_id: kitchenDept, site_id: housekeepingSite, ...file(alpha, "ra-direct-over-site"),
  }),
  raGlobal: await addDocument(alpha, "ra", { title: "Slips and trips RA", site_id: sharedSite, ...file(alpha, "ra-global") }),
  // SOPs: fileless content scoped by site, a direct Housekeeping scope, global.
  sopSiteKitchenFileless: await addDocument(alpha, "sop", {
    title: "Kitchen close-down SOP", site_id: kitchenSite, content: "Switch off fryers, then log fridge temperatures.",
  }),
  sopDirectHousekeeping: await addDocument(alpha, "sop", { title: "Room turn SOP", department_id: housekeepingDept, ...file(alpha, "sop-direct-housekeeping") }),
  sopGlobal: await addDocument(alpha, "sop", { title: "Lone working SOP", ...file(alpha, "sop-global") }),
  // Handbook entries have no direct department, only a site's.
  handbookSiteHousekeeping: await addDocument(alpha, "handbook", { title: "Housekeeping handbook", site_id: housekeepingSite, ...file(alpha, "handbook-site-housekeeping") }),
  handbookSiteKitchen: await addDocument(alpha, "handbook", { title: "Kitchen handbook", site_id: kitchenSite, ...file(alpha, "handbook-site-kitchen") }),
  handbookGlobalFileless: await addDocument(alpha, "handbook", { title: "Staff code of conduct", content: "Be kind, be safe, be on time." }),
  handbookNoFileName: await addDocument(alpha, "handbook", {
    title: "Uniform guide", object_path: objectPath(alpha, "handbook-no-file-name"), file_name: null, mime_type: null,
  }),
};

// The SafeTrack manager route stores department-scoped SOPs the same way.
const routeSop = expectStatus("SafeTrack SOP via manager route", await alpha.as("POST", "/safe-track/sops", {
  title: "Hand washing SOP", content: "Wash for twenty seconds.", departmentId: kitchenDept, requiresAcknowledgement: true,
}), 201);
docs.sopRouteKitchenFileless = { type: "sop", id: routeSop.id, title: routeSop.title, objectPath: null, fileName: null };

// One id shared by a DocTrack document and all three SafeTrack tables, each
// visible to everyone and each with its own file. The id is above every
// existing row and sequence so it is new in all four tables.
const [{ next: sharedId }] = await query(`SELECT GREATEST(
    (SELECT last_value FROM doc_track_documents_id_seq), (SELECT last_value FROM safe_risk_assessments_id_seq),
    (SELECT last_value FROM safe_sops_id_seq), (SELECT last_value FROM safe_handbook_id_seq),
    (SELECT COALESCE(MAX(id), 0) FROM doc_track_documents), (SELECT COALESCE(MAX(id), 0) FROM safe_risk_assessments),
    (SELECT COALESCE(MAX(id), 0) FROM safe_sops), (SELECT COALESCE(MAX(id), 0) FROM safe_handbook)
  ) + 1000 AS next`);
const shared = {};
for (const type of ["doc", "ra", "sop", "handbook"]) {
  shared[type] = await addDocument(alpha, type, { title: `Shared id ${type} document`, ...file(alpha, `shared-${type}`) }, { id: sharedId });
  assert.equal(shared[type].id, sharedId);
}
// Keep later serial inserts (other suites, other runs) clear of the shared id.
for (const table of ["doc_track_documents", "safe_risk_assessments", "safe_sops", "safe_handbook"]) {
  await query(`SELECT setval('${table}_id_seq', GREATEST((SELECT last_value FROM ${table}_id_seq), ${lit(sharedId)})) AS v`);
}

const bob = await addStaff(bravo, "Bob Bravo", "Kitchen");
const bravoDocs = {
  doc: await addDocument(bravo, "doc", { title: "Bravo policy", department: null, ...file(bravo, "bravo-doc") }),
  ra: await addDocument(bravo, "ra", { title: "Bravo RA", ...file(bravo, "bravo-ra") }),
  sop: await addDocument(bravo, "sop", { title: "Bravo SOP", ...file(bravo, "bravo-sop") }),
  handbook: await addDocument(bravo, "handbook", { title: "Bravo handbook", ...file(bravo, "bravo-handbook") }),
};

// ── Department scope: who sees what ───────────────────────────────────────────

const sharedKeys = Object.values(shared).map(key);
const everyone = [docs.docGlobal, docs.raGlobal, docs.sopGlobal, docs.handbookGlobalFileless, docs.handbookNoFileName].map(key);
const expectedFor = {
  [kim]: [...everyone, ...sharedKeys, ...[docs.docKitchen, docs.raDirectKitchen, docs.raDirectOverSite,
    docs.sopSiteKitchenFileless, docs.sopRouteKitchenFileless, docs.handbookSiteKitchen].map(key)],
  [hal]: [...everyone, ...sharedKeys, ...[docs.docHousekeeping, docs.raSiteHousekeeping,
    docs.sopDirectHousekeeping, docs.handbookSiteHousekeeping].map(key)],
  [nia]: [...everyone, ...sharedKeys],
};
for (const [staffId, expected] of Object.entries(expectedFor)) {
  const listed = await listFor(alpha, staffId);
  assert.deepEqual([...listed.keys()].sort(), [...expected].sort(), `staff ${staffId} sees exactly their documents`);
}
{
  const listed = await listFor(alpha, hal);
  assert.equal(listed.get(key(docs.raSiteHousekeeping)).department, "Housekeeping", "site-derived department is reported");
  assert.equal(listed.get(key(docs.sopDirectHousekeeping)).department, "Housekeeping", "direct department is reported");
  assert.equal(listed.get(key(docs.raGlobal)).department, null, "a shared site's document is global");
  const kitchenView = await listFor(alpha, kim);
  assert.equal(kitchenView.get(key(docs.raDirectOverSite)).department, "Kitchen", "direct department wins over the site's");
}

// A department in the query string is ignored: the roster row decides.
{
  const listed = await listFor(alpha, hal, "&department=Kitchen");
  assert.deepEqual([...listed.keys()].sort(), [...expectedFor[hal]].sort(), "department query parameter is not trusted");
}

// Granted downloads for each scope rule return that document's own file.
await expectDownloadOf("Kitchen staff downloads direct-scope RA", await download(alpha, kim, docs.raDirectKitchen), alpha, docs.raDirectKitchen);
await expectDownloadOf("Kitchen staff downloads direct-over-site RA", await download(alpha, kim, docs.raDirectOverSite), alpha, docs.raDirectOverSite);
await expectDownloadOf("Housekeeping staff downloads site-scope RA", await download(alpha, hal, docs.raSiteHousekeeping), alpha, docs.raSiteHousekeeping);
await expectDownloadOf("Housekeeping staff downloads site-scope handbook", await download(alpha, hal, docs.handbookSiteHousekeeping), alpha, docs.handbookSiteHousekeeping);
await expectDownloadOf("Kitchen staff downloads DocTrack department document", await download(alpha, kim, docs.docKitchen), alpha, docs.docKitchen);
await expectDownloadOf("No-department staff downloads global SOP", await download(alpha, nia, docs.sopGlobal), alpha, docs.sopGlobal);

// ── Cross-department denials ──────────────────────────────────────────────────

await expectRefused("Kitchen staff, Housekeeping DocTrack document", alpha, kim, docs.docHousekeeping);
await expectRefused("Kitchen staff, site-scoped Housekeeping RA", alpha, kim, docs.raSiteHousekeeping);
await expectRefused("Kitchen staff, direct Housekeeping SOP", alpha, kim, docs.sopDirectHousekeeping);
await expectRefused("Kitchen staff, Housekeeping handbook", alpha, kim, docs.handbookSiteHousekeeping);
await expectRefused("Housekeeping staff, direct Kitchen RA", alpha, hal, docs.raDirectKitchen);
await expectRefused("Housekeeping staff, direct Kitchen RA on a Housekeeping site", alpha, hal, docs.raDirectOverSite);
await expectRefused("Housekeeping staff, Kitchen SOP from the manager route", alpha, hal, docs.sopRouteKitchenFileless);
await expectRefused("Housekeeping staff, site-scoped Kitchen SOP", alpha, hal, docs.sopSiteKitchenFileless);
await expectRefused("No-department staff, Kitchen DocTrack document", alpha, nia, docs.docKitchen);
await expectRefused("No-department staff, site-scoped Kitchen handbook", alpha, nia, docs.handbookSiteKitchen);
await expectRefused("Optional DocTrack document", alpha, kim, docs.docOptional);

// A deactivated staff member's sign-off is refused outright.
expectStatus("leaver list", await alpha.pub("GET", `/documents?staffId=${leaver}`), 404);
await expectRefused("Leaver, Kitchen RA", alpha, leaver, docs.raDirectKitchen, { listStatus: 404 });

// ── Cross-client denials ──────────────────────────────────────────────────────

// Alpha's link with Bravo's staff member.
expectStatus("Alpha link, Bravo staff list", await alpha.pub("GET", `/documents?staffId=${bob}`), 404);
for (const doc of Object.values(bravoDocs)) {
  await expectRefused(`Alpha link, Bravo staff, Bravo ${doc.type}`, alpha, bob, doc, { listStatus: 404 });
  // Alpha's link with Alpha's staff and Bravo's document.
  await expectRefused(`Alpha link, Alpha staff, Bravo ${doc.type}`, alpha, kim, doc);
  // Bravo's own link still works for its own staff and documents.
  await expectDownloadOf(`Bravo link downloads its own ${doc.type}`, await download(bravo, bob, doc), bravo, doc);
}
expectStatus("Bravo link, Alpha staff list", await bravo.pub("GET", `/documents?staffId=${kim}`), 404);
await expectRefused("Bravo link, Alpha staff, Alpha shared SOP", bravo, kim, shared.sop, { listStatus: 404 });
await expectRefused("Bravo link, Bravo staff, Alpha shared RA", bravo, bob, shared.ra);
{
  const bravoView = await listFor(bravo, bob);
  assert.deepEqual([...bravoView.keys()].sort(), Object.values(bravoDocs).map(key).sort(), "Bravo lists only its own documents");
}
expectStatus("staff list stays tenant-scoped", await alpha.pub("GET", "/staff"), 200)
  .forEach((member) => assert.notEqual(member.id, bob, "Bravo staff not offered on Alpha's link"));

// ── Colliding DocTrack / SafeTrack ids ────────────────────────────────────────

for (const type of ["doc", "ra", "sop", "handbook"]) {
  await expectDownloadOf(`shared id downloads the ${type} file`, await download(alpha, kim, shared[type]), alpha, shared[type]);
}
await expectDownloadOf("shared id without a type is the DocTrack document",
  await download(alpha, kim, shared.doc, undefined), alpha, shared.doc);

expectStatus("acknowledge shared-id SOP", await acknowledge(alpha, kim, shared.sop), 201);
{
  const listed = await listFor(alpha, kim);
  assert.equal(listed.get(key(shared.sop)).signed, true, "SOP with the shared id is signed");
  for (const type of ["doc", "ra", "handbook"]) {
    assert.equal(listed.get(key(shared[type])).signed, false, `${type} with the shared id is still unsigned`);
  }
  assert.equal((await ackRows(alpha.clientId, shared.doc, kim)).length, 0, "no DocTrack acknowledgement for the SOP");
  assert.equal((await ackRows(alpha.clientId, shared.ra, kim)).length, 0, "no RA acknowledgement for the SOP");
}
expectStatus("acknowledge shared-id DocTrack document", await acknowledge(alpha, kim, shared.doc), 201);
{
  const listed = await listFor(alpha, kim);
  assert.equal(listed.get(key(shared.doc)).signed, true, "DocTrack document with the shared id is signed");
  assert.equal(listed.get(key(shared.ra)).signed, false, "RA with the shared id is still unsigned");
  assert.equal(listed.get(key(shared.handbook)).signed, false, "handbook with the shared id is still unsigned");
  const [train] = await query(`SELECT document_title FROM train_track_records WHERE client_id = ${lit(alpha.clientId)}
    AND staff_name = 'Kim Kitchen' AND record_type = 'signoff'`);
  assert.equal(train?.document_title, shared.doc.title, "TrainTrack records the DocTrack document's title");
}
// The shared id signed by one staff member is not signed for another.
assert.equal((await listFor(alpha, hal)).get(key(shared.sop)).signed, false, "another staff member's view is unaffected");

// ── Concurrent duplicate SafeTrack acknowledgements ───────────────────────────

for (const doc of [docs.raGlobal, docs.sopGlobal, docs.handbookGlobalFileless, docs.raDirectKitchen]) {
  const burst = 12;
  await alpha.reserve(burst);
  const responses = await Promise.all(Array.from({ length: burst }, () => acknowledge(alpha, kim, doc)));
  const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [...Array(burst - 1).fill(200), 201], `${key(doc)}: one created, the rest already signed (${statuses})`);
  for (const response of responses.filter((r) => r.status === 200)) {
    assert.deepEqual(response.data, { alreadySigned: true }, `${key(doc)}: duplicate reports already signed`);
  }
  assert.equal((await ackRows(alpha.clientId, doc, kim)).length, 1, `${key(doc)}: exactly one acknowledgement row`);
  // A later, sequential repeat is idempotent too.
  expectStatus(`${key(doc)}: repeat`, await acknowledge(alpha, kim, doc), 200);
  assert.equal((await ackRows(alpha.clientId, doc, kim)).length, 1, `${key(doc)}: still one row after repeat`);
}
// A double tap on a DocTrack document records one acknowledgement and one
// TrainTrack sign-off.
{
  const burst = 8;
  await alpha.reserve(burst);
  const responses = await Promise.all(Array.from({ length: burst }, () => acknowledge(alpha, kim, docs.docGlobal)));
  const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [...Array(burst - 1).fill(200), 201], `doc:${docs.docGlobal.id}: one created (${statuses})`);
  assert.equal((await ackRows(alpha.clientId, docs.docGlobal, kim)).length, 1, "one DocTrack acknowledgement row");
  const train = await query(`SELECT id FROM train_track_records WHERE client_id = ${lit(alpha.clientId)}
    AND staff_name = 'Kim Kitchen' AND document_title = ${lit(docs.docGlobal.title)}`);
  assert.equal(train.length, 1, "one TrainTrack sign-off record");
}
// Concurrent acknowledgements by different staff each create their own row.
{
  await alpha.reserve(2);
  const [forHal, forNia] = await Promise.all([acknowledge(alpha, hal, docs.raGlobal), acknowledge(alpha, nia, docs.raGlobal)]);
  expectStatus("Hal signs global RA alongside Nia", forHal, 201);
  expectStatus("Nia signs global RA alongside Hal", forNia, 201);
  const [{ count }] = await query(`SELECT count(*)::int AS count FROM safe_track_acknowledgements
    WHERE document_type = 'ra' AND document_id = ${lit(docs.raGlobal.id)}`);
  assert.equal(count, 3, "one row per staff member for the global RA");
}

// ── Fileless content and attachments without a file name ──────────────────────

{
  const listed = await listFor(alpha, kim);
  for (const doc of [docs.sopSiteKitchenFileless, docs.sopRouteKitchenFileless, docs.handbookGlobalFileless]) {
    const row = listed.get(key(doc));
    assert.equal(row.has_file, false, `${key(doc)}: no file`);
    assert.equal(row.file_name, null, `${key(doc)}: no file name`);
    assert.ok(typeof row.description === "string" && row.description.length > 0, `${key(doc)}: content shown as the description`);
  }
  assert.equal(listed.get(key(docs.sopSiteKitchenFileless)).description, "Switch off fryers, then log fridge temperatures.");
  const noName = listed.get(key(docs.handbookNoFileName));
  assert.equal(noName.has_file, true, "attachment without a file name still has a file");
  assert.equal(noName.file_name, null, "attachment without a file name lists a null name");
}
for (const doc of [docs.sopSiteKitchenFileless, docs.sopRouteKitchenFileless, docs.handbookGlobalFileless]) {
  const dl = await download(alpha, kim, doc);
  expectStatus(`${key(doc)}: fileless download`, dl, 404);
  assert.equal(dl.data?.error, "No file attached", `${key(doc)}: fileless download reason`);
}
await expectDownloadOf("attachment without a file name downloads", await download(alpha, kim, docs.handbookNoFileName), alpha, docs.handbookNoFileName);
for (const doc of [docs.sopSiteKitchenFileless, docs.sopRouteKitchenFileless, docs.handbookNoFileName]) {
  expectStatus(`${key(doc)}: acknowledge`, await acknowledge(alpha, kim, doc), 201);
  assert.equal((await listFor(alpha, kim)).get(key(doc)).signed, true, `${key(doc)}: signed after acknowledgement`);
}

// ── Malformed requests ────────────────────────────────────────────────────────

expectStatus("list without staff", await alpha.pub("GET", "/documents"), 400);
expectStatus("download without staff", await alpha.pub("GET", `/documents/${docs.raGlobal.id}/download?documentType=ra`), 400);
expectStatus("download with unknown type", await alpha.pub("GET", `/documents/${docs.raGlobal.id}/download?staffId=${kim}&documentType=incident`), 400);
expectStatus("acknowledge with unknown type", await alpha.pub("POST", "/acknowledge", {
  documentType: "incident", documentId: docs.raGlobal.id, staffRosterId: kim, typedName: "Kim",
}), 400);
expectStatus("acknowledge without a signature", await alpha.pub("POST", "/acknowledge", {
  documentType: "ra", documentId: docs.raGlobal.id, staffRosterId: hal, typedName: "  ",
}), 400);
expectStatus("unknown link", await send("GET", "/sign-off/not-a-real-sign-off-token/info"), 404);

// Hand the SafeTrack fixtures and their effective departments to the
// after-restart phase.
if (STATE_FILE) {
  const departmentOf = {
    raDirectKitchen: "Kitchen", raSiteHousekeeping: "Housekeeping", raDirectOverSite: "Kitchen", raGlobal: null,
    sopSiteKitchenFileless: "Kitchen", sopDirectHousekeeping: "Housekeeping", sopGlobal: null, sopRouteKitchenFileless: "Kitchen",
    handbookSiteHousekeeping: "Housekeeping", handbookSiteKitchen: "Kitchen", handbookGlobalFileless: null, handbookNoFileName: null,
  };
  const safeDocs = Object.entries(departmentOf).map(([name, department]) => ({ ...docs[name], department }));
  await writeFile(STATE_FILE, JSON.stringify({ stamp, staff: { kim, hal, nia }, safeDocs }));
}

console.log("sign-off access tests passed");
