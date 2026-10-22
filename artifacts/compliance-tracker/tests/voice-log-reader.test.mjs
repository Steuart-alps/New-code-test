import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// "Say it" word reader (src/lib/voice-log.ts): which track a spoken reading
// belongs to, which item it names and what the reading is. Only suggestions:
// the card always asks the person to check and tap Save.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "voice-log-"));
try {
  const bundle = path.join(dir, "voice-log.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/voice-log.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const { readSpokenReading, tokeniseSpeech, withinLimits, limitsLabel, defaultColdSlot } = await import(pathToFileURL(bundle).href);

  const numbers = (text) => tokeniseSpeech(text).filter((t) => t.value !== null).map((t) => t.value);
  assert.deepEqual(numbers("seventy eight"), [78]);
  assert.deepEqual(numbers("fridge one four"), [1, 4], "two numbers in a row stay two numbers");
  assert.deepEqual(numbers("minus eighteen"), [-18]);
  assert.deepEqual(numbers("freezer 2 is -18°C"), [2, -18]);
  assert.deepEqual(numbers("four point five degrees"), [4.5]);
  assert.deepEqual(numbers("one hundred and five"), [105]);
  assert.deepEqual(numbers("three and a half"), [3.5]);
  assert.deepEqual(numbers("4oC"), [4]);
  assert.deepEqual(numbers("CP3"), [3]);
  assert.deepEqual(numbers("twenty twenty"), [20, 20]);

  const catalogue = {
    coldUnits: [
      { name: "Fridge 1", type: "fridge" }, { name: "Fridge 2", type: "fridge" },
      { name: "Walk-in fridge", type: "fridge" }, { name: "Freezer 1", type: "freezer" },
    ],
    kitchenItems: ["Chicken breast", "Soup of the day"],
    callPoints: [
      { id: 11, name: "CP1", location: "Front door" }, { id: 12, name: "CP2", location: "Kitchen" },
      { id: 20, name: "CP10", location: "Plant room" },
    ],
    outlets: [
      { id: 31, name: "Ladies toilet basin", location: "Ground floor", type: "hot" },
      { id: 32, name: "Ladies toilet basin", location: "Ground floor", type: "cold" },
      { id: 33, name: "Outlet 3", location: "Plant room hose", type: "cold" },
      { id: 34, name: "Calorifier flow", location: "Boiler room", type: "calorifier" },
    ],
  };

  // KitchenTrack fridges and freezers.
  let r = readSpokenReading("fridge 1 is showing 4 degrees", catalogue);
  assert.equal(r.kind, "cold_unit");
  assert.deepEqual(r.matches.map((u) => u.name), ["Fridge 1"]);
  assert.equal(r.temperature, 4);
  assert.equal(r.slot, null);
  r = readSpokenReading("Fridge one is showing 4oC", catalogue);
  assert.deepEqual([r.matches.map((u) => u.name), r.temperature], [["Fridge 1"], 4]);
  r = readSpokenReading("fridge two three degrees this afternoon", catalogue);
  assert.deepEqual([r.matches.map((u) => u.name), r.temperature, r.slot], [["Fridge 2"], 3, "pm"]);
  r = readSpokenReading("freezer one minus eighteen", catalogue);
  assert.deepEqual([r.matches.map((u) => u.name), r.temperature], [["Freezer 1"], -18]);
  r = readSpokenReading("walk in fridge 3 degrees", catalogue);
  assert.deepEqual([r.matches.map((u) => u.name), r.temperature], [["Walk-in fridge"], 3]);
  r = readSpokenReading("fridge 3 is 5 degrees", catalogue);
  assert.equal(r.kind, "cold_unit");
  assert.deepEqual(r.matches, [], "no Fridge 3: the person picks from the list");
  assert.equal(r.temperature, 5);
  r = readSpokenReading("the fridge is 4 degrees", catalogue);
  assert.equal(r.matches.length, 3, "several fridges: all are offered to tap");
  r = readSpokenReading("the fridge is 4 degrees", { ...catalogue, coldUnits: [{ name: "Fridge 1", type: "fridge" }] });
  assert.deepEqual(r.matches.map((u) => u.name), ["Fridge 1"], "the only fridge");

  // KitchenTrack core temperatures.
  r = readSpokenReading("chicken core temp 78", catalogue);
  assert.deepEqual(r, { kind: "kitchen_core", section: "hotTemperature", item: "Chicken", temperature: 78, holdSeconds: null });
  r = readSpokenReading("chicken breast core temperature is seventy eight degrees", catalogue);
  assert.deepEqual([r.item, r.temperature], ["Chicken breast", 78]);
  r = readSpokenReading("reheated the soup of the day to 82 degrees", catalogue);
  assert.deepEqual([r.section, r.item, r.temperature], ["reheating", "Soup of the day", 82]);
  r = readSpokenReading("lasagne hot holding 65", catalogue);
  assert.deepEqual([r.section, r.item, r.temperature], ["hotHolding", "Lasagne", 65]);
  r = readSpokenReading("beef core temp 75 held for 30 seconds", catalogue);
  assert.deepEqual([r.item, r.temperature, r.holdSeconds], ["Beef", 75, 30]);
  r = readSpokenReading("duck core 70 degrees for 2 minutes", catalogue);
  assert.deepEqual([r.item, r.temperature, r.holdSeconds], ["Duck", 70, 120]);

  // FireTrack weekly alarm test.
  r = readSpokenReading("testing call point 1", catalogue);
  assert.equal(r.kind, "fire_alarm");
  assert.deepEqual(r.matches.map((p) => p.id), [11], "CP10 is not call point 1");
  assert.equal(r.result, null, "the person taps pass or fail");
  r = readSpokenReading("call point number ten sounded", catalogue);
  assert.deepEqual([r.matches.map((p) => p.id), r.result], [[20], "pass"]);
  r = readSpokenReading("CP2 not working", catalogue);
  assert.deepEqual([r.matches.map((p) => p.id), r.result], [[12], "fail"]);
  r = readSpokenReading("testing the call point by the front door, all good", catalogue);
  assert.deepEqual([r.matches.map((p) => p.id), r.result], [[11], "pass"]);
  r = readSpokenReading("call point 7", catalogue);
  assert.deepEqual(r.matches, []);

  // Legionella outlets.
  r = readSpokenReading("hot tap, ladies toilet, 55 degrees", catalogue);
  assert.equal(r.kind, "water_outlet");
  assert.deepEqual([r.matches.map((o) => o.id), r.temperature, r.water], [[31], 55, "hot"]);
  r = readSpokenReading("cold tap in the ladies toilets is 18 degrees", catalogue);
  assert.deepEqual([r.matches.map((o) => o.id), r.temperature], [[32], 18]);
  r = readSpokenReading("outlet 3 is 16 degrees", catalogue);
  assert.deepEqual([r.matches.map((o) => o.id), r.temperature], [[33], 16]);
  r = readSpokenReading("calorifier flow 61", catalogue);
  assert.deepEqual([r.matches.map((o) => o.id), r.temperature], [[34], 61]);
  r = readSpokenReading("ladies toilet tap 52 degrees", catalogue);
  assert.deepEqual(r.matches.map((o) => o.id), [31, 32], "hot or cold not said: both offered");

  // Tracks that aren't switched on, and phrases nobody can place.
  r = readSpokenReading("testing call point 1", { coldUnits: catalogue.coldUnits, kitchenItems: [] });
  assert.equal(r.kind, "unknown");
  assert.match(r.reason, /FireTrack isn't switched on/);
  r = readSpokenReading("hot tap ladies toilet 55", { coldUnits: catalogue.coldUnits, kitchenItems: [] });
  assert.match(r.reason, /Legionella isn't switched on/);
  r = readSpokenReading("fridge 1 is 4 degrees", { callPoints: [] });
  assert.match(r.reason, /KitchenTrack isn't switched on/);
  r = readSpokenReading("the weather is nice", catalogue);
  assert.equal(r.kind, "unknown");
  assert.equal(readSpokenReading("   ", catalogue).kind, "unknown");

  // Limits and labels.
  assert.equal(withinLimits(4, { min: 0, max: 5 }), true);
  assert.equal(withinLimits(6, { min: 0, max: 5 }), false);
  assert.equal(withinLimits(74, { min: 75, max: null }), false);
  assert.equal(withinLimits(50, null), true);
  assert.equal(limitsLabel({ min: 0, max: 5 }), "0°C to 5°C");
  assert.equal(limitsLabel({ min: 75 }), "75°C or above");
  assert.equal(limitsLabel({ max: 20 }), "20°C or below");
  assert.equal(defaultColdSlot(new Date(2026, 9, 21, 9)), "am");
  assert.equal(defaultColdSlot(new Date(2026, 9, 21, 15)), "pm");

  console.log("voice-log reader tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
