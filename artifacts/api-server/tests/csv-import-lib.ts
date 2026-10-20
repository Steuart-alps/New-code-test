// Pure checks for the register CSV import helpers (lib/csvImport.ts):
// header mapping, cell validation, UK dates and formula-safe template cells.
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

console.log("csv-import-lib: all checks passed");
