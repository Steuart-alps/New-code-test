// Pure checks for the register CSV import helpers (lib/csvImport.ts):
// header mapping, cell validation, UK dates, formula-safe template cells and
// suppliers' allergen information.
// Run through test:csv-import-lib.
import assert from "node:assert/strict";
import { csvCell, importTemplateCsv, legionellaListType, mapImportRows, parseImportDate, splitListCell } from "../src/lib/csvImport";
import { categoryForTitle, contractorKey, isInHouseHeading, knownCheckFor, monthsBetween, parseRepeat } from "../src/lib/complianceCheckImport";

// Formula injection: = + - @ (after whitespace/BOM/zero-width), full-width forms, leading tab/CR.
for (const value of ["=1+1", "+44", "-2", "@SUM(A1)", "  =cmd", "﻿=cmd", "​@x", "＝1", "\tHello", "\rHello"]) {
  assert.ok(csvCell(value).startsWith(`"'`), `neutralised: ${JSON.stringify(value)}`);
}
assert.equal(csvCell("Kettle"), '"Kettle"');
assert.equal(csvCell('Say "hi"'), '"Say ""hi"""');
assert.equal(csvCell("a,b\nc"), '"a,b\nc"');

// Template: BOM, quoted header row and example row, every cell formula-safe.
const template = importTemplateCsv("contractors");
assert.ok(template.startsWith('﻿"Contact name","Company","Email"'));
assert.equal(template.trim().split("\r\n").length, 2);

// UK and ISO dates; impossible dates rejected.
assert.equal(parseImportDate("31/03/2027"), "2027-03-31");
assert.equal(parseImportDate("1/4/27"), "2027-04-01");
assert.equal(parseImportDate("2027-03-31"), "2027-03-31");
assert.equal(parseImportDate("31/02/2027"), null);
assert.equal(parseImportDate("03/31/2027"), null);
assert.equal(parseImportDate("next week"), null);

assert.deepEqual(splitListCell("Electrical; plumbing | electrical,Gas"), ["Electrical", "plumbing", "Gas"]);

// Header aliases, first matching header wins, unknown headers reported.
const mapped = mapImportRows("pat-appliances", {
  headers: ["Asset No", "Appliance Name", "Name", "TYPE", "Colour"],
  rows: [["T1", "Kettle", "ignored", "kitchen appliance", "red"], ["", "", "", "", ""], ["T2", "", "", "Toaster oven", ""]],
});
assert.deepEqual(mapped.fileErrors, []);
assert.deepEqual(mapped.ignoredHeaders, ["Name", "Colour"]);
assert.equal(mapped.rows.length, 2, "blank lines are dropped");
assert.equal(mapped.rows[0].row, 2);
assert.equal(mapped.rows[0].values.name, "Kettle");
assert.equal(mapped.rows[0].values.assetTag, "T1");
assert.equal(mapped.rows[0].values.applianceType, "Kitchen Appliance");
assert.equal(mapped.rows[1].row, 4, "row numbers follow the spreadsheet");
assert.ok(mapped.rows[1].errors.some((error) => error.includes("Appliance name is required")));
assert.ok(mapped.rows[1].errors.some((error) => error.includes("not recognised")));

// Missing required column and row limit are file errors.
assert.match(mapImportRows("contractors", { headers: ["Contact name"], rows: [["A"]] }).fileErrors[0], /Email/);
assert.match(mapImportRows("room-track-rooms", { headers: ["Room"], rows: Array.from({ length: 1001 }, () => ["1"]) }).fileErrors[0], /maximum is 1000/);

// Cell validation.
const contractors = mapImportRows("contractors", {
  headers: ["Name", "Email", "PL expiry"],
  rows: [["Sam", " SAM@Example.CO.UK ", "31/03/2027"], ["Jo", "jo@", "2027-13-01"], ["x".repeat(201), "a@b.co", ""]],
});
assert.equal(contractors.rows[0].values.email, "sam@example.co.uk");
assert.equal(contractors.rows[0].values.publicLiabilityExpiry, "2027-03-31");
assert.ok(contractors.rows[1].errors.some((error) => error.includes("valid email")));
assert.ok(contractors.rows[1].errors.some((error) => error.includes("not a date")));
assert.ok(contractors.rows[2].errors.some((error) => error.includes("200 characters")));


// ── KitchenTrack ingredients from suppliers' allergen information ──────────
{
  // A supplier's matrix: one column per allergen, long FSA-style headings.
  const matrix = mapImportRows("allergen-ingredients", {
    headers: ["Product Description", "Supplier", "Code", "Celery", "Cereals containing gluten (wheat, rye, barley)", "Eggs", "Milk / lactose",
      "Nuts (almonds, hazelnuts)", "Peanuts", "Sesame seeds", "Soya", "Sulphur dioxide / sulphites", "Nutrition per 100g"],
    rows: [
      ["Plain flour", "Brakes", "FL1", "N", "Y", "", "no", "-", "N", "N", "May contain", "N", "340kcal"],
      ["Pesto", "Brakes", "P2", "", "", "", "✔", "Traces", "", "", "", "", ""],
      ["Mystery", "", "", "?", "", "", "", "", "", "", "", "", ""],
      ["Water", "", "", "", "", "", "", "", "", "", "", "", ""],
    ],
  });
  assert.deepEqual(matrix.fileErrors, []);
  assert.deepEqual(matrix.ignoredHeaders, ["Nutrition per 100g"], "Nutrition is not the Nuts column");
  assert.equal(matrix.rows[0].values.name, "Plain flour");
  assert.equal(matrix.rows[0].values.productCode, "FL1");
  assert.equal(matrix.rows[0].values.contains, "gluten");
  assert.equal(matrix.rows[0].values.mayContain, "soya");
  assert.deepEqual(matrix.rows[0].errors, []);
  assert.equal(matrix.rows[1].values.contains, "milk");
  assert.equal(matrix.rows[1].values.mayContain, "tree_nuts");
  assert.ok(matrix.rows[2].errors.some((error) => error.includes('Celery "?" is not understood')));
  assert.ok(matrix.rows[3].errors.some((error) => error.includes("No allergen information")), "a blank row is not 'free from all 14'");

  // Lists: "Contains" and "May contain" columns naming allergens and the foods within them.
  const lists = mapImportRows("allergen-ingredients", {
    headers: ["Ingredient", "Allergens", "May contain"],
    rows: [
      ["Prawn cocktail", "Crustaceans (prawns), egg yolk, mustard and milk", "None"],
      ["Granola", "Oats; almonds", "peanuts & sesame, soy"],
      ["Coconut milk", "coconut", ""],
      ["Salt", "None", ""],
    ],
  });
  assert.deepEqual(lists.fileErrors, []);
  assert.equal(lists.rows[0].values.contains, "crustaceans;eggs;milk;mustard");
  assert.equal(lists.rows[0].values.mayContain, "");
  assert.equal(lists.rows[1].values.contains, "gluten;tree_nuts");
  assert.equal(lists.rows[1].values.mayContain, "peanuts;sesame;soya");
  assert.ok(lists.rows[2].errors.some((error) => error.includes('"coconut" is not one of the 14 allergens')), "coconut is not a tree nut");
  assert.deepEqual(lists.rows[3].errors, []);
  assert.equal(lists.rows[3].values.contains, "");

  // "Contains" wins over "may contain" for the same allergen.
  const both = mapImportRows("allergen-ingredients", { headers: ["Name", "Milk", "May contain"], rows: [["Cheese", "Y", "milk"]] });
  assert.equal(both.rows[0].values.contains, "milk");
  assert.equal(both.rows[0].values.mayContain, "");

  // A file without any allergen columns is turned away.
  assert.match(mapImportRows("allergen-ingredients", { headers: ["Ingredient", "Supplier"], rows: [["Flour", "Brakes"]] }).fileErrors[0], /allergen information/);

  // The template is the matrix shape; the list columns are accepted but not in it.
  const allergenTemplate = importTemplateCsv("allergen-ingredients");
  assert.ok(allergenTemplate.includes('"Ingredient","Supplier","Product code","Celery","Gluten"'));
  assert.ok(!allergenTemplate.includes('"Contains"'));
}

// LegionellaTrack outlets and tanks: the Type cell in everyday words.
{
  const types: Array<[string, string | null]> = [
    ["Hot", "hot"], ["hot water", "hot"], ["H", "hot"], ["Cold", "cold"], ["cold tap", "cold"],
    ["TMV", "tmv"], ["Mixer", "tmv"], ["Thermostatic mixing valve", "tmv"], ["Little used", "little_used"], ["Infrequently used", "little_used"],
    ["Cold water storage tank", "cold_water_tank"], ["CWST", "cold_water_tank"], ["Tank", "cold_water_tank"],
    ["Calorifier", "calorifier"], ["Hot water cylinder", "calorifier"], ["Warm", null], ["", null],
  ];
  for (const [cell, type] of types) assert.equal(legionellaListType(cell), type, cell);
  assert.ok(importTemplateCsv("legionella-outlets").includes('"Outlet or tank","Type","Location","Site"'));
}

// Compliance checklists (lib/complianceCheckImport.ts): the repeat as people write it.
{
  const months = (text: string) => { const r = parseRepeat(text); return r.kind === "months" ? r.months : r.kind; };
  assert.equal(months("Annual"), 12);
  assert.equal(months("annually"), 12);
  assert.equal(months("6 monthly"), 6);
  assert.equal(months("Six-monthly"), 6);
  assert.equal(months("Monthly "), 1);
  assert.equal(months("Quarterly"), 3);
  assert.equal(months("5 years"), 60);
  assert.equal(months("10 years"), 120);
  assert.equal(months("Every 3 years"), 36);
  assert.equal(months("24"), 24);
  assert.equal(months("Weekly"), "under_a_month");
  assert.equal(months("Weekly (at fire alarm test)"), "under_a_month");
  assert.equal(months("Weekly flushing"), "under_a_month");
  assert.equal(months("Various (usually 2-5 years)"), "unknown");
  assert.equal(months("6 monthly / annual"), "unknown", "two intervals: the business chooses");
  assert.equal(months(""), "unknown");

  assert.equal(monthsBetween("2024-08-22", "2027-08-22"), 36);
  assert.equal(monthsBetween("2026-09-28", "2027-03-28"), 6);
  assert.equal(monthsBetween("2026-01-31", "2026-02-28"), 1, "month ends clamp");
  assert.equal(monthsBetween("2026-01-10", "2026-03-01"), null, "not a whole number of months");

  const title = (text: string, has: (s: string) => boolean = () => true) => knownCheckFor(text, has)?.title ?? null;
  assert.equal(title("Heating plant (oil etc)"), "Oil Boilers — Annual Service");
  assert.equal(title("Gas - Catering Equipment"), "Gas Kitchen Equipment — Annual Service");
  assert.equal(title("Fire Alarm Maintenance"), "Fire Alarm Maintenance");
  assert.equal(title("Emergency Lighting Maintenance"), "Emergency Light Maintenance");
  assert.equal(title("Fire Extinguisher Maintenance"), "Fire Extinguishers Maintenance");
  assert.equal(title("Kitchen Extraction System"), "Kitchen Extract Cleaning (TR19 Grease)");
  assert.equal(title("Portable Appliance Testing"), "Electrical Appliance Testing (PAT)");
  assert.equal(title("Electrical Installation Condition Report"), "Electrical Installation Condition Report (EICR)");
  assert.equal(title("Legionella Risk Assessment"), "Legionella Risk Assessment");
  assert.equal(title("Disinfection of water tanks"), "Clean & Disinfect Water Tanks");
  assert.equal(title("Pressure Equipment - Coffee Machine"), "Coffee Machine — Written Scheme Examination");
  assert.equal(title("Compressor (sheds)"), "Compressor — Written Scheme Examination");
  assert.equal(title("NSTS (Sprayer)"), "GreenTrack NSTS Sprayer Test");
  assert.equal(title("NSTS (Sprayer)", () => false), null, "the GreenTrack line only with GreenTrack");
  assert.equal(title("LOLER Inspections (front loaders / vehicle lifts)"), null, "two kinds of equipment: kept as written");
  assert.equal(title("Front loader LOLER"), "Front Loader — Thorough Examination");
  assert.equal(title("Fire alarm manual break glass call points"), null, "the weekly test is not the service");
  assert.equal(title("Asbestos Survey"), null);
  assert.equal(title("Pressure Equipment - Shoe Cleaner"), null);
  assert.equal(knownCheckFor("Emergency Lighting")?.inHouseBelowMonths, 12);

  assert.equal(categoryForTitle("Asbestos Survey"), "Asbestos");
  assert.equal(categoryForTitle("Pressure Equipment - Shoe Cleaner"), "Pressure Systems");
  assert.equal(categoryForTitle("Fire Training"), "Fire");
  assert.equal(categoryForTitle("LOLER Inspections (front loaders / vehicle lifts)"), "LOLER");
  assert.equal(categoryForTitle("Something else"), "Other");

  assert.equal(contractorKey("Acme Fire Ltd."), contractorKey("acme fire"));
  assert.equal(contractorKey("Smith & Sons Limited"), contractorKey("Smith and Sons"));
  assert.ok(isInHouseHeading("In-house") && isInHouseHeading("In house checks") && !isInHouseHeading("Housekeeping"));

  // The checklist layout: a title row, headings on row 3, a Status formula column.
  const sheet = mapImportRows("compliance-checks", {
    headers: ["Compliance Checklist"],
    rows: [
      ["Item", "Time Period", "Last Completed", "Due Date ", "Status", "Contractor ", "Telephone Number ", "Email Address"],
      ["Fire Alarm Maintenance", "6 monthly", "2026-09-28", "2027-03-28", "150", "Acme Fire", "", ""],
      ["", "", "", "", "-1000", "", "", ""],
      ["Emergency Lighting", "Monthly ", "5 minute function test", "", "", "", "", ""],
    ],
  });
  assert.deepEqual(sheet.fileErrors, []);
  assert.deepEqual(sheet.ignoredHeaders, ["Status"]);
  assert.equal(sheet.rows.length, 2, "a line with only a Status value is blank");
  assert.equal(sheet.rows[0].row, 3);
  assert.equal(sheet.rows[0].values.title, "Fire Alarm Maintenance");
  assert.equal(sheet.rows[0].values.dueDate, "2027-03-28");
  assert.equal(sheet.rows[0].values.contractor, "Acme Fire");
  assert.equal(sheet.rows[1].values.lastDone, "5 minute function test", "Last done text is kept, not an error");
  assert.deepEqual(sheet.rows[1].errors, []);
}

console.log("csv-import-lib: all checks passed");
