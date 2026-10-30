// Pure checks for the register CSV import helpers (lib/csvImport.ts):
// header mapping, cell validation, UK dates, formula-safe template cells and
// suppliers' allergen information.
// Run through test:csv-import-lib.
import assert from "node:assert/strict";
import { csvCell, importTemplateCsv, mapImportRows, parseImportDate, splitListCell } from "../src/lib/csvImport";

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

console.log("csv-import-lib: all checks passed");
