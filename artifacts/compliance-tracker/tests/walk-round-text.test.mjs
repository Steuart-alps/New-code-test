import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// "Walk round and speak" (src/lib/walk-round.ts): spoken call points and
// water outlets become a numbered list in the order they were said.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "walk-round-text-"));
try {
  const bundle = path.join(dir, "walk-round.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/walk-round.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const { readWalkRound, nameWalkRoundItems } = await import(pathToFileURL(bundle).href);
  const brief = items => items.map(item => [item.ref, item.location, item.types.join("+")]);

  // One long phrase, no pauses: "this is" and "call point N" start each point.
  assert.deepEqual(brief(readWalkRound("this is call point 1 by the front door this is call point 2 in the kitchen", "call_point")),
    [[1, "By the front door", ""], [2, "Kitchen", ""]]);
  // One point per pause (each finished phrase is its own line), number words, commas.
  assert.deepEqual(brief(readWalkRound("call point one, reception\ncall point two comma kitchen fire exit comma ground floor\nCP3 at the bar", "call_point")),
    [[1, "Reception", ""], [2, "Kitchen fire exit, ground floor", ""], [3, "Bar", ""]]);
  // No number said: the location still becomes a point, numbered later.
  const unnumbered = readWalkRound("main entrance\nnext, the back stairs\num\n", "call_point");
  assert.deepEqual(brief(unnumbered), [[null, "Main entrance", ""], [null, "The back stairs", ""]]);
  assert.deepEqual(nameWalkRoundItems(unnumbered, "CP", ["CP1", "CP2 – Bar"]), ["CP3", "CP4"]);
  assert.deepEqual(nameWalkRoundItems(readWalkRound("call point 5 lobby\nstore room", "call_point"), "CP"), ["CP5", "CP6"]);
  // "Assembly point" in a location is not a new point.
  assert.deepEqual(brief(readWalkRound("call point 4, beside the assembly point sign", "call_point")), [[4, "Beside the assembly point sign", ""]]);

  // Outlets: what kind it is comes out of the location.
  assert.deepEqual(brief(readWalkRound(
    "outlet 1, ground floor ladies toilet basin, sentinel, hot and cold. outlet 2 kitchen sink hot\noutlet 3, plant room hose, little used\noutlet 4 assisted bathroom TMV\noutlet 5 calorifier\noutlet 6 staff shower, cold",
    "outlet")),
  [
    [1, "Ground floor ladies toilet basin", "hot+cold"],
    [2, "Kitchen sink", "hot"],
    [3, "Plant room hose", "little_used"],
    [4, "Assisted bathroom", "tmv"],
    [5, "", "calorifier"],
    [6, "Staff shower", "cold"],
  ]);
  // A sentinel with no hot or cold said is left for the person to choose.
  assert.deepEqual(brief(readWalkRound("outlet 7, first floor basin, sentinel", "outlet")), [[7, "First floor basin", ""]]);
  // "Rarely used" hot tap: flushed, so it is a little-used outlet.
  assert.deepEqual(brief(readWalkRound("outlet 8 room 12 bath rarely used hot and cold", "outlet")), [[8, "Room 12 bath", "little_used"]]);
  // Words for call points are kept as typed for call points.
  assert.deepEqual(brief(readWalkRound("call point 9, cold store corridor", "call_point")), [[9, "Cold store corridor", ""]]);
  assert.deepEqual(readWalkRound("", "outlet"), []);
  console.log("walk-round-text: all checks passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
