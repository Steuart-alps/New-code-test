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

  // ── Unsaved diary edits survive date/site changes and late responses ──
  const today = state.kitchenDiaryScopeKey(null, "2026-10-15");
  const tomorrow = state.kitchenDiaryScopeKey(null, "2026-10-16");
  const siteToday = state.kitchenDiaryScopeKey(7, "2026-10-15");
  assert.notEqual(today, siteToday, "organisation and site diaries are different scopes");
  const blank = state.kitchenDiarySnapshot({ deliveries: [], correctives: "" });
  const edited = state.kitchenDiarySnapshot({ deliveries: [{ supplier: "Brakes" }], correctives: "" });
  const loadedNew = { scope: today, recordKey: "new", snapshot: blank };

  // Dirty means "differs from what this scope loaded", not "differs from the
  // latest server response".
  assert.equal(state.isKitchenDiaryDirty(null, today, edited), false, "nothing loaded yet is not dirty");
  assert.equal(state.isKitchenDiaryDirty(loadedNew, today, blank), false);
  assert.equal(state.isKitchenDiaryDirty(loadedNew, today, edited), true);
  assert.equal(state.isKitchenDiaryDirty(loadedNew, siteToday, edited), false,
    "values left over from another scope are not that scope's edits");

  // Date change and organisation-to-site switch: unsaved edits need a
  // deliberate discard, a clean form switches straight away.
  assert.equal(state.requestKitchenDiaryScopeChange(today, tomorrow, true, false), "confirm");
  assert.equal(state.requestKitchenDiaryScopeChange(today, siteToday, true, false), "confirm");
  assert.equal(state.requestKitchenDiaryScopeChange(today, tomorrow, false, false), "switch");
  assert.equal(state.requestKitchenDiaryScopeChange(today, siteToday, false, false), "switch");
  assert.equal(state.requestKitchenDiaryScopeChange(today, siteToday, false, true), "confirm",
    "a save still in flight also needs a decision");
  assert.equal(state.requestKitchenDiaryScopeChange(today, today, true, false), "ignore");

  // Late record/template responses and refetches never overwrite dirty fields.
  const someoneElsesDay = state.kitchenDiaryRecordKey({ id: 9, updatedAt: "2026-10-15T09:00:00Z" });
  assert.equal(state.kitchenDiaryHydrationAction(loadedNew, today, someoneElsesDay, true), "keep-edits",
    "a diary another device created meanwhile does not replace unsaved edits");
  assert.equal(state.kitchenDiaryHydrationAction(loadedNew, today, "new", true), "skip",
    "a refetch of the same version leaves the form alone");
  assert.equal(state.kitchenDiaryHydrationAction(loadedNew, today, someoneElsesDay, false), "hydrate",
    "a clean form shows the newer server version");
  const loadedRecord = { scope: today, recordKey: someoneElsesDay, snapshot: edited };
  const updatedElsewhere = state.kitchenDiaryRecordKey({ id: 9, updatedAt: "2026-10-15T09:05:00Z" });
  assert.equal(state.kitchenDiaryHydrationAction(loadedRecord, today, updatedElsewhere, true), "keep-edits");
  assert.equal(state.kitchenDiaryHydrationAction(loadedRecord, today, someoneElsesDay, false), "skip");
  assert.equal(state.kitchenDiaryHydrationAction(loadedNew, tomorrow, "new", true), "hydrate",
    "after a discarded scope change the new day loads");
  assert.equal(state.kitchenDiaryHydrationAction(loadedNew, siteToday, someoneElsesDay, true), "hydrate",
    "after a discarded organisation-to-site switch the site's diary loads");
  assert.equal(state.kitchenDiaryHydrationAction(null, today, "new", false), "hydrate");

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
    /const scopeKey = kitchenDiaryScopeKey\(selectedSiteId, selectedDate\);/,
    "hydration must reset when date or selected site changes",
  );
  assert.match(
    kitchenSource,
    /cooking: templateHotItems\.map/,
    "new diary days must be initialised from the effective template",
  );
  assert.match(
    kitchenSource,
    /disabled=\{!templateReady \|\| updateConfig\.isPending\}/,
    "template save must remain disabled until selected-site config is ready",
  );
  assert.match(
    kitchenSource,
    /stampedLimit\(baseRecord\?\.cookingLimit, cookingLimit\)/,
    "historical cooking limits must use the stamped value",
  );
  assert.match(
    kitchenSource,
    /shouldDisplayKitchenSection\(showColdFood, !!baseRecord && coldFood\.length > 0\)/,
    "populated historical sections must remain visible",
  );

  assert.match(
    kitchenSource,
    /kitchenDiaryHydrationAction\(loaded, scopeKey, recordKey, keepEdits\) !== "hydrate"\) return;/,
    "the diary only hydrates when the decision says so",
  );
  for (const control of [
    /onChange=\{\(e\) => changeScope\(\{ date: e\.target\.value, siteId: selectedSiteId \}\)\}/,
    /onChange=\{\(e\) => changeScope\(\{ date: selectedDate, siteId: e\.target\.value === "" \? null : Number\(e\.target\.value\) \}\)\}/,
    /onClick=\{\(\) => changeScope\(\{ date: r\.recordDate, siteId: selectedSiteId \}\)\}/,
    /onPickDay=\{\(d\) => \{ changeScope\(\{ date: d, siteId: selectedSiteId \}\);/,
  ]) {
    assert.match(kitchenSource, control, "every date and site control goes through the unsaved-edits check");
  }
  const diarySource = kitchenSource.slice(kitchenSource.indexOf("function DailyDiaryTab"));
  assert.doesNotMatch(
    diarySource.slice(diarySource.indexOf("const changeScope")),
    /setSelected(Date|SiteId)\(/,
    "date and site only change through applyScope",
  );
  assert.match(kitchenSource, /<AlertDialogTitle>Discard unsaved changes\?<\/AlertDialogTitle>/);
  assert.match(kitchenSource, /<AlertDialogCancel>Keep editing<\/AlertDialogCancel>/);
  assert.match(
    kitchenSource,
    /expectedRecord: buildDiaryBaseline\(baseRecord\)/,
    "saves are checked against the version the edits were made on",
  );
  assert.doesNotMatch(
    kitchenSource,
    /expectedRecord: buildDiaryBaseline\(record\)/,
    "a refetched record must not become the save baseline",
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