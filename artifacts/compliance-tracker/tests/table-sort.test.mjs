import assert from "node:assert/strict";
import { matchesSearch, rankIn, sortRows } from "../src/lib/table-sort.ts";

const rows = [
  { id: 1, name: "bob", date: "2026-03-01", n: 10 },
  { id: 2, name: "Alice", date: "", n: 2 },
  { id: 3, name: "carol", date: "2026-01-05", n: 2 },
  { id: 4, name: null, date: "2026-03-01", n: 1 },
];
const accessors = { name: r => r.name, date: r => r.date, n: r => r.n };
const ids = list => list.map(r => r.id);

assert.deepEqual(ids(sortRows(rows, { key: "name", dir: "asc" }, accessors)), [2, 1, 3, 4], "A to Z ignoring case, blanks last");
assert.deepEqual(ids(sortRows(rows, { key: "name", dir: "desc" }, accessors)), [3, 1, 2, 4], "Z to A still puts blanks last");
assert.deepEqual(ids(sortRows(rows, { key: "date", dir: "desc" }, accessors)), [1, 4, 3, 2], "newest first, ties keep their order, blank date last");
assert.deepEqual(ids(sortRows(rows, { key: "n", dir: "asc" }, accessors)), [4, 2, 3, 1], "numbers sort as numbers, ties stable");
assert.deepEqual(ids(sortRows(rows, null, accessors)), [1, 2, 3, 4], "no sort keeps the incoming order");
assert.deepEqual(ids(sortRows(rows, { key: "missing", dir: "asc" }, accessors)), [1, 2, 3, 4], "unknown column keeps the incoming order");
assert.deepEqual(ids(rows), [1, 2, 3, 4], "the input is not changed");

assert.equal(rankIn(["minor", "moderate", "serious"], "serious"), 2);
assert.equal(rankIn(["minor", "moderate", "serious"], "custom"), 3, "unknown values rank last");
assert.equal(matchesSearch("Main Kitchen", "  kitch "), true);
assert.equal(matchesSearch(null, "x"), false);
assert.equal(matchesSearch(null, " "), true, "an empty search matches everything");

console.log("table-sort tests passed.");
