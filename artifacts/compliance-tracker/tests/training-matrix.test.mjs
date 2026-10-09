import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = await mkdtemp(path.join(os.tmpdir(), "training-matrix-"));
const outFile = path.join(outDir, "training-matrix.mjs");

try {
  await build({
    entryPoints: [path.join(root, "src/lib/training-matrix.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
  });
  const { buildTrainingMatrix, certificateStatus, trainingMatrixToCsv } = await import(new URL(`file://${outFile}`).href);
const today = new Date(2025, 0, 15, 12);
const certificates = [
  { staff_name: "Current", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-03-01", site_id: 1 },
  { staff_name: "Soon", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-02-14", site_id: 1 },
  { staff_name: "Expired", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-01-14", site_id: 1 },
  { staff_name: "Inactive", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-03-01", site_id: 1 },
  { staff_name: "Elsewhere", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-03-01", site_id: 2 },
];
const staff = [
  { name: "Current", site_id: 1, active: true },
  { name: "Soon", site_id: 1, active: true },
  { name: "Expired", site_id: 1, active: true },
  { name: "Missing", site_id: 1, active: true },
  { name: "Inactive", site_id: 1, active: false },
  { name: "Elsewhere", site_id: 2, active: true },
];
const atSiteOne = buildTrainingMatrix(certificates, staff, "1", today);
const status = (name) => atSiteOne.cells.get(`${name}\u0000First Aid`)?.status;

assert.deepEqual(atSiteOne.staffNames, ["Current", "Expired", "Missing", "Soon"]);
assert.equal(status("Current"), "Current");
assert.equal(status("Soon"), "Expiring Soon");
assert.equal(status("Expired"), "Expired");
assert.equal(status("Missing"), "Missing");
assert.equal(atSiteOne.cells.has("Inactive\u0000First Aid"), false);
assert.equal(certificateStatus("2025-01-15", today), "Expiring Soon");
// Expiry uses local calendar days, inclusive of today and the 30th day.
for (const hour of [0, 12, 23]) {
  const now = new Date(2025, 0, 15, hour, 59);
  assert.equal(certificateStatus("2025-01-14", now), "Expired");
  assert.equal(certificateStatus("2025-01-15", now), "Expiring Soon");
  assert.equal(certificateStatus("2025-02-14", now), "Expiring Soon");
  assert.equal(certificateStatus("2025-02-15", now), "Current");
  assert.equal(certificateStatus(null, now), "Current");
}
// Across the UK daylight-saving change, 30 calendar days remain inclusive.
assert.equal(certificateStatus("2025-04-07", new Date(2025, 2, 8, 23, 59)), "Expiring Soon");
assert.equal(certificateStatus("2025-04-08", new Date(2025, 2, 8, 23, 59)), "Current");

const noExpiryMatrix = buildTrainingMatrix([
  { staff_name: "Current", training_type: "Induction", completed_date: "2025-01-01", expiry_date: null, site_id: 1 },
], staff, "1", today);
assert.deepEqual(noExpiryMatrix.cells.get("Current\u0000Induction"), {
  status: "Current", expiryDate: null,
});
assert.deepEqual(noExpiryMatrix.cells.get("Missing\u0000Induction"), {
  status: "Missing", expiryDate: null,
});
const csv = trainingMatrixToCsv(atSiteOne, date => date);
assert.equal(csv, [
  '"Staff member","First Aid"',
  '"Current","Current (2025-03-01)"',
  '"Expired","Expired (2025-01-14)"',
  '"Missing","Missing"',
  '"Soon","Expiring Soon (2025-02-14)"',
].join("\r\n"));
assert.ok(trainingMatrixToCsv(noExpiryMatrix, date => date).includes('"Current","Current"'));

const atSiteTwo = buildTrainingMatrix(certificates, staff, "2", today);
assert.deepEqual(atSiteTwo.staffNames, ["Elsewhere"]);
assert.equal(atSiteTwo.cells.get("Elsewhere\u0000First Aid")?.status, "Current");

// Select by completion date, not input order, expiry date, staff name alone,
// or training type alone. A newer certificate at another site cannot win.
const history = [
  { staff_name: "Alex", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-01-14", site_id: 1 },
  { staff_name: "Alex", training_type: "First Aid", completed_date: "2025-01-01", expiry_date: "2025-03-01", site_id: 1 },
  { staff_name: "Alex", training_type: "First Aid", completed_date: "2025-01-10", expiry_date: null, site_id: 2 },
  { staff_name: "Alex", training_type: "Food Hygiene", completed_date: "2025-01-05", expiry_date: "2025-02-14", site_id: 1 },
  { staff_name: "Blair", training_type: "First Aid", completed_date: "2025-01-02", expiry_date: "2025-01-14", site_id: 1 },
  { staff_name: "Alex", training_type: "Other site only", completed_date: "2025-01-10", expiry_date: null, site_id: 2 },
];
const historyStaff = [
  { name: "Alex", site_id: 1, active: true },
  { name: "Blair", site_id: 1, active: true },
];
for (const input of [history, [...history].reverse()]) {
  const matrix = buildTrainingMatrix(input, historyStaff, "1", today);
  assert.deepEqual(matrix.types, ["First Aid", "Food Hygiene"]);
  assert.deepEqual(matrix.cells.get("Alex\u0000First Aid"), {
    status: "Current", expiryDate: "2025-03-01",
  });
  assert.equal(matrix.cells.get("Alex\u0000Food Hygiene").status, "Expiring Soon");
  assert.equal(matrix.cells.get("Blair\u0000First Aid").status, "Expired");
  assert.equal(matrix.cells.get("Blair\u0000Food Hygiene").status, "Missing");
  const exported = trainingMatrixToCsv(matrix, date => date);
  assert.equal(exported.split("\r\n").length, 3, "history must not duplicate staff rows");
  assert.ok(exported.includes('"Alex","Current (2025-03-01)","Expiring Soon (2025-02-14)"'));
  assert.ok(!exported.includes("Other site only"));
}
const allSites = buildTrainingMatrix(history, historyStaff, "all", today);
assert.deepEqual(allSites.cells.get("Alex\u0000First Aid"), { status: "Current", expiryDate: null });

const quotedName = 'Smith, "Jo"';
const quotedType = 'Safety, "Advanced"';
const quotedMatrix = buildTrainingMatrix([
  { staff_name: quotedName, training_type: quotedType, completed_date: "2025-01-01", expiry_date: null, site_id: 1 },
], [{ name: quotedName, site_id: 1, active: true }], "1", today);
assert.equal(trainingMatrixToCsv(quotedMatrix, date => date), [
  '"Staff member","Safety, ""Advanced"""',
  '"Smith, ""Jo""","Current"',
].join("\r\n"));

// The matrix only receives the active client's API responses. A second
// tenant's records/roster therefore form a separate matrix and cannot leak
// into the first client's downloaded CSV.
const otherTenant = buildTrainingMatrix(
  [{ staff_name: "Tenant Two", training_type: "Food Hygiene", completed_date: "2024-01-01", expiry_date: null, site_id: 1 }],
  [{ name: "Tenant Two", site_id: 1, active: true }],
  "all",
  today,
);
assert.deepEqual(otherTenant.staffNames, ["Tenant Two"]);
assert.deepEqual(otherTenant.types, ["Food Hygiene"]);
assert.equal(otherTenant.cells.has("Current\u0000First Aid"), false);
console.log("Training matrix regression checks passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}