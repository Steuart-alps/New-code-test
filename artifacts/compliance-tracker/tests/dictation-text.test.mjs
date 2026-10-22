import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Text rules for voice dictation (src/lib/dictation.ts): where spoken words go
// in a box, spoken punctuation, capitals, length limits, and how a spoken
// list of substances is split into separate products.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "dictation-text-"));
try {
  const bundle = path.join(dir, "dictation.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/dictation.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const { applySpokenPunctuation, insertDictatedText, splitSpokenList, dictationErrorMessage, normaliseSpokenName, matchSpokenName } =
    await import(pathToFileURL(bundle).href);

  // Spoken punctuation.
  assert.equal(applySpokenPunctuation("doors checked full stop all fine"), "doors checked. all fine");
  assert.equal(applySpokenPunctuation("gloves comma goggles comma apron"), "gloves, goggles, apron");
  assert.equal(applySpokenPunctuation("first new line second new paragraph third"), "first\nsecond\n\nthird");
  assert.equal(applySpokenPunctuation("is it working question mark"), "is it working?");
  assert.equal(applySpokenPunctuation("over the period of a month"), "over the period of a month", "\"period\" is a normal word");

  // Inserting into an empty box: capital first letter, sentences capitalised.
  assert.deepEqual(insertDictatedText("", "fire doors checked full stop all fine"),
    { value: "Fire doors checked. All fine", cursor: 28 });
  // Appending: a space is added, no capital mid-sentence.
  assert.deepEqual(insertDictatedText("Kitchen", "floor wet"), { value: "Kitchen floor wet", cursor: 17 });
  // After a full stop the new sentence gets a capital.
  assert.equal(insertDictatedText("Checked.", "no issues").value, "Checked. No issues");
  // After a new line too.
  assert.equal(insertDictatedText("Line one\n", "line two").value, "Line one\nLine two");
  // Inserting in the middle keeps spaces either side.
  const middle = insertDictatedText("Boiler pressure low", "very", 15, 15);
  assert.deepEqual(middle, { value: "Boiler pressure very low", cursor: 20 });
  // Replacing a selection.
  assert.equal(insertDictatedText("Boiler pressure low", "high", 16, 19).value, "Boiler pressure high");
  // Spoken punctuation at the start does not get a leading space.
  assert.equal(insertDictatedText("All fine", "full stop").value, "All fine.");
  // maxLength is respected.
  assert.equal(insertDictatedText("12345", "abcdefghij", 5, 5, 10).value, "12345 abcd");
  assert.equal(insertDictatedText("1234567890", "more", 10, 10, 10).value, "1234567890");
  // Nothing said leaves the box alone.
  assert.deepEqual(insertDictatedText("Keep", "   "), { value: "Keep", cursor: 4 });

  // Spoken lists.
  assert.deepEqual(splitSpokenList("thick bleach, oven cleaner and Milton sterilising fluid"),
    ["Thick bleach", "Oven cleaner", "Milton sterilising fluid"]);
  assert.deepEqual(splitSpokenList("thick bleach\noven cleaner\nthick bleach"), ["Thick bleach", "Oven cleaner"],
    "pauses (new lines) split items and repeats are dropped");
  assert.deepEqual(splitSpokenList("degreaser comma glass cleaner full stop then descaler next chlorine tablets"),
    ["Degreaser", "Glass cleaner", "Descaler", "Chlorine tablets"]);
  assert.deepEqual(splitSpokenList("erm WD-40; Diesel 2.5 litres."), ["WD-40", "Diesel 2.5 litres"]);
  assert.deepEqual(splitSpokenList("  ,, and  "), []);

  // Saying a name from a list (a GreenTrack machine, a call point).
  assert.equal(normaliseSpokenName("Fairway Mower one"), "fairway mower 1");
  assert.equal(normaliseSpokenName("the number twenty one greens mower please"), "21 greens mower");
  assert.equal(normaliseSpokenName("Pre-start check for mower1, 2nd"), "mower 1 2");
  assert.equal(normaliseSpokenName("first floor"), "1 floor");
  const machines = ["Fairway Mower 1", "Fairway Mower 2", "Greens Mower 1", "Greens Mower 2", "Tees Mower", "Utility Vehicle", "Toro Workman 3"]
    .map((name, id) => ({ id, name }));
  const picked = (spoken) => matchSpokenName(spoken, machines).match?.name ?? null;
  const offered = (spoken) => matchSpokenName(spoken, machines).choices.map((m) => m.name);
  assert.equal(picked("fairway mower one"), "Fairway Mower 1");
  assert.equal(picked("Fairway mower 1."), "Fairway Mower 1");
  assert.equal(picked("pre-start check for fairway mower number one"), "Fairway Mower 1");
  assert.equal(picked("fairway mowers one"), "Fairway Mower 1", "plurals still match");
  assert.equal(picked("the number two greens mower please"), "Greens Mower 2", "word order and filler don't matter");
  assert.equal(picked("workman three"), "Toro Workman 3", "part of the name is enough when only one fits");
  assert.equal(picked("utilty vehicle"), "Utility Vehicle", "a one-letter slip in a long word still matches");
  assert.equal(picked("fairway mower"), null, "two fairway mowers: nothing picked");
  assert.deepEqual(offered("fairway mower").slice(0, 2), ["Fairway Mower 1", "Fairway Mower 2"], "both offered to tap");
  assert.equal(picked("greens mower 3"), null, "a number not in the name rules it out");
  assert.deepEqual(offered("greens mower 3"), []);
  assert.deepEqual(offered("nothing like it"), []);
  assert.equal(matchSpokenName("mower 1", [{ id: 1, name: "Mower 1" }, { id: 2, name: "mower one" }]).match, null,
    "two items with the same name: both offered");
  assert.equal(matchSpokenName("ab12 cde", [{ id: 1, name: "Big tractor", aliases: ["AB12 CDE", null] }]).match?.id, 1,
    "an alias such as a registration matches");

  assert.match(dictationErrorMessage("not-allowed"), /Allow the microphone/);
  assert.equal(dictationErrorMessage("no-speech"), null);
  console.log("Dictation text checks passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
