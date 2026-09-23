import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "src/pages/contractor-approvals.tsx"), "utf8");

assert.match(
  source,
  /const isCancellation = item\.emailType === "cancellation";/,
  "approval rows must identify cancellation emails by their email type",
);
assert.match(
  source,
  /isCancellation\s*\?\s*"Calendar Cancellation"\s*:/,
  "pending cancellations must have a distinct Calendar Cancellation label",
);
assert.match(
  source,
  /This cancels an existing calendar event/,
  "cancellation previews and edit forms must warn that an existing event is affected",
);
assert.match(
  source,
  /Approving sends the contractor a cancellation notice and removes the previously sent assignment from their calendar\./,
  "cancellation guidance must explain the calendar-removal consequence",
);
assert.match(
  source,
  /Approve this calendar cancellation\? It will send the contractor a cancellation notice and remove the previously sent calendar event\./,
  "approving a cancellation must require an explicit calendar-removal confirmation",
);
assert.match(
  source,
  /isCancellation\s*\?\s*"Approve Cancellation"\s*:\s*"Approve & Send"/,
  "cancellations must use an explicit approval action while assignments retain Approve & Send",
);
assert.match(
  source,
  /isCancellation\s*\?\s*"Dismiss"\s*:\s*"Cancel"/,
  "cancellations must use Dismiss while ordinary email requests retain Cancel",
);
assert.match(
  source,
  /isCancellation\s*\?\s*"Save & Send Cancellation"\s*:\s*"Save & Send"/,
  "edited cancellations must keep a distinct send action while ordinary drafts retain Save & Send",
);
assert.match(
  source,
  /item\.emailType === "quote_request"\s*\?\s*"Requesting Quote"/,
  "quote rows must retain the Requesting Quote label",
);
assert.match(
  source,
  /item\.emailType === "quote_request"\s*\?\s*"Requesting Quote"[\s\S]*?"Assigning Job"/,
  "assignment rows must retain the Assigning Job fallback label beside quote wording",
);

console.log("Contractor approvals cancellation safeguards passed.");