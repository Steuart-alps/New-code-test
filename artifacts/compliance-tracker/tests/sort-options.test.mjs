import assert from "node:assert/strict";
import { compareOptionLabels, sortByLabel, sortedEntries } from "../src/lib/sort-options.ts";

const labels = (items) => sortByLabel(items, (item) => item);

assert.deepEqual(
  labels(["Retail", "Other", "Care Home", "golf club", "None", "N/A", "Not stated", "Northgate", "Otherton"]),
  ["Care Home", "golf club", "Northgate", "Otherton", "Retail", "N/A", "None", "Not stated", "Other"],
  "A to Z ignoring case, catch-alls last, names that only start like a catch-all stay in place",
);
assert.deepEqual(labels(["Room 10", "Room 2", "Room 1"]), ["Room 1", "Room 2", "Room 10"], "numbers sort as numbers");
assert.deepEqual(
  sortedEntries({ diesel: "Diesel", other: "Other fluid", petrol: "Petrol", oil: "Engine oil" }).map(([key]) => key),
  ["diesel", "oil", "petrol", "other"],
);
const original = ["b", "a"];
labels(original);
assert.deepEqual(original, ["b", "a"], "the input list is not changed");
assert.equal(compareOptionLabels("Café", "Cafe"), 0, "accents do not split otherwise equal labels");

console.log("sort-options tests passed.");
