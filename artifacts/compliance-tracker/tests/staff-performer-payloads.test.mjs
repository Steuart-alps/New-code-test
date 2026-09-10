import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../src");
const pages = fs.readdirSync(path.join(root, "pages"))
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => path.join(root, "pages", file));

const source = pages.map((file) => fs.readFileSync(file, "utf8")).join("\n");
assert.doesNotMatch(source, /staffRosterId:\s*[^,\n]+?\s*undefined/);
assert.doesNotMatch(source, /performedBy:\s*[^,\n]+?\|\|\s*undefined/);

const select = fs.readFileSync(path.join(root, "components/staff-performer-select.tsx"), "utf8");
assert.match(select, /value=\{value \?\? ""\}/);
assert.match(select, /onRosterIdChange\?\.\(null\)/);

console.log("staff performer payload regression checks passed");