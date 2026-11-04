// Pure tests for saved form option lists (src/lib/formOptions.ts): defaults
// added after a business saved its own list reach that list, unless the
// business has since removed them.
import assert from "node:assert/strict";
import {
  DEFAULTS_ADDED_LATER, FORM_OPTION_DEFAULTS, MAX_OPTIONS, parseStoredOptionState, validateOptionList,
} from "../src/lib/formOptions";

const trades = FORM_OPTION_DEFAULTS.fixtrack_trades;
const added = DEFAULTS_ADDED_LATER.fixtrack_trades!;
const parse = (stored: unknown) => {
  const result = parseStoredOptionState(stored, trades, added);
  assert.ok(result.ok, "stored list parses");
  return result.value;
};

for (const trade of ["fire_alarm", "emergency_lighting", "fire_extinguishers", "intruder_alarm", "cctv",
  "kitchen_fire_suppression", "sprinkler_systems", "aov_smoke_vents"]) {
  assert.ok(trades.includes(trade), `${trade} is a default trade`);
  assert.ok(added.includes(trade), `${trade} reaches lists saved before it existed`);
}
assert.ok(added.every((trade) => trades.includes(trade)), "every later default is a default");
assert.ok(validateOptionList([...trades]).ok, "the default trades are a valid list");
console.log("ok - fire and security trades are default trades");

// A list saved in the original array format, before the fire trades.
const legacy = parse(["electrical", "plumbing", "Roofing"]);
assert.deepEqual(legacy.active, ["electrical", "plumbing", "Roofing", ...added]);
assert.ok(legacy.disabled.includes("gas_kitchen"), "older defaults left off stay disabled");
assert.ok(!legacy.disabled.some((trade) => added.includes(trade)), "new trades are not counted as removed");
console.log("ok - an old saved list gets the new trades");

// The current format: a trade the business removed stays removed.
const current = parse({ active: ["electrical", "fire_alarm"], disabled: ["cctv", "general"] });
assert.deepEqual(current.active, ["electrical", "fire_alarm", ...added.filter((t) => t !== "fire_alarm" && t !== "cctv")]);
assert.deepEqual(current.disabled, ["cctv", "general"]);
console.log("ok - a trade the business removed stays removed");

// Matching ignores case, as the rest of the option lists do.
const typed = parse({ active: ["Fire_Alarm"], disabled: [] });
assert.equal(typed.active.filter((t) => t.toLowerCase() === "fire_alarm").length, 1);

// A nearly full list does not grow past the limit.
const full = Array.from({ length: MAX_OPTIONS - 2 }, (_, i) => `Trade ${i}`);
const capped = parse({ active: full, disabled: [] });
assert.equal(capped.active.length, MAX_OPTIONS);
assert.ok(validateOptionList(capped.active).ok);
console.log("ok - a full list stays within the limit");

// Other lists are unchanged.
const types = parseStoredOptionState(["routine"], FORM_OPTION_DEFAULTS.premises_inspection_types);
assert.ok(types.ok);
assert.deepEqual(types.value.active, ["routine"]);
console.log("ok - lists with no later defaults are unchanged");
