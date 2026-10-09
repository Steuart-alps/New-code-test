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
  const { buildTrainingMatrix, certificateStatus, trainingMatrixToCsv, matrixCellKey } =
    await import(new URL(`file://${outFile}`).href);

  // Look a cell up by the row's CSV label (unique within one matrix).
  const cellOf = (matrix, label, type) => {
    const rows = matrix.rows.filter(row => row.label === label);
    assert.equal(rows.length, 1, `expected exactly one row labelled ${label}`);
    return matrix.cells.get(matrixCellKey(rows[0], type));
  };
  const labels = matrix => matrix.rows.map(row => row.label);

  const today = new Date(2025, 0, 15, 12);
  const certificates = [
    { staff_name: "Current", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-03-01", site_id: 1 },
    { staff_name: "Soon", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-02-14", site_id: 1 },
    { staff_name: "Expired", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-01-14", site_id: 1 },
    { staff_name: "Inactive", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-03-01", site_id: 1 },
    { staff_name: "Elsewhere", training_type: "First Aid", completed_date: "2024-01-01", expiry_date: "2025-03-01", site_id: 2 },
  ];
  const staff = [
    { id: 1, name: "Current", site_id: 1, active: true },
    { id: 2, name: "Soon", site_id: 1, active: true },
    { id: 3, name: "Expired", site_id: 1, active: true },
    { id: 4, name: "Missing", site_id: 1, active: true },
    { id: 5, name: "Inactive", site_id: 1, active: false },
    { id: 6, name: "Elsewhere", site_id: 2, active: true },
  ];
  const atSiteOne = buildTrainingMatrix(certificates, staff, "1", today);
  const status = (name) => cellOf(atSiteOne, name, "First Aid")?.status;

  assert.deepEqual(labels(atSiteOne), ["Current", "Expired", "Missing", "Soon"]);
  assert.equal(status("Current"), "Current");
  assert.equal(status("Soon"), "Expiring Soon");
  assert.equal(status("Expired"), "Expired");
  assert.equal(status("Missing"), "Missing");
  assert.equal(atSiteOne.rows.some(row => row.name === "Inactive"), false);
  // The inactive person's legacy record has no active owner and is reported.
  assert.deepEqual(atSiteOne.unmatchedCertificates.map(r => r.staff_name), ["Inactive"]);
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
  assert.deepEqual(cellOf(noExpiryMatrix, "Current", "Induction"), { status: "Current", expiryDate: null });
  assert.deepEqual(cellOf(noExpiryMatrix, "Missing", "Induction"), { status: "Missing", expiryDate: null });
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
  assert.deepEqual(labels(atSiteTwo), ["Elsewhere"]);
  assert.equal(cellOf(atSiteTwo, "Elsewhere", "First Aid")?.status, "Current");

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
    { id: 11, name: "Alex", site_id: 1, active: true },
    { id: 12, name: "Blair", site_id: 1, active: true },
  ];
  for (const input of [history, [...history].reverse()]) {
    const matrix = buildTrainingMatrix(input, historyStaff, "1", today);
    assert.deepEqual(matrix.types, ["First Aid", "Food Hygiene"]);
    assert.deepEqual(cellOf(matrix, "Alex", "First Aid"), { status: "Current", expiryDate: "2025-03-01" });
    assert.equal(cellOf(matrix, "Alex", "Food Hygiene").status, "Expiring Soon");
    assert.equal(cellOf(matrix, "Blair", "First Aid").status, "Expired");
    assert.equal(cellOf(matrix, "Blair", "Food Hygiene").status, "Missing");
    const exported = trainingMatrixToCsv(matrix, date => date);
    assert.equal(exported.split("\r\n").length, 3, "history must not duplicate staff rows");
    assert.ok(exported.includes('"Alex","Current (2025-03-01)","Expiring Soon (2025-02-14)"'));
    assert.ok(!exported.includes("Other site only"));
  }
  const allSites = buildTrainingMatrix(history, historyStaff, "all", today);
  assert.deepEqual(cellOf(allSites, "Alex", "First Aid"), { status: "Current", expiryDate: null });

  // ── Stable identity ──────────────────────────────────────────────────────
  // Two "Sam Patel"s at site 1 and a third at site 2. Linked certificates
  // follow the roster id, never the shared name.
  const sameNameStaff = [
    { id: 21, name: "Sam Patel", site_id: 1, site_name: "Leeds", active: true },
    { id: 22, name: "Sam Patel", site_id: 1, site_name: "Leeds", active: true },
    { id: 23, name: "Sam Patel", site_id: 2, site_name: "York", active: true },
    { id: 24, name: "Robin Lee", site_id: 1, site_name: "Leeds", active: true },
    { id: 25, name: "Robin Lee", site_id: 2, site_name: "York", active: true },
  ];
  const sameNameCerts = [
    // Person 21: older expired, newer current (latest must win per person).
    { id: 101, staff_roster_id: 21, staff_name: "Sam Patel", training_type: "First Aid", completed_date: "2023-01-01", expiry_date: "2024-12-01", site_id: 1 },
    { id: 102, staff_roster_id: 21, staff_name: "Sam Patel", training_type: "First Aid", completed_date: "2024-06-01", expiry_date: "2026-06-01", site_id: 1 },
    // Person 22: a newer, expired certificate. It must not replace 21's cell.
    { id: 103, staff_roster_id: 22, staff_name: "Sam Patel", training_type: "First Aid", completed_date: "2024-12-01", expiry_date: "2025-01-01", site_id: 1 },
    // Person 23 (site 2): the newest of all, current.
    { id: 104, staff_roster_id: 23, staff_name: "Sam Patel", training_type: "First Aid", completed_date: "2025-01-10", expiry_date: "2027-01-10", site_id: 2 },
    // Same-day tie for person 22: the later record id wins deterministically.
    { id: 106, staff_roster_id: 22, staff_name: "Sam Patel", training_type: "Fire Safety", completed_date: "2025-01-02", expiry_date: "2025-02-01", site_id: 1 },
    { id: 105, staff_roster_id: 22, staff_name: "Sam Patel", training_type: "Fire Safety", completed_date: "2025-01-02", expiry_date: "2024-12-31", site_id: 1 },
  ];
  const leeds21 = "Sam Patel (Leeds, roster #21)";
  const leeds22 = "Sam Patel (Leeds, roster #22)";
  const york23 = "Sam Patel (York, roster #23)";
  for (const input of [sameNameCerts, [...sameNameCerts].reverse()]) {
    const leeds = buildTrainingMatrix(input, sameNameStaff, "1", today);
    assert.deepEqual(labels(leeds), ["Robin Lee", leeds21, leeds22], "same-name staff at one site keep separate rows");
    assert.deepEqual(cellOf(leeds, leeds21, "First Aid"), { status: "Current", expiryDate: "2026-06-01" });
    assert.deepEqual(cellOf(leeds, leeds22, "First Aid"), { status: "Expired", expiryDate: "2025-01-01" });
    assert.deepEqual(cellOf(leeds, leeds21, "Fire Safety"), { status: "Missing", expiryDate: null });
    assert.deepEqual(cellOf(leeds, leeds22, "Fire Safety"), { status: "Expiring Soon", expiryDate: "2025-02-01" });
    assert.equal(cellOf(leeds, "Robin Lee", "First Aid").status, "Missing");
    assert.deepEqual(leeds.unmatchedCertificates, []);

    // Selected-site filter: site 2's Sam is unique there, and site 1 records
    // (including the other Sams' newer ones) never reach his row.
    const york = buildTrainingMatrix(input, sameNameStaff, "2", today);
    assert.deepEqual(labels(york), ["Robin Lee", "Sam Patel"]);
    assert.deepEqual(cellOf(york, "Sam Patel", "First Aid"), { status: "Current", expiryDate: "2027-01-10" });
    assert.deepEqual(york.types, ["First Aid"]);

    // All sites: three rows, each with only their own certificate history.
    const everywhere = buildTrainingMatrix(input, sameNameStaff, "all", today);
    assert.deepEqual(labels(everywhere), [
      "Robin Lee (Leeds, roster #24)", "Robin Lee (York, roster #25)", leeds21, leeds22, york23,
    ]);
    assert.equal(cellOf(everywhere, leeds21, "First Aid").expiryDate, "2026-06-01");
    assert.equal(cellOf(everywhere, leeds22, "First Aid").expiryDate, "2025-01-01");
    assert.equal(cellOf(everywhere, york23, "First Aid").expiryDate, "2027-01-10");
    const exported = trainingMatrixToCsv(everywhere, date => date);
    assert.equal(exported.split("\r\n").length, 6, "one CSV row per roster member");
    assert.ok(exported.includes(`"${leeds21}","Missing","Current (2026-06-01)"`));
    assert.ok(exported.includes(`"${leeds22}","Expiring Soon (2025-02-01)","Expired (2025-01-01)"`));
  }

  // A linked record for someone inactive or at another site is not
  // re-attributed by name to an in-scope namesake.
  const linkedElsewhere = buildTrainingMatrix([
    { staff_roster_id: 23, staff_name: "Sam Patel", training_type: "Manual Handling", completed_date: "2025-01-01", expiry_date: null, site_id: 1 },
  ], sameNameStaff.filter(member => member.id !== 22), "1", today);
  assert.deepEqual(labels(linkedElsewhere), ["Robin Lee", "Sam Patel"]);
  assert.equal(cellOf(linkedElsewhere, "Sam Patel", "Manual Handling").status, "Missing");
  assert.deepEqual(linkedElsewhere.unmatchedCertificates, []);

  // ── Legacy name-only records ─────────────────────────────────────────────
  const legacy = [
    // Ambiguous at site 1 (two Sams) and across all sites (three Sams).
    { staff_name: "Sam Patel", training_type: "COSHH", completed_date: "2024-05-01", expiry_date: "2026-05-01", site_id: 1 },
    // Unique by normalised name at site 2 only; "robin  LEE " -> "robin lee".
    { staff_name: "  robin  LEE ", training_type: "COSHH", completed_date: "2024-05-01", expiry_date: "2026-05-01", site_id: 2 },
    // Nobody on the roster has this name.
    { staff_name: "Former Starter", training_type: "COSHH", completed_date: "2024-05-01", expiry_date: null, site_id: 1 },
  ];
  const legacyLeeds = buildTrainingMatrix(legacy, sameNameStaff, "1", today);
  assert.equal(cellOf(legacyLeeds, leeds21, "COSHH").status, "Missing", "ambiguous legacy record must not be guessed");
  assert.equal(cellOf(legacyLeeds, leeds22, "COSHH").status, "Missing");
  assert.equal(cellOf(legacyLeeds, "Robin Lee", "COSHH").status, "Missing");
  assert.deepEqual(legacyLeeds.unmatchedCertificates.map(r => r.staff_name), ["Sam Patel", "Former Starter"]);

  const legacyYork = buildTrainingMatrix(legacy, sameNameStaff, "2", today);
  assert.deepEqual(cellOf(legacyYork, "Robin Lee", "COSHH"), { status: "Current", expiryDate: "2026-05-01" },
    "one in-scope roster match by normalised name attaches the legacy record");
  assert.deepEqual(legacyYork.unmatchedCertificates, []);

  // Across all sites both Robins are in scope, so the same record is ambiguous.
  const legacyAll = buildTrainingMatrix(legacy, sameNameStaff, "all", today);
  assert.equal(cellOf(legacyAll, "Robin Lee (York, roster #25)", "COSHH").status, "Missing");
  assert.equal(cellOf(legacyAll, "Robin Lee (Leeds, roster #24)", "COSHH").status, "Missing");
  assert.equal(legacyAll.unmatchedCertificates.length, 3);

  // A unique name at one site still matches when only that site is in scope,
  // and a linked record beats an older legacy one for the same person.
  const mixed = buildTrainingMatrix([
    { staff_name: "Sam Patel", training_type: "COSHH", completed_date: "2025-01-01", expiry_date: "2025-01-02", site_id: 2 },
    { staff_roster_id: 23, staff_name: "S. Patel", training_type: "COSHH", completed_date: "2024-01-01", expiry_date: "2026-01-01", site_id: 2 },
  ], sameNameStaff, "2", today);
  assert.deepEqual(cellOf(mixed, "Sam Patel", "COSHH"), { status: "Expired", expiryDate: "2025-01-02" },
    "the latest certificate per person wins whether it is linked or matched legacy");

  const quotedName = 'Smith, "Jo"';
  const quotedType = 'Safety, "Advanced"';
  const quotedMatrix = buildTrainingMatrix([
    { staff_name: quotedName, training_type: quotedType, completed_date: "2025-01-01", expiry_date: null, site_id: 1 },
  ], [{ id: 31, name: quotedName, site_id: 1, active: true }], "1", today);
  assert.equal(trainingMatrixToCsv(quotedMatrix, date => date), [
    '"Staff member","Safety, ""Advanced"""',
    '"Smith, ""Jo""","Current"',
  ].join("\r\n"));

  // The matrix only receives the active client's API responses. A second
  // tenant's records/roster therefore form a separate matrix and cannot leak
  // into the first client's downloaded CSV.
  const otherTenant = buildTrainingMatrix(
    [{ staff_name: "Tenant Two", training_type: "Food Hygiene", completed_date: "2024-01-01", expiry_date: null, site_id: 1 }],
    [{ id: 41, name: "Tenant Two", site_id: 1, active: true }],
    "all",
    today,
  );
  assert.deepEqual(labels(otherTenant), ["Tenant Two"]);
  assert.deepEqual(otherTenant.types, ["Food Hygiene"]);
  assert.equal(otherTenant.cells.size, 1);
  console.log("Training matrix regression checks passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
