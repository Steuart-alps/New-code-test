import assert from "node:assert/strict";
import { availableListKinds, guessListKind, guessListKindFromName } from "../src/lib/list-kinds.ts";

// How "Upload your lists" sorts a file without AI (src/lib/list-kinds.ts).
const all = availableListKinds(() => true);
assert.deepEqual(availableListKinds(key => key === "firetrack"), ["contractors", "fire-call-points", "staff-roster"], "only the business's modules");

assert.equal(guessListKind(["Payroll ID", "Name", "Job Title", "Department", "Email"], "export.xlsx", all), "staff-roster");
assert.equal(guessListKind(["Contact name", "Company", "Email", "Phone", "Trades"], "Book1.xlsx", all), "contractors");
assert.equal(guessListKind(["Appliance name", "Asset tag", "Appliance type", "Site", "Location"], "Book1.xlsx", all), "pat-appliances");
assert.equal(guessListKind(["Room number", "Room name", "Floor"], "Book1.xlsx", all), "room-track-rooms");
assert.equal(guessListKind(["Call point", "Location"], "Book1.xlsx", all), "fire-call-points");
assert.equal(guessListKind(["name", "type", "make", "model", "serial_no", "fleet_no"], "Book1.xlsx", all), "greentrack-equipment");
assert.equal(guessListKind(["Name", "Email"], "Book1.xlsx", all), null, "headings every list shares don't decide it");
assert.equal(guessListKind(["Name", "Email"], "contractors.xlsx", all), null, "a file name alone isn't enough for a spreadsheet");
assert.equal(guessListKind(["Name", "Email", "Department"], "contractors.xlsx", all), "staff-roster", "a heading outweighs the file name");
assert.equal(guessListKind(["Name", "Company", "Department"], "x.xlsx", all), null, "a tie is left for the person");
assert.equal(guessListKind(["Room number", "Floor"], "x.xlsx", ["contractors", "staff-roster"]), null, "a module the business doesn't have is never chosen");

assert.equal(guessListKindFromName("PAT_register_2026.pdf", all), "pat-appliances");
assert.equal(guessListKindFromName("Staff list.jpg", all), "staff-roster");
assert.equal(guessListKindFromName("Patel invoice.pdf", all), null, "Patel isn't PAT");
assert.equal(guessListKindFromName("IMG_0042.jpg", all), null);
assert.equal(guessListKindFromName("green team.jpg", all), null, "two lists match, so AI decides");
console.log("Upload your lists sorting checks passed.");
