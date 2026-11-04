import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// "Say it" fills in each track's own form (src/lib/voice-forms.ts): what it
// reads from the words for each track. Only suggestions: the track's form
// opens with them filled in and the person checks it and taps Save.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "voice-forms-"));
try {
  const bundle = path.join(dir, "voice-forms.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/voice-forms.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const { readSayItForm, FORM_TRACKS, FORM_EXAMPLES, OPEN_FORM_TRACKS } = await import(pathToFileURL(bundle).href);
  const read = (track, text) => {
    const r = readSayItForm(text, track);
    return r && { form: r.form, ...(r.item ? { item: r.item } : {}), values: r.values };
  };

  // Every track with a form has an example to show on the card.
  for (const track of FORM_TRACKS) assert.ok(FORM_EXAMPLES[track], `${track} has an example`);
  for (const track of OPEN_FORM_TRACKS) assert.ok(FORM_TRACKS.includes(track), track);

  // AquaTrack: a pool test, or a surveillance scan.
  assert.deepEqual(read("pool", "pH 7.4, free chlorine 1.5, combined 0.2, water 29 degrees"),
    { form: "pool-test", values: { ph: 7.4, combinedChlorine: 0.2, freeChlorine: 1.5, waterTemp: 29 } });
  assert.deepEqual(read("pool", "opening check p h seven point four chlorine one point two water clear"),
    { form: "pool-test", values: { ph: 7.4, freeChlorine: 1.2, turbidity: "clear", checkType: "opening" } });
  assert.deepEqual(read("pool", "surveillance scan done 24 bathers"),
    { form: "swim-surveillance", values: { batherCount: 24, scanCompleted: true } });
  assert.equal(read("pool", "the pool gate latch is broken"), null, "a problem is an action, not a test");

  // TubTrack: the tub said and its readings.
  assert.deepEqual(read("hot_tub", "hot tub 2 pH 7.4 chlorine 4 38 degrees"),
    { form: "tub-test", item: "hot tub 2", values: { ph: 7.4, sanitiser: 4, temperature: 38 } });
  assert.deepEqual(read("hot_tub", "garden spa ph 7.2 bromine 5 temperature 37"),
    { form: "tub-test", item: "garden spa", values: { ph: 7.2, sanitiser: 5, temperature: 37 } });

  // PATtrack: the appliance and its result.
  assert.deepEqual(read("pat", "kettle in the staff room passed"), { form: "pat-test", item: "kettle in staff room", values: { result: "pass" } });
  assert.deepEqual(read("pat", "toaster 3 failed"), { form: "pat-test", item: "toaster 3", values: { result: "fail" } });
  assert.equal(read("pat", "kettle cable frayed").values.result, "fail", "damage is a fail");

  // PestTrack: the pest, what was seen, where, and how bad.
  assert.deepEqual(read("pest", "mouse droppings in the dry store").values,
    { notes: "mouse droppings in the dry store", pestType: "rodent", evidenceType: "droppings", location: "Dry store" });
  assert.deepEqual(read("pest", "saw a rat behind the bins, urgent").values,
    { notes: "saw a rat behind the bins, urgent", pestType: "rodent", evidenceType: "live_sighting", location: "Bins", severity: "high" });

  // RoomTrack: the room and its ticks; a problem is a note.
  assert.deepEqual(read("room", "room 4 all done"), { form: "room-check", item: "room 4", values: { clean: true, tidy: true, toStandard: true } });
  assert.deepEqual(read("room", "room 12 clean and tidy").values, { clean: true, tidy: true, toStandard: false });
  assert.deepEqual(read("room", "room 7 shower is leaking").values,
    { clean: false, tidy: false, toStandard: false, notes: "Room 7 shower is leaking" });

  // TreeTrack: the tree, where it is, and the result.
  assert.deepEqual(read("tree", "tree T12 by the car park dead branch hanging urgent").values, {
    notes: "Tree T12 by the car park dead branch hanging urgent", treeRef: "T12", location: "Car park", result: "fail", actionSeverity: "urgent_action",
  });
  assert.deepEqual(read("tree", "tree 4 no concerns").values, { notes: "Tree 4 no concerns", treeRef: "4", result: "pass" });

  // BikeTrack: the bike and whether it's going out, coming back or being serviced.
  assert.deepEqual(read("bike", "bike 4 is back"), { form: "bike", item: "bike 4", values: { intent: "return", notes: "bike 4 is back" } });
  assert.equal(read("bike", "service bike 12 brakes").values.intent, "service");
  assert.equal(read("bike", "hire out bike 3").values.intent, "hire");

  // GreenTrack: the machine and a pre-use check, fuel, hours or a defect.
  assert.deepEqual(read("green", "fairway mower 1 pre-use check"), { form: "machine", item: "fairway mower 1", values: { intent: "pre-use" } });
  assert.deepEqual(read("green", "greens mower 2 filled 20 litres of diesel"), { form: "machine", item: "greens mower 2", values: { intent: "fuel", litres: 20 } });
  assert.deepEqual(read("green", "tractor hours 1250"), { form: "machine", item: "tractor", values: { intent: "hours", hours: 1250 } });
  assert.deepEqual(read("green", "fairway mower 2 has a hydraulic leak"),
    { form: "machine", item: "fairway mower 2", values: { intent: "defect", description: "Fairway mower 2 has a hydraulic leak" } });

  // TrainTrack: who completed which training, and when.
  assert.deepEqual(read("train", "Jane Smith completed fire marshal training today").values, { staffName: "Jane Smith", trainingType: "Fire marshal", date: "today" });
  assert.deepEqual(read("train", "john passed level 2 food hygiene yesterday").values, { staffName: "John", trainingType: "Level 2 food hygiene", date: "yesterday" });
  assert.equal(read("train", "the training room is cold"), null);

  // Incidents, PremisesTrack and FixTrack open a new record with the words.
  assert.deepEqual(read("incident", "guest slipped on the wet floor in the bar and hurt her wrist").values,
    { description: "Guest slipped on the wet floor in the bar and hurt her wrist", location: "Bar" });
  assert.deepEqual(read("premises", "stairwell, loose handrail on the top flight").values,
    { findings: "Loose handrail on the top flight", area: "Stairwell", actionRequired: "Loose handrail on the top flight" });
  assert.deepEqual(read("fix", "light out in the back corridor urgent").values, { title: "Light out in the back corridor", location: "Back corridor", urgent: true });

  // Tracks without a form here read nothing.
  assert.equal(read("kitchen", "fridge 1 is 4 degrees"), null);

  console.log("voice-forms tests passed");
} finally {
  await rm(dir, { recursive: true, force: true });
}
