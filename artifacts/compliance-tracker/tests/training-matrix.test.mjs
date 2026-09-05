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
  const { buildTrainingMatrix, certificateStatus } = await import(new URL(`file://${outFile}`).href);
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

const atSiteTwo = buildTrainingMatrix(certificates, staff, "2", today);
assert.deepEqual(atSiteTwo.staffNames, ["Elsewhere"]);
assert.equal(atSiteTwo.cells.get("Elsewhere\u0000First Aid")?.status, "Current");

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