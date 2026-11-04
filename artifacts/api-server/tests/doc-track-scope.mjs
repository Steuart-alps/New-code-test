// Which DocTrack categories an account may use (lib/docTrackScope.ts):
// DocTrack (or SafeTrack) opens every category; KitchenTrack alone opens only
// its HACCP plans and recipe spec sheets; neither opens none.
// Run: pnpm --filter @workspace/api-server run test:doc-track-scope
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-"));
try {
  const outfile = path.join(outDir, "scope.mjs");
  await build({
    entryPoints: [path.join(testsDir, "../src/lib/docTrackScope.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
  });
  const { docTrackCategoriesFor, docCategoryAllowed, KITCHEN_DOCUMENT_CATEGORIES } = await import(new URL(`file://${outfile}`).href);

  assert.deepEqual([...KITCHEN_DOCUMENT_CATEGORIES], ["haccp", "recipe_spec"]);
  assert.equal(docTrackCategoriesFor("all"), null, "trial or bundle: every category");
  assert.equal(docTrackCategoriesFor(["core", "doctrack"]), null, "DocTrack: every category");
  assert.equal(docTrackCategoriesFor(["core", "safetrack", "kitchentrack"]), null, "SafeTrack counts as DocTrack");
  const kitchen = docTrackCategoriesFor(["core", "kitchentrack"]);
  assert.deepEqual([...kitchen], ["haccp", "recipe_spec"], "KitchenTrack alone: HACCP and recipe spec sheets");
  assert.deepEqual(docTrackCategoriesFor(["core", "firetrack"]), [], "neither: nothing");

  assert.equal(docCategoryAllowed("risk_assessment", null), true);
  assert.equal(docCategoryAllowed("haccp", kitchen), true);
  assert.equal(docCategoryAllowed("recipe_spec", kitchen), true);
  assert.equal(docCategoryAllowed("risk_assessment", kitchen), false, "KitchenTrack alone can't file a risk assessment");
  assert.equal(docCategoryAllowed("haccp", []), false);
  console.log("doc-track-scope: all checks passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
