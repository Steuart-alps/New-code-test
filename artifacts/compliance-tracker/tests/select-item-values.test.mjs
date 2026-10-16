// Radix Select (components/ui/select) throws when a <SelectItem> has an empty
// value, which takes the whole page down as soon as the dialog holding that
// menu opens. "No site" style options use a "none" sentinel instead.
// Run: pnpm --filter @workspace/compliance-tracker run test:select-item-values
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "src");

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

// value="" / value='' / value={""} / value={''} / value={``}, also split over lines.
const emptyValue = /<SelectItem\b[^>]*?\bvalue\s*=\s*(?:""|''|\{\s*(?:""|''|``)\s*\})/gs;

const offenders = [];
let scanned = 0;
for (const file of sourceFiles(src)) {
  scanned += 1;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(emptyValue)) {
    const line = text.slice(0, match.index).split("\n").length;
    offenders.push(`${relative(root, file)}:${line}`);
  }
}

assert.ok(scanned > 50, `expected to scan the web app's sources, scanned ${scanned}`);
// The pattern itself must catch the shapes that broke TreeTrack and others.
for (const sample of ['<SelectItem value="">No site</SelectItem>', "<SelectItem\n  value={''}>x</SelectItem>"]) {
  assert.ok([...sample.matchAll(emptyValue)].length === 1, `pattern should flag ${JSON.stringify(sample)}`);
}
assert.equal([...'<SelectItem value="none">No site</SelectItem>'.matchAll(emptyValue)].length, 0);
assert.deepEqual(offenders, [], `SelectItem with an empty value (use a "none" sentinel):\n${offenders.join("\n")}`);
console.log(`ok - no empty SelectItem values in ${scanned} source files`);
