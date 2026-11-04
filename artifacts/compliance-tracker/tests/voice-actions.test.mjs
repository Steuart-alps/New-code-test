import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// "Say it" on every track page (src/lib/voice-actions.ts): which track a page
// belongs to, which tracks a person can raise actions on, and how a spoken
// problem becomes an action title and urgency. Only suggestions: the card
// always asks the person to check and tap Save.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "voice-actions-"));
try {
  const bundle = path.join(dir, "voice-actions.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/voice-actions.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const { SAY_IT_TRACKS, trackForPath, actionTracks, guessTrack, looksLikeProblem, readSpokenAction } = await import(pathToFileURL(bundle).href);

  // Every track that can hold actions has a page, a label and an example.
  const serverModules = ["daily_am", "daily_pm", "kitchen", "fire", "legionella", "pool", "pat", "pest", "fix", "premises", "doc", "safe", "train", "hot_tub", "tree", "bike", "green", "swim", "incident", "room", "coshh", "audit"];
  for (const track of SAY_IT_TRACKS) {
    assert.ok(serverModules.includes(track.key), `${track.key} is a track_actions module`);
    assert.ok(track.paths.length && track.label && track.example, track.key);
  }

  // Pages to tracks.
  assert.equal(trackForPath("/aqua-track"), "pool");
  assert.equal(trackForPath("/aqua-track?tab=tests"), "pool");
  assert.equal(trackForPath("/kitchen"), "kitchen");
  assert.equal(trackForPath("/food-safety"), "kitchen");
  assert.equal(trackForPath("/fix-track/12"), "fix");
  assert.equal(trackForPath("/green-track"), "green");
  assert.equal(trackForPath("/daily/am"), "daily_am");
  assert.equal(trackForPath("/hot-tub/"), "hot_tub");
  assert.equal(trackForPath("/dashboard"), null);
  assert.equal(trackForPath("/kitchen-cleaning"), null, "a prefix must end at a slash");

  // Tracks the person can raise actions on.
  const services = new Set(["kitchentrack", "aquatrack", "pesttrack", "fixtrack"]);
  const has = (key) => services.has(key);
  const keys = (role) => actionTracks(has, role).map((t) => t.key);
  assert.deepEqual(keys("client_admin"), ["kitchen", "pool", "swim", "pest", "fix", "daily_am", "daily_pm"]);
  assert.deepEqual(keys("client_staff"), ["pool", "swim", "pest", "fix", "daily_am", "daily_pm"], "KitchenTrack actions are for Owners and Consultants");
  assert.deepEqual(keys("client_viewer"), [], "viewers are read-only");
  assert.deepEqual(keys(null), []);

  // Guessing the track from the words, among the tracks offered.
  const offered = actionTracks(has, "client_admin");
  assert.equal(guessTrack("Mouse droppings in the dry store", offered), "pest");
  assert.equal(guessTrack("pool gate latch is broken", offered), "pool");
  assert.equal(guessTrack("the dishwasher isn't reaching temperature", offered), "kitchen");
  assert.equal(guessTrack("fire door wedged open", offered), null, "FireTrack isn't switched on");
  assert.equal(guessTrack("the carpet on the landing is lifting", offered), null);

  // Problems.
  assert.equal(looksLikeProblem("pool gate latch is broken"), true);
  assert.equal(looksLikeProblem("tap in the gents is leaking"), true);
  assert.equal(looksLikeProblem("needs a new bulb"), true);
  assert.equal(looksLikeProblem("the weather is lovely"), false);
  assert.equal(looksLikeProblem("fridge 1 is 4 degrees"), false);

  // Titles and urgency.
  assert.deepEqual(readSpokenAction("pool gate latch is broken, urgent"), { title: "Pool gate latch is broken", severity: "urgent" });
  assert.deepEqual(readSpokenAction("report that the fire door is wedged open"), { title: "The fire door is wedged open", severity: "action_required" });
  assert.deepEqual(readSpokenAction("raise an action for loose handrail on the main stairs"), { title: "Loose handrail on the main stairs", severity: "action_required" });
  assert.deepEqual(readSpokenAction("um okay so new starter needs manual handling training"), { title: "New starter needs manual handling training", severity: "action_required" });
  assert.deepEqual(readSpokenAction("water coming through the ceiling, it's an emergency"), { title: "Water coming through the ceiling", severity: "urgent" });
  assert.deepEqual(readSpokenAction("scuffed paint in reception, not urgent"), { title: "Scuffed paint in reception", severity: "monitor" });
  assert.deepEqual(readSpokenAction("crack in the car park, keep an eye on it"), { title: "Crack in the car park, keep an eye on it", severity: "monitor" });
  assert.deepEqual(readSpokenAction("socket sparking in the office"), { title: "Socket sparking in the office", severity: "urgent" });
  assert.deepEqual(readSpokenAction("report"), { title: "Report", severity: "action_required" }, "never an empty title");
  assert.equal(readSpokenAction("x".repeat(600)).title.length, 500);

  console.log("voice-actions tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
