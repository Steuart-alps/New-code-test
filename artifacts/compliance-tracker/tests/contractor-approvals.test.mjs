import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "src/pages/contractor-approvals.tsx"), "utf8");
const actionSource = await readFile(
  path.join(root, "src/lib/contractor-approval-actions.ts"),
  "utf8",
);

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
  /approveContractorEmail/,
  "approving a cancellation must require an explicit calendar-removal confirmation",
);
assert.match(
  actionSource,
  /CANCELLATION_APPROVAL_CONFIRMATION[\s\S]*remove the previously sent calendar event\./,
  "the approval interaction must use the calendar-removal confirmation",
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

const tempDir = await mkdtemp(path.join(tmpdir(), "contractor-approvals-"));
const helperBundle = path.join(tempDir, "contractor-approval-actions.mjs");
try {
  await build({
    entryPoints: [path.join(root, "src/lib/contractor-approval-actions.ts")],
    outfile: helperBundle,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const {
    approveContractorEmail,
    dismissContractorEmail,
    CANCELLATION_APPROVAL_CONFIRMATION,
    CANCELLATION_DISMISS_CONFIRMATION,
  } = await import(`${pathToFileURL(helperBundle).href}?t=${Date.now()}`);

  const requests = [];
  let confirmationAnswer = false;
  const confirmations = [];
  const actions = {
    confirm: message => {
      confirmations.push(message);
      return confirmationAnswer;
    },
    clientApiFetch: async (requestPath, init) => {
      requests.push({ requestPath, init });
      return { ok: true, status: 200 };
    },
  };

  const blockedCancellation = await approveContractorEmail(
    { id: 42, emailType: "cancellation" },
    actions,
  );
  assert.equal(blockedCancellation.confirmed, false);
  assert.deepEqual(confirmations, [CANCELLATION_APPROVAL_CONFIRMATION]);
  assert.equal(requests.length, 0, "declining cancellation approval must not call the API");

  confirmationAnswer = true;
  const approvedCancellation = await approveContractorEmail(
    { id: 42, emailType: "cancellation" },
    actions,
  );
  assert.equal(approvedCancellation.confirmed, true);
  assert.equal(requests.at(-1).requestPath, "/fix-track/contractor-email-queue/42/approve-and-send");

  const editedCancellation = await approveContractorEmail(
    { id: 43, emailType: "cancellation" },
    actions,
    { subject: "Calendar cancellation: Revised", text: "The event is no longer required." },
  );
  assert.equal(editedCancellation.confirmed, true);
  assert.equal(requests.at(-1).requestPath, "/fix-track/contractor-email-queue/43/edit-and-send");
  assert.deepEqual(JSON.parse(requests.at(-1).init.body), {
    subject: "Calendar cancellation: Revised",
    bodyText: "The event is no longer required.",
  });

  confirmationAnswer = false;
  const blockedDismissal = await dismissContractorEmail(
    { id: 44, emailType: "cancellation" },
    actions,
  );
  assert.equal(blockedDismissal.confirmed, false);
  assert.equal(confirmations.at(-1), CANCELLATION_DISMISS_CONFIRMATION);
  assert.equal(requests.at(-1).requestPath, "/fix-track/contractor-email-queue/43/edit-and-send");

  confirmationAnswer = true;
  const dismissedCancellation = await dismissContractorEmail(
    { id: 44, emailType: "cancellation" },
    actions,
  );
  assert.equal(dismissedCancellation.confirmed, true);
  assert.equal(requests.at(-1).requestPath, "/fix-track/contractor-email-queue/44/cancel");

  const assignment = await approveContractorEmail(
    { id: 45, emailType: "assignment" },
    actions,
  );
  assert.equal(assignment.confirmed, true);
  assert.equal(requests.at(-1).requestPath, "/fix-track/contractor-email-queue/45/approve-and-send");
  assert.equal(confirmations.length, 5, "ordinary assignment approval must not ask for cancellation confirmation");

  const quoteDismissed = await dismissContractorEmail(
    { id: 46, emailType: "quote_request" },
    actions,
  );
  assert.equal(quoteDismissed.confirmed, true);
  assert.equal(confirmations.at(-1), "Are you sure you want to cancel this email request?");
  assert.equal(requests.at(-1).requestPath, "/fix-track/contractor-email-queue/46/cancel");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("Contractor approvals cancellation safeguards passed.");