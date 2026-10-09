// TrainTrack certificates carry an optional roster link (staff_roster_id) so
// the training matrix can tell same-name staff apart. Proves on a freshly
// runtime-migrated database that the link is stored and listed, can be
// changed and cleared, and that a client cannot link a roster id belonging to
// another tenant. Run via run-fresh-schema.sh; never touches application data.

import assert from "node:assert/strict";

const BASE = process.env.API_BASE;
if (!BASE) throw new Error("API_BASE is required and must point at the disposable local test API");
if (process.env.NODE_ENV !== "test") throw new Error("NODE_ENV=test is required");

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
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: response.status, data };
}

function expectStatus(label, response, status) {
  assert.equal(response.status, status, `${label}: status=${response.status} body=${JSON.stringify(response.data)}`);
  return response.data;
}

async function registerTenant(label, stamp) {
  cookie = "";
  const email = `train-roster-${label}-${stamp}@test.local`;
  const password = "password-123";
  const registered = expectStatus(`${label} register`, await request("POST", "/auth/register", {
    name: `Train Roster ${label}`, email, password,
  }), 200);
  expectStatus(`${label} verify`, await request("GET", `/auth/verify-email?token=${encodeURIComponent(registered.verificationToken)}`), 200);
  expectStatus(`${label} login`, await request("POST", "/auth/login", { email, password }), 200);
  const me = expectStatus(`${label} me`, await request("GET", "/auth/me"), 200);
  const site = expectStatus(`${label} site`, await request("POST", "/sites", {
    name: `Train Roster ${label} Site ${stamp}`, seedStarterChecks: false,
  }), 201);
  return { cookie, clientId: (me.user ?? me).clientId, siteId: site.id };
}

const stamp = `${Date.now()}-${process.pid}`;
const completedDate = new Date().toISOString().slice(0, 10);

const foreign = await registerTenant("foreign", stamp);
const foreignStaff = expectStatus("foreign roster", await request("POST", "/staff-roster", {
  name: "Sam Patel", siteId: foreign.siteId,
}), 201);

const own = await registerTenant("own", stamp);
assert.notEqual(own.clientId, foreign.clientId);
const samA = expectStatus("own roster A", await request("POST", "/staff-roster", { name: "Sam Patel", siteId: own.siteId }), 201);
const samB = expectStatus("own roster B", await request("POST", "/staff-roster", { name: "Sam Patel", siteId: own.siteId }), 201);
assert.notEqual(samA.id, samB.id);

const certificate = (staffRosterId, extra = {}) => ({
  recordType: "certificate",
  staffName: "Sam Patel",
  ...(staffRosterId === undefined ? {} : { staffRosterId }),
  trainingType: "Fire Safety Awareness",
  provider: "Roster Identity Training",
  completedDate,
  siteId: own.siteId,
  ...extra,
});

// Linked certificates for two same-name people keep their own identity.
const forA = expectStatus("create linked A", await request("POST", "/train-track/records", certificate(samA.id)), 201);
const forB = expectStatus("create linked B", await request("POST", "/train-track/records", certificate(samB.id)), 201);
assert.equal(forA.staff_roster_id, samA.id);
assert.equal(forB.staff_roster_id, samB.id);

// Legacy-style record without a link stays unlinked (null), not guessed.
const legacy = expectStatus("create unlinked", await request("POST", "/train-track/records", certificate(undefined)), 201);
assert.equal(legacy.staff_roster_id, null);

// Another tenant's roster id is rejected exactly like an unknown one.
const foreignLink = await request("POST", "/train-track/records", certificate(foreignStaff.id));
expectStatus("create with foreign roster id", foreignLink, 400);
assert.equal(foreignLink.data?.error, "Staff member not found");
const unknownLink = await request("POST", "/train-track/records", certificate(2147483000));
expectStatus("create with unknown roster id", unknownLink, 400);
assert.equal(unknownLink.data?.error, foreignLink.data?.error);
expectStatus("create with non-integer roster id", await request("POST", "/train-track/records", certificate("1")), 400);

const listed = expectStatus("list", await request("GET", `/train-track/records?siteId=${own.siteId}`), 200);
const byId = new Map(listed.map(row => [row.id, row]));
assert.equal(byId.get(forA.id)?.staff_roster_id, samA.id);
assert.equal(byId.get(forB.id)?.staff_roster_id, samB.id);
assert.equal(byId.get(legacy.id)?.staff_roster_id, null);
assert.equal(listed.length, 3, "rejected links must not create records");

// Link the legacy record, relink, then clear; a foreign id cannot be patched in.
let updated = expectStatus("link legacy", await request("PATCH", `/train-track/records/${legacy.id}`, { staffRosterId: samB.id }), 200);
assert.equal(updated.staff_roster_id, samB.id);
updated = expectStatus("patch notes keeps link", await request("PATCH", `/train-track/records/${legacy.id}`, { notes: "kept" }), 200);
assert.equal(updated.staff_roster_id, samB.id);
expectStatus("patch foreign link", await request("PATCH", `/train-track/records/${legacy.id}`, { staffRosterId: foreignStaff.id }), 400);
updated = expectStatus("clear link", await request("PATCH", `/train-track/records/${legacy.id}`, { staffRosterId: null }), 200);
assert.equal(updated.staff_roster_id, null);

// The other tenant sees none of these records.
cookie = foreign.cookie;
const foreignList = expectStatus("foreign list", await request("GET", "/train-track/records"), 200);
assert.equal(foreignList.length, 0);
expectStatus("foreign patch", await request("PATCH", `/train-track/records/${forA.id}`, { staffRosterId: foreignStaff.id }), 404);

// Deleting a roster member keeps the certificate (ON DELETE SET NULL).
cookie = own.cookie;
const deleted = await request("DELETE", `/staff-roster/${samA.id}`);
assert.ok([200, 204].includes(deleted.status), `roster delete: ${deleted.status} ${JSON.stringify(deleted.data)}`);
const afterDelete = expectStatus("list after roster delete", await request("GET", "/train-track/records"), 200);
const keptA = afterDelete.find(row => row.id === forA.id);
assert.ok(keptA, "certificate must survive roster changes");
const stillLinked = keptA.staff_roster_id === samA.id;
const roster = expectStatus("roster incl inactive", await request("GET", "/staff-roster?includeInactive=true"), 200);
const samAStillExists = roster.some(row => row.id === samA.id);
assert.ok(stillLinked === samAStillExists && (stillLinked || keptA.staff_roster_id === null),
  "a certificate keeps its link while the roster row exists and is unlinked only if it is removed");

console.log("TrainTrack roster identity checks passed.");
