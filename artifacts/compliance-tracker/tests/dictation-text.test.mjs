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
  const { applySpokenPunctuation, insertDictatedText, splitSpokenList, dictationErrorMessage } =
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

  assert.match(dictationErrorMessage("not-allowed"), /Allow the microphone/);
  assert.equal(dictationErrorMessage("no-speech"), null);
  console.log("Dictation text checks passed.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
