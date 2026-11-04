import assert from "node:assert/strict";
import { MAX_SHOWN_MS, MIN_SHOWN_MS, UNTIL_CLOSED, holdsInstructions, toastDuration } from "../src/lib/toast-duration.ts";

// Instructions stay open until closed.
assert.equal(toastDuration({
  title: "Drop it on an upload box",
  description: "This page doesn't take files. Open the record first, then drag the file onto its photos or upload box.",
}), UNTIL_CLOSED);
assert.equal(toastDuration({ title: "Choose a site" }), UNTIL_CLOSED, "a short instruction still stays");
assert.equal(toastDuration({ title: "Couldn't save", description: "Your session has ended. Please log in again." }), UNTIL_CLOSED);
assert.equal(toastDuration({ title: "Label replaced", description: "The old label no longer works. Print the new one and stick it on." }), UNTIL_CLOSED);
assert.equal(toastDuration({ title: "Not sent", description: "You need to add an email address for this contractor." }), UNTIL_CLOSED);
assert.equal(toastDuration({ title: "Import failed", description: "Something went wrong — try again in a minute." }), UNTIL_CLOSED);

// Plain results close themselves, after long enough to read.
for (const message of [
  { title: "Saved" },
  { title: "Check saved" },
  { title: "Record deleted" },
  { title: "Upload failed", variant: "destructive" },
  { title: "Couldn't load starter pack" },
  { title: "Certificate removed" },
  { title: "Contractor updated", description: "Contractor emails from now on show the new address." },
]) {
  const shown = toastDuration(message);
  assert.ok(shown >= MIN_SHOWN_MS && shown <= MAX_SHOWN_MS, `${message.title} closes itself (${shown} ms)`);
}
assert.equal(toastDuration({ title: "Saved" }), MIN_SHOWN_MS, "even a one-word message stays up long enough to see");

// Long messages, links and buttons stay.
assert.equal(toastDuration({
  title: "Import finished",
  description: "12 checks were updated and 5 were added, with their contractors linked where the spreadsheet gave an email address for them.",
}), UNTIL_CLOSED, "a long message stays");
assert.equal(toastDuration({ title: "Saved", description: { type: "a", props: {} } }), UNTIL_CLOSED, "a message with a link stays");
assert.equal(toastDuration({ title: "Deleted", action: {} }), UNTIL_CLOSED, "a message with a button stays");

// The caller can decide.
assert.equal(toastDuration({ title: "Saved", stay: true }), UNTIL_CLOSED);
assert.equal(toastDuration({ title: "Choose a site", stay: false }), MIN_SHOWN_MS);
assert.equal(toastDuration({ title: "Choose a site", duration: 2000 }), 2000);

assert.equal(holdsInstructions("Failed to send reminder"), false);
assert.equal(holdsInstructions("Reminder sent. Ask the contractor to reply."), true);

console.log("toast-duration tests passed");
