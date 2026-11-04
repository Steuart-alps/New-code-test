import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { oldWordPlainText, oldWordRows, oldWordText, WordDocError } from "../src/lib/word-doc.ts";

// Old Word (.doc) files read for imports (src/lib/word-doc.ts). The fixtures
// were saved as "Word 97-2003" by LibreOffice; roster-table.doc has accented
// names, so its text is stored as Unicode as well as 8-bit pieces.
const fixture = name => new Uint8Array(readFileSync(new URL(`fixtures/word-doc/${name}`, import.meta.url)));

{
  const { table } = oldWordRows(oldWordText(fixture("roster-table.doc")));
  assert.deepEqual(table, [
    ["Payroll ID", "Name", "Job Title", "Email"],
    ["1001", "Zoë Brontë", "Head Chef", "zoe@example.test"],
    ["1002", "Ann Fraser", "", ""],
    ["1003", "Łukasz Nowak", "Greenkeeper", "lukasz@example.test"],
  ], "the first table, headings first; blank cells stay in their columns; text around the table is left out");
}
{
  const { table, lines } = oldWordRows(oldWordText(fixture("roster-lines.doc")));
  assert.equal(table, null);
  assert.deepEqual(lines.split("\n").filter(Boolean), ["Payroll ID, Name, Job Title", "2001, Jo Smith, Porter", "2002, \"Lee, Sam\", Barista"], "a list with commas comes back line by line");
}
{
  const { table } = oldWordRows(oldWordText(fixture("fields.doc")));
  assert.deepEqual(table, [["Name", "Email"], ["Kim Lee", "kim@example.test"]], "a link shows its text, not the field code");
}
assert.equal(oldWordPlainText(fixture("roster-table.doc")).split("\n")[1], "1001\tZoë Brontë\tHead Chef\tzoe@example.test");
assert.throws(() => oldWordText(new TextEncoder().encode("{\\rtf1 not a Word 97 file}")), WordDocError);
console.log("Old Word (.doc) reading checks passed: tables, blank cells, Unicode names, comma lists and links.");
