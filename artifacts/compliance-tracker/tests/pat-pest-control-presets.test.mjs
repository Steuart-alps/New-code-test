import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "src/pages/pat-track.tsx"), "utf8");

const pestPreset = source.match(
  /"pest-control": \{\s+label: "([^"]+)",\s+emoji: "([^"]+)",\s+items: \[([\s\S]*?)\n    \],\s+\},/m,
);

assert.ok(pestPreset, "the pest-control PAT preset should be defined");
assert.equal(pestPreset[1], "Pest Control Store");
assert.equal(pestPreset[2], "🐀");

const suggestedItems = [...pestPreset[3].matchAll(
  /\{ name: "([^"]+)",\s+type: "([^"]+)" \}/g,
)].map(([, name, type]) => ({ name, type }));

assert.deepEqual(suggestedItems, [
  { name: "Battery Charger — Pest Control Equipment", type: "Class I" },
  { name: "Electric ULV Fogger", type: "Portable Tool" },
  { name: "Electric Sprayer", type: "Portable Tool" },
  { name: "Insect Light Trap", type: "Class I" },
  { name: "Extension Lead", type: "Extension Lead" },
  { name: "Laptop Charger", type: "IT Equipment" },
  { name: "Mobile Device Charger", type: "Class II" },
]);

assert.match(
  source,
  /pest_control:\s+\["pest-control", "office", "reception"\]/,
  "pest-control businesses should see the dedicated preset first",
);
assert.match(source, /pest_control:\s+"Pest Control"/);

console.log("Pest-control PAT preset regression checks passed.");