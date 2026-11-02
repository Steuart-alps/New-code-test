import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INFO_SHEETS, QUESTIONS_TAB, infoSheetTabs, questionsTab, readMeRows } from "../src/lib/setup-info-sheets.ts";
import { WORKBOOK_TABS } from "../src/lib/list-kinds.ts";
import { TRACK_SETUP_TABS, planTrackSetup } from "../src/lib/track-setup.ts";

// The setup wizard's "What we need from you" forms (src/lib/setup-info-sheets.ts):
// basic questions and short lists. A list tab that says it can be uploaded
// must use headings its import recognises, including every required column.
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const csvImport = source("../../api-server/src/lib/csvImport.ts");
function csvColumns(type) {
  const start = csvImport.search(new RegExp(`\\n\\s+"?${type}"?: \\[`));
  assert.ok(start > 0, `${type} columns found in csvImport.ts`);
  const block = csvImport.slice(start);
  return [...block.slice(0, block.indexOf("\n  ]", 1)).matchAll(/\{ key: "[^"]+", label: "([^"]+)", aliases: \[([^\]]*)\]([^}]*)\}/g)]
    .map(([, label, aliases, rest]) => ({ label, aliases: [...aliases.matchAll(/"([^"]+)"/g)].map((m) => m[1]), required: rest.includes("required: true") }));
}
const templateHeaders = (path, marker) => {
  const text = source(path);
  const row = text.slice(text.indexOf(marker)).match(/\[\s*\[([^\]]+)\]/)[1];
  return [...row.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};
const recognised = {
  "Staff roster": { headers: templateHeaders("../src/components/roster-import-dialog.tsx", 'downloadExcel("staff-roster-template.xlsx"'), required: ["Name"] },
  Equipment: { headers: templateHeaders("../src/pages/green-track.tsx", 'downloadExcel("greentrack-equipment-template.xlsx"'), required: ["name", "type"] },
};
for (const [name, type] of [["Contractors", "contractors"], ["Call points", "fire-call-points"], ["Appliances", "pat-appliances"], ["Rooms", "room-track-rooms"]]) {
  const columns = csvColumns(type);
  recognised[name] = {
    accepts: (header) => columns.some((column) => normalise(column.label) === normalise(header) || column.aliases.includes(normalise(header))),
    required: columns.filter((column) => column.required).map((column) => column.label),
    columns,
  };
}

// The import dialogs read the tab of these names (readSpreadsheet's `sheet`).
for (const [name, path] of [["Appliances", "../src/components/import-csv-dialog.tsx"], ["Rooms", "../src/components/import-csv-dialog.tsx"],
  ["Contractors", "../src/components/import-csv-dialog.tsx"], ["Call points", "../src/components/import-csv-dialog.tsx"],
  ["Staff roster", "../src/components/roster-import-dialog.tsx"], ["Equipment", "../src/pages/green-track.tsx"]]) {
  assert.ok(source(path).includes(`sheet: "${name}"`), `${path} reads the "${name}" tab`);
}
assert.deepEqual(Object.values(WORKBOOK_TABS).sort(), Object.keys(recognised).sort(), "Upload your lists knows every uploadable tab");

const importable = INFO_SHEETS.flatMap((sheet) => sheet.tabs.filter((tab) => tab.importsInto).map((tab) => ({ sheet, tab })));
assert.equal(importable.length, 6, "staff roster, contractors, call points, appliances, rooms and GreenTrack equipment can be uploaded");
for (const { sheet, tab } of importable) {
  const known = recognised[tab.name];
  assert.ok(known, `${sheet.label}: "${tab.name}" has a known import`);
  for (const header of tab.headers) {
    assert.ok(known.accepts ? known.accepts(header) : known.headers.includes(header), `${sheet.label}: "${tab.name}" heading "${header}" is read by its import`);
  }
  for (const required of known.required) {
    const has = known.accepts
      ? tab.headers.some((header) => { const column = known.columns.find((c) => c.label === required); return normalise(header) === normalise(required) || column.aliases.includes(normalise(header)); })
      : tab.headers.includes(required);
    assert.ok(has, `${sheet.label}: "${tab.name}" has the required "${required}" column`);
  }
}
// "What they do" on the contractor list is kept (as the contractor's notes).
assert.ok(recognised.Contractors.columns.find((c) => c.label === "Notes").aliases.includes("whattheydo"));

const keys = new Set();
for (const sheet of INFO_SHEETS) {
  assert.ok(!keys.has(sheet.key), `${sheet.key} is listed once`);
  keys.add(sheet.key);
  const tabs = infoSheetTabs(sheet);
  const names = tabs.map((tab) => tab.name.toLowerCase());
  assert.ok(!names.includes("read me") && new Set(names).size === names.length, `${sheet.label}: tab names are distinct`);
  assert.ok(tabs.length > 0, `${sheet.label}: something to fill in`);
  for (const tab of tabs) {
    assert.ok(tab.name.length <= 31 && !/[\\/?*[\]:]/.test(tab.name), `${sheet.label}: "${tab.name}" is a valid Excel tab name`);
    for (const row of tab.rows) assert.equal(row.length, tab.headers.length, `${sheet.label}: "${tab.name}" rows fill every column`);
  }
  // Basic on purpose: a few questions and short lists.
  assert.ok(sheet.questions.length <= 8, `${sheet.label}: at most 8 questions`);
  for (const tab of sheet.tabs) assert.ok(tab.headers.length <= 5 && tab.rows.length <= 1, `${sheet.label}: "${tab.name}" is a short list with one example`);
  assert.ok(readMeRows(sheet).some((row) => row[0]?.includes("£500 + VAT")), `${sheet.label}: Read me offers the setup service`);
}
for (const key of ["getting-started", "contractors", "compliance", "firetrack", "kitchentrack", "legionellatrack", "pattrack", "roomtrack", "greentrack",
  "coshhtrack", "traintrack", "doctrack", "fixtrack", "incidenttrack", "pesttrack", "premisestrack", "hottubtrack", "aquatrack", "treetrack", "biketrack", "dailytrack"]) {
  assert.ok(keys.has(key), `a form for ${key}`);
}
const contractorTabs = INFO_SHEETS.flatMap((sheet) => sheet.tabs.filter((tab) => tab.name === "Contractors").map(() => sheet.key));
assert.deepEqual(contractorTabs, ["contractors"], "only the Contractors form has a contractor list");

// The Questions tab: one answer column per site, or one Answer column.
const kitchen = INFO_SHEETS.find((sheet) => sheet.key === "kitchentrack");
assert.deepEqual(questionsTab(kitchen).headers, ["Question", "Answer", "Notes"]);
assert.deepEqual(questionsTab(kitchen, { sites: ["Clubhouse", "Lodges"] }).headers, ["Question", "Clubhouse", "Lodges", "Notes"]);
assert.equal(TRACK_SETUP_TABS[QUESTIONS_TAB.toLowerCase()], "counts", "uploading a form reads its Questions tab");

// Answered "How many …?" questions set the tracks up when the form is uploaded.
const answered = (key, answers) => {
  const tab = questionsTab(INFO_SHEETS.find((sheet) => sheet.key === key), { sites: ["Clubhouse"] });
  return { name: tab.name, headers: tab.headers, rows: tab.rows.map((row) => [row[0], answers[row[0]] ?? "", ""]) };
};
const plan = planTrackSetup([
  answered("kitchentrack", { "How many fridges?": "2", "How many freezers?": "1", "How many display fridges or chillers?": "1" }),
  answered("firetrack", { "How many fire alarm call points?": "3" }),
  answered("legionellatrack", { "How many showers?": "2" }),
  answered("hottubtrack", { "How many hot tubs?": "1" }),
  answered("biketrack", { "How many hire bikes?": "4" }),
]);
const counts = Object.fromEntries(plan.groups.map((group) => [group.kind, group.items.length]));
assert.deepEqual(counts, { "cold-units": 4, "call-points": 3, outlets: 2, "hot-tubs": 1, bikes: 4 }, "every counted question sets up its track");
const sentinel = INFO_SHEETS.find((sheet) => sheet.key === "legionellatrack").tabs.find((tab) => tab.name === "Sentinel taps");
assert.equal(TRACK_SETUP_TABS[sentinel.name.toLowerCase()], "outlets", "sentinel taps become LegionellaTrack outlets");
assert.equal(planTrackSetup([{ name: sentinel.name, headers: sentinel.headers, rows: sentinel.rows }]).groups[0].items[0].type, "hot");

console.log(`setup forms: ${INFO_SHEETS.length} forms, ${importable.length} uploadable lists, counted questions set up their tracks`);
