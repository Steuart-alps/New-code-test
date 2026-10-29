import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INFO_SHEETS, readMeRows } from "../src/lib/setup-info-sheets.ts";

// The setup wizard's "What we need from you" workbooks (src/lib/setup-info-sheets.ts):
// a tab that says it can be uploaded must carry exactly the headers of that
// import's template, so a filled-in tab imports as it is.
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const csvImport = source("../../api-server/src/lib/csvImport.ts");
function csvLabels(type) {
  const start = csvImport.search(new RegExp(`\\n\\s+"?${type}"?: \\[`));
  assert.ok(start > 0, `${type} columns found in csvImport.ts`);
  const block = csvImport.slice(start);
  return [...block.slice(0, block.indexOf("\n  ]", 1)).matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
}
const firstTemplateRow = (path, marker) => {
  const text = source(path);
  const row = text.slice(text.indexOf(marker)).match(/\[\s*\[([^\]]+)\]/)[1];
  return [...row.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

const expected = {
  "Staff roster": firstTemplateRow("../src/components/roster-import-dialog.tsx", 'downloadExcel("staff-roster-template.xlsx"'),
  Contractors: csvLabels("contractors"),
  "Call points": csvLabels("fire-call-points"),
  Appliances: csvLabels("pat-appliances"),
  Rooms: csvLabels("room-track-rooms"),
  Equipment: firstTemplateRow("../src/pages/green-track.tsx", 'downloadExcel("greentrack-equipment-template.xlsx"'),
};
// The import dialogs read the tab of these names (readSpreadsheet's `sheet`).
for (const [name, path] of [["Appliances", "../src/components/import-csv-dialog.tsx"], ["Rooms", "../src/components/import-csv-dialog.tsx"],
  ["Contractors", "../src/components/import-csv-dialog.tsx"], ["Call points", "../src/components/import-csv-dialog.tsx"],
  ["Staff roster", "../src/components/roster-import-dialog.tsx"], ["Equipment", "../src/pages/green-track.tsx"]]) {
  assert.ok(source(path).includes(`sheet: "${name}"`), `${path} reads the "${name}" tab`);
}

const importable = INFO_SHEETS.flatMap((sheet) => sheet.tabs.filter((tab) => tab.importsInto).map((tab) => ({ sheet, tab })));
assert.equal(importable.length, 6, "staff roster, contractors, call points, appliances, rooms and GreenTrack equipment can be uploaded");
for (const { sheet, tab } of importable) {
  assert.ok(expected[tab.name], `${sheet.label}: "${tab.name}" has a known import`);
  assert.deepEqual(tab.headers, expected[tab.name], `${sheet.label}: "${tab.name}" headers match its import template`);
}

const keys = new Set();
for (const sheet of INFO_SHEETS) {
  assert.ok(!keys.has(sheet.key), `${sheet.key} is listed once`);
  keys.add(sheet.key);
  const names = sheet.tabs.map((tab) => tab.name.toLowerCase());
  assert.ok(!names.includes("read me") && new Set(names).size === names.length, `${sheet.label}: tab names are distinct`);
  for (const tab of sheet.tabs) {
    assert.ok(tab.name.length <= 31 && !/[\\/?*[\]:]/.test(tab.name), `${sheet.label}: "${tab.name}" is a valid Excel tab name`);
    for (const row of tab.rows) assert.equal(row.length, tab.headers.length, `${sheet.label}: "${tab.name}" rows fill every column`);
  }
  assert.ok(readMeRows(sheet).some((row) => row[0]?.includes("£500 + VAT")), `${sheet.label}: Read me offers the setup service`);
}
for (const key of ["getting-started", "compliance", "firetrack", "kitchentrack", "legionellatrack", "pattrack", "roomtrack", "greentrack",
  "coshhtrack", "traintrack", "doctrack", "fixtrack", "incidenttrack", "pesttrack", "premisestrack", "hottubtrack", "aquatrack", "treetrack", "biketrack", "dailytrack"]) {
  assert.ok(keys.has(key), `a workbook for ${key}`);
}
console.log(`setup info sheets: ${INFO_SHEETS.length} workbooks, ${importable.length} uploadable tabs match their imports`);
