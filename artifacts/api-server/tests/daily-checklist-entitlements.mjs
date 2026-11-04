import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const outDir = await mkdtemp(path.join(os.tmpdir(), "daily-checklist-entitlements-"));
const outFile = path.join(outDir, "entry.mjs");

try {
  await build({
    entryPoints: [new URL("../src/lib/dailyChecklistEntitlements.ts", import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
  });

  const { accessibleDailyChecklistTypes, canAccessDailyChecklistType, dailyTrackRequirements } = await import(outFile);

  assert.deepEqual(accessibleDailyChecklistTypes(["kitchentrack"], "am"), ["kitchen_opening"]);
  assert.deepEqual(accessibleDailyChecklistTypes(["kitchentrack"], "pm"), ["kitchen_closing"]);
  assert.deepEqual(accessibleDailyChecklistTypes(["premisestrack"], "am"), ["premises_opening"]);
  assert.deepEqual(accessibleDailyChecklistTypes(["premisestrack"], "pm"), ["premises_closing"]);
  assert.deepEqual(
    accessibleDailyChecklistTypes(["dailytrack_am"], "am"),
    ["kitchen_opening", "premises_opening"],
  );
  assert.deepEqual(
    accessibleDailyChecklistTypes(["dailytrack_pm"], "pm"),
    ["kitchen_closing", "premises_closing"],
  );

  assert.equal(canAccessDailyChecklistType(["safetrack"], "am", "premises_opening"), false);
  assert.equal(canAccessDailyChecklistType(["kitchentrack"], "am", "premises_opening"), false);
  assert.equal(canAccessDailyChecklistType(["premisestrack"], "pm", "kitchen_closing"), false);
  assert.equal(canAccessDailyChecklistType("all", "pm", "kitchen_closing"), true);

  // The status page's daily requirements follow the same services; the
  // manager sign-off comes with any PM checklist.
  assert.deepEqual(dailyTrackRequirements("all"),
    ["kitchen_opening", "premises_opening", "kitchen_closing", "premises_closing", "signoff"]);
  assert.deepEqual(dailyTrackRequirements(["core", "kitchentrack"]), ["kitchen_opening", "kitchen_closing", "signoff"]);
  assert.deepEqual(dailyTrackRequirements(["core", "premisestrack"]), ["premises_opening", "premises_closing", "signoff"]);
  assert.deepEqual(dailyTrackRequirements(["core", "dailytrack_am"]), ["kitchen_opening", "premises_opening"]);
  assert.deepEqual(dailyTrackRequirements(["core", "dailytrack_pm"]), ["kitchen_closing", "premises_closing", "signoff"]);
  assert.deepEqual(dailyTrackRequirements(["core", "kitchentrack", "dailytrack_pm"]),
    ["kitchen_opening", "kitchen_closing", "premises_closing", "signoff"]);
  assert.deepEqual(dailyTrackRequirements(["core", "firetrack"]), []);

  console.log("Daily checklist entitlement checks passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}