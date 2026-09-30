import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const expectedSections = [
  "Accident & Hazard Reporting", "Asbestos Log", "COSHH",
  "Communication & Consultation on H&S", "Display Screen Equipment (DSE)",
  "Fire & Emergency Procedures", "First Aid Provision", "Health & Safety Policy Statement",
  "Housekeeping — Fire Safety", "Housekeeping — Electrical Safety",
  "Housekeeping — General Workplace Safety", "Infection Control", "Manual Handling",
  "Vehicle Movement", "Falls from Height", "Work Equipment", "Working at Height",
  "Lone Working / Personal Safety", "Medicines", "Mobile Phone Use",
  "Personal Protective Equipment (PPE)", "Risk Assessments", "Wellbeing", "Workplace Facilities",
];
const escapeHtml = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const tableRows = html => [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)]
  .flatMap(([, body]) => [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map(([, row]) => row));

const temp = await mkdtemp(path.join(tmpdir(), "induction-print-"));
try {
  const outfile = path.join(temp, "induction-print.mjs");
  await build({
    entryPoints: [path.resolve("src/lib/induction-print.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const { INDUCTION_SECTIONS, renderInductionHtml } = await import(pathToFileURL(outfile).href);
  assert.equal(INDUCTION_SECTIONS.length, 24);
  assert.deepEqual(INDUCTION_SECTIONS.map(section => section.label), expectedSections);
  assert.equal(new Set(INDUCTION_SECTIONS.map(section => section.key)).size, 24);

  const statuses = ["yes", "no", "na", ""];
  const statusNames = ["Yes", "No", "N/A", "Not recorded"];
  const checklist = {
    jobTitle: "Safety & Training <Lead>",
    department: "Operations & <Care>",
    items: INDUCTION_SECTIONS.map((section, index) => ({
      key: section.key, status: statuses[index % 4], comments: `Comment ${index + 1}: <check> & "review"`,
    })),
  };
  const record = {
    staffName: "Alex <Morgan> & Co.",
    startDate: "2026-09-01",
    completedAt: "2026-09-30",
    checklist: JSON.stringify(checklist),
    notes: 'Manager signed: <approved> & "filed"',
  };
  const html = renderInductionHtml(record, "North & South Site");
  const rows = tableRows(html);
  assert.equal(rows.length, 24, "every checklist topic must appear once in the printout");
  rows.forEach((row, index) => {
    assert.match(row, new RegExp(`<td class="number">${index + 1}</td>`));
    assert.ok(row.includes(`<td>${escapeHtml(expectedSections[index])}</td>`), expectedSections[index]);
    assert.ok(row.includes(`class="status ${statuses[index % 4] || "blank"}">${statusNames[index % 4]}</td>`), `status ${index}`);
    assert.ok(row.includes(escapeHtml(checklist.items[index].comments)), `comment ${index}`);
  });
  for (const value of [
    record.staffName, checklist.jobTitle, checklist.department, "North & South Site",
    record.startDate, record.completedAt, record.notes,
  ]) assert.ok(html.includes(escapeHtml(value)), `missing printable field: ${value}`);
  for (const label of ["Employee name", "Job title", "Department", "Site", "Start date", "Induction completed", "Manager sign-off notes"]) {
    assert.ok(html.includes(`<span class="label">${label}</span>`), `missing label: ${label}`);
  }
  assert.ok(!html.includes("<approved>"), "sign-off notes must be escaped");

  // Older saved records may have only one topic and no newer metadata.
  const old = renderInductionHtml({
    staffName: "Older Record",
    startDate: "2020-01-01",
    checklist: JSON.stringify({ items: [{ key: "coshh", status: "no", comments: "Review required" }] }),
  }, "All sites");
  assert.equal(tableRows(old).length, 24);
  assert.ok(tableRows(old)[2].includes('class="status no">No</td><td>Review required</td>'));
  assert.equal((old.match(/Not recorded<\/td>/g) ?? []).length, 23);
  assert.ok(old.includes("Not yet completed"));
  assert.ok(old.includes("No sign-off notes recorded."));
  assert.ok(old.includes('<span class="label">Site</span><span class="value">All sites</span>'));

  for (const broken of ["{bad json", "null", '{"items":{}}']) {
    const printable = renderInductionHtml({ ...record, checklist: broken }, "North Site");
    assert.equal(tableRows(printable).length, 24, `malformed JSON must still print: ${broken}`);
    assert.equal((printable.match(/Not recorded<\/td>/g) ?? []).length, 24);
    assert.ok(printable.includes(escapeHtml(record.staffName)));
    assert.ok(printable.includes(escapeHtml(record.notes)));
  }
  const mixed = renderInductionHtml({
    ...record,
    checklist: JSON.stringify({ items: [null, { key: "asbestos", status: "yes", comments: "Retained" }, { key: "coshh", status: "invalid", comments: 4 }] }),
  }, "North Site");
  assert.equal(tableRows(mixed).length, 24);
  assert.ok(tableRows(mixed)[1].includes('class="status yes">Yes</td><td>Retained</td>'));
  assert.ok(tableRows(mixed)[2].includes('class="status blank">Not recorded</td><td>—</td>'));
  console.log("Induction printout: 24 topics, metadata, saved answers, and legacy/malformed records passed.");
} finally {
  await rm(temp, { recursive: true, force: true });
}