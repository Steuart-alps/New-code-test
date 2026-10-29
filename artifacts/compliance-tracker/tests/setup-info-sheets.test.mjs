import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INFO_SHEETS, infoSheetForBusiness, readMeRows, siteCountsTab } from "../src/lib/setup-info-sheets.ts";
import { CHECKLISTS } from "../src/lib/setup-checklists.ts";

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
for (const key of ["getting-started", "contractors", "compliance", "firetrack", "kitchentrack", "legionellatrack", "pattrack", "roomtrack", "greentrack",
  "coshhtrack", "traintrack", "doctrack", "fixtrack", "incidenttrack", "pesttrack", "premisestrack", "hottubtrack", "aquatrack", "treetrack", "biketrack", "dailytrack"]) {
  assert.ok(keys.has(key), `a workbook for ${key}`);
}
// Contractors are on one spreadsheet only; its services tab lists every
// contractor service on the Contractors page card, with a trade the import accepts.
const contractorTabs = INFO_SHEETS.flatMap((sheet) => sheet.tabs.filter((tab) => tab.name === "Contractors").map(() => sheet.key));
assert.deepEqual(contractorTabs, ["contractors"], "only the Contractors spreadsheet has a Contractors tab");
const services = INFO_SHEETS.find((sheet) => sheet.key === "contractors").tabs.find((tab) => tab.name === "Services by track").rows;
const visitLabels = [...source("../../api-server/src/lib/contractorVisits.ts").matchAll(/key: "[a-z_]+:[a-z_0-9]+", module:[^\n]*\n\s*title: [^\n]*label: "([^"]+)"/g)].map((m) => m[1]);
assert.ok(visitLabels.length >= 30, `contractor visit types found (${visitLabels.length})`);
for (const label of visitLabels) assert.ok(services.some((row) => row[1] === label), `"${label}" is on the Services by track tab`);
const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const tradeCodes = new Set([...source("../src/lib/contractor-trades.ts").matchAll(/value: "([a-z_]+)"/g)].map((m) => normalise(m[1])));
for (const row of services) assert.ok(tradeCodes.has(normalise(row[2])), `trade "${row[2]}" for "${row[1]}" is a known trade`);

// Counts per site: only the business's tracks, one column per site.
{
  const all = siteCountsTab();
  assert.deepEqual(all.headers, ["Track", "Item", "Site 1", "Site 2", "Site 3", "Notes"], "three site columns when no sites are known");
  const items = (tab) => tab.rows.map((row) => row[1]);
  for (const item of ["Fridges", "Freezers", "Showers", "Fire alarm call points", "Hot tubs"]) assert.ok(items(all).includes(item), `${item} counted`);
  const tub = siteCountsTab({ modules: ["hottubtrack"], sites: ["Lodges", "Clubhouse"] });
  assert.deepEqual(tub.headers, ["Track", "Item", "Lodges", "Clubhouse", "Notes"], "the business's own sites");
  assert.ok(items(tub).includes("Hot tubs") && !items(tub).includes("Fridges") && items(tub).includes("Staff (approximate)"),
    "only the picked tracks, plus what every business has");
  const moduleKeys = new Set([...source("../src/lib/onboarding.ts").matchAll(/^  ([a-z_]+): \{ label:/gm)].map((m) => m[1]));
  const counted = new Set(all.rows.map((row) => row[0]));
  assert.ok(moduleKeys.has("hottubtrack") && moduleKeys.has("dailytrack_am"), "track keys read from MODULE_INFO");
  const sheetSource = source("../src/lib/setup-info-sheets.ts");
  for (const [, key] of sheetSource.matchAll(/\{ module: "([a-z_]+)", track:/g)) assert.ok(moduleKeys.has(key), `counts row module "${key}" is a track`);
  assert.ok(counted.has("Every business"));
  const fitted = infoSheetForBusiness(INFO_SHEETS.find((sheet) => sheet.key === "getting-started"), { modules: ["kitchentrack"], sites: ["Main"] });
  const countsTab = fitted.tabs.find((tab) => tab.name === "Counts per site");
  assert.ok(items(countsTab).includes("Fridges") && !items(countsTab).includes("Showers"), "the Getting started workbook carries the fitted counts tab");
}

// Checklist tabs: the clients' own compliance checklist layout, first in each
// workbook, with Due Date and Status formulas pointing at their own row.
{
  const BRAMSHAW_COLUMNS = ["Item", "Time Period", "Last Completed", "Due Date", "Status", "Contractor", "Telephone Number", "Email Address"];
  for (const key of Object.keys(CHECKLISTS)) {
    const sheet = INFO_SHEETS.find((candidate) => candidate.key === key);
    assert.ok(sheet, `checklist ${key} belongs to a workbook`);
    const [tab] = sheet.tabs;
    assert.equal(tab.name, "Checklist", `${sheet.label}: Checklist is the first tab`);
    assert.deepEqual(tab.headers.slice(0, 8), BRAMSHAW_COLUMNS, `${sheet.label}: checklist columns match the clients' checklist`);
    const headingRow = (tab.preamble?.length ?? 0) + 1;
    tab.rows.forEach((row, index) => {
      const excelRow = headingRow + 1 + index;
      const [item, , , due, status] = row;
      if (typeof status !== "object") return; // blank or section line
      assert.ok(typeof item === "string" && item, `${sheet.label}: line ${excelRow} has an item`);
      assert.ok(status.formula.startsWith(`IF(D${excelRow}=""`), `${sheet.label}: "${item}" status reads its own due date (row ${excelRow})`);
      if (typeof due === "object") assert.ok(due.formula.includes(`EDATE(C${excelRow},`) && due.format === "dd/mm/yyyy", `${sheet.label}: "${item}" due date from its own last completed date`);
    });
    const items = tab.rows.filter((row) => typeof row[4] === "object").map((row) => row[0]);
    assert.equal(new Set(items).size, items.length, `${sheet.label}: no item listed twice`);
  }
  const fire = INFO_SHEETS.find((sheet) => sheet.key === "firetrack").tabs[0].rows.map((row) => row[0]);
  assert.ok(fire.includes("In-house") && fire.indexOf("Fire alarm maintenance") < fire.indexOf("In-house"), "contractor work first, then In-house");
  // An item belongs to one spreadsheet only.
  const everywhere = Object.values(CHECKLISTS).flatMap((list) => [...list.contractor, ...list.inHouse].map((entry) => entry.item));
  const repeated = everywhere.filter((item, index) => everywhere.indexOf(item) !== index);
  assert.deepEqual(repeated, [], "no checklist item on two spreadsheets");
}

console.log(`setup info sheets: ${INFO_SHEETS.length} workbooks, ${importable.length} uploadable tabs match their imports`);
