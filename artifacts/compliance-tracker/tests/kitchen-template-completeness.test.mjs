import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const tempDir = await mkdtemp(path.join(tmpdir(), "kitchen-template-completeness-"));
const outfile = path.join(tempDir, "kitchen-state.mjs");

try {
  await build({
    entryPoints: [new URL("../src/lib/kitchen-state.ts", import.meta.url).pathname],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
  });

  const state = await import(`${new URL(`file://${outfile}`).href}?t=${Date.now()}`);

  // A selected site's template is not ready to save until both the selected
  // effective config and client baseline have arrived.
  assert.equal(
    state.isKitchenTemplateReady(undefined, { food_default_hot_items: "[]" }, true, false),
    false,
    "site template must stay unavailable while selected-site config is loading",
  );
  assert.equal(
    state.isKitchenTemplateReady({ food_default_hot_items: "[]" }, undefined, false, true),
    false,
    "site template must stay unavailable while client baseline is loading",
  );
  assert.equal(
    state.isKitchenTemplateReady({ food_default_hot_items: "[]" }, { food_default_hot_items: "[]" }, false, false),
    true,
  );

  // New diary rows use the selected site's effective template, including
  // site-specific cold units and default item lists.
  const siteTemplate = {
    food_cold_units: JSON.stringify([{ name: "Site Fridge", type: "fridge" }]),
    food_default_hot_items: JSON.stringify(["Site soup"]),
    food_default_holding_items: JSON.stringify(["Site buffet"]),
    food_default_sv_items: JSON.stringify(["Site sous vide"]),
  };
  assert.deepEqual(state.parseColdUnits(siteTemplate), [{ name: "Site Fridge", type: "fridge" }]);
  assert.deepEqual(state.parseStringArray(siteTemplate.food_default_hot_items), ["Site soup"]);
  assert.deepEqual(state.parseStringArray(siteTemplate.food_default_holding_items), ["Site buffet"]);
  assert.deepEqual(state.parseStringArray(siteTemplate.food_default_sv_items), ["Site sous vide"]);

  // Historical sections remain visible when the current template disables them,
  // but empty sections follow the current template.
  assert.equal(state.shouldDisplayKitchenSection(false, true), true);
  assert.equal(state.shouldDisplayKitchenSection(false, false), false);
  assert.equal(state.shouldDisplayKitchenSection(true, false), true);

  // Historical records keep stamped limits after the current template changes.
  assert.equal(state.stampedLimit("Above 70°C", "Above 75°C"), "Above 70°C");
  assert.equal(state.stampedLimit(null, "Above 75°C"), "Above 75°C");

  // Completeness keeps submitted, draft, and missing days distinct. The same
  // classification is used for organisation and selected-site responses.
  const completeness = state.classifyFoodSafetyCompleteness("2026-09-01", "2026-09-03", {
    missingDates: ["2026-09-03"],
    draftDates: ["2026-09-02"],
  });
  assert.deepEqual([...completeness.recorded], ["2026-09-01"]);
  assert.deepEqual(completeness.drafts, ["2026-09-02"]);
  assert.deepEqual(completeness.gaps, ["2026-09-03"]);
  assert.equal(
    state.foodSafetyCompletenessPath("2026-09-01", "2026-09-03", null),
    "/food-safety/missing-dates?from=2026-09-01&to=2026-09-03",
  );
  assert.equal(
    state.foodSafetyCompletenessPath("2026-09-01", "2026-09-03", 42),
    "/food-safety/missing-dates?from=2026-09-01&to=2026-09-03&siteId=42",
  );

  const kitchenSource = await readFile(
    new URL("../src/pages/kitchen.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    kitchenSource,
    /const configParams = selectedSiteId != null \? \{ siteId: selectedSiteId \} : undefined;/,
    "template editor must load the selected site's config",
  );
  assert.match(
    kitchenSource,
    /if \(recordLoading \|\| configLoading\) return;/,
    "new diary hydration must wait for both record and selected-site template loading",
  );
  assert.match(
    kitchenSource,
    /const hydrationKey = `\$\{selectedSiteId \?\? "all"\}:\$\{selectedDate\}:\$\{record\?\.id \?\? "new"\}`;/,
    "hydration must reset when date or selected site changes",
  );
  assert.match(
    kitchenSource,
    /const cookingRows: CookingRow\[\] = templateHotItems\.map/,
    "new diary days must be initialised from the effective template",
  );
  assert.match(
    kitchenSource,
    /disabled=\{!templateReady \|\| updateConfig\.isPending\}/,
    "template save must remain disabled until selected-site config is ready",
  );
  assert.match(
    kitchenSource,
    /stampedLimit\(record\?\.cookingLimit, cookingLimit\)/,
    "historical cooking limits must use the stamped value",
  );
  assert.match(
    kitchenSource,
    /shouldDisplayKitchenSection\(showColdFood, !!record && coldFood\.length > 0\)/,
    "populated historical sections must remain visible",
  );

  const foodSafetySource = await readFile(
    new URL("../src/pages/food-safety.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    foodSafetySource,
    /foodSafetyCompletenessPath\(from, to, siteId\)/,
    "organisation and site completeness views must request their own scope",
  );
  assert.match(
    foodSafetySource,
    /const \[selectedSiteId, setSelectedSiteId\] = useState<number \| null>\(null\);/,
    "FoodSafety must keep an explicit organisation/site scope",
  );

  console.log("Kitchen template and completeness tests passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}