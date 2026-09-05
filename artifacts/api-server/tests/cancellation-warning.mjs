import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-cancellation-warning-"));
const outFile = path.join(outDir, "warning.mjs");

try {
  await build({
    entryPoints: [path.join(testsDir, "cancellation-warning.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "@google-cloud/*"],
    banner: {
      js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);",
    },
  });
  const { sendCancellationWarningEmail } = await import(new URL(`file://${outFile}`).href);
  const future = new Date(Date.now() + 86_400_000).toISOString();

  // A delayed cancellation webhook must not notify after a renewal. The first
  // (authoritative Stripe-state) lookup has no actionable cancellation.
  let sends = 0;
  const renewed = await sendCancellationWarningEmail(
    { stripeCustomerId: "cus_renewed", accessEndsAt: future },
    {
      execute: async () => ({ rows: [] }),
      sendEmail: async () => { sends++; },
    },
  );
  assert.equal(renewed.emailsSent, 0);
  assert.equal(sends, 0, "renewed customers must not be warned");

  // A duplicate webhook sees an existing delivery claim and sends nothing.
  const duplicateResults = [
    { rows: [{ customer: "cus_a", access_ends_at: future }] },
    { rows: [{ id: 7, name: "Tenant A" }] },
    { rows: [{ id: 9, name: "Manager", email: "manager@example.test" }] },
    { rows: [] },
  ];
  const duplicate = await sendCancellationWarningEmail(
    { stripeCustomerId: "cus_a", accessEndsAt: future },
    { execute: async () => duplicateResults.shift(), sendEmail: async () => { sends++; } },
  );
  assert.equal(duplicate.emailsSent, 0);
  assert.equal(sends, 0, "an already-claimed delivery must be deduplicated");

  // One failed recipient is released while the successfully delivered manager
  // remains marked sent; the next run can retry only the failed recipient.
  const partialResults = [
    { rows: [{ customer: "cus_b", access_ends_at: future }] },
    { rows: [{ id: 11, name: "Tenant B" }] },
    { rows: [
      { id: 12, name: "First", email: "first@example.test" },
      { id: 13, name: "Second", email: "second@example.test" },
    ] },
    { rows: [{ id: 1 }] }, // first claim
    { rows: [{ id: 1 }] }, // first authoritative handoff
    { rows: [{ id: 1 }] }, // first sent marker
    { rows: [{ id: 2 }] }, // second claim
    { rows: [{ id: 2 }] }, // second authoritative handoff
    { rows: [] },          // second release after explicit provider failure
  ];
  const messages = [];
  const partial = await sendCancellationWarningEmail(
    { stripeCustomerId: "cus_b", accessEndsAt: future },
    {
      execute: async () => partialResults.shift(),
      getAppUrl: () => "https://app.example.test",
      sendEmail: async (message) => {
        messages.push(message);
        if (message.to === "second@example.test") throw new Error("mail provider unavailable");
      },
    },
  );
  assert.equal(partial.emailsSent, 1);
  assert.equal(messages.length, 2);
  assert.match(messages[0].text, /https:\/\/app\.example\.test\/settings/);
  assert.match(messages[0].text, /access will continue until/);

  // A handed-off lease is terminal if final sent_at persistence fails: a
  // follow-up worker cannot claim it, so it cannot create a second provider
  // handoff after the original provider accepted the message.
  const finalizationResults = [
    { rows: [{ customer: "cus_c", access_ends_at: future }] },
    { rows: [{ id: 21, name: "Tenant C" }] },
    { rows: [{ id: 22, name: "Manager", email: "manager-c@example.test" }] },
    { rows: [{ id: 3, lease_token: "lease-c" }] },
    { rows: [{ id: 3 }] },
    Promise.reject(new Error("database finalization unavailable")),
  ];
  let acceptedSends = 0;
  const executeFinalization = async () => {
    const next = finalizationResults.shift();
    return await next;
  };
  const accepted = await sendCancellationWarningEmail(
    { stripeCustomerId: "cus_c", accessEndsAt: future },
    { execute: executeFinalization, sendEmail: async () => { acceptedSends++; } },
  );
  assert.equal(acceptedSends, 1);
  assert.equal(accepted.emailsSent, 0, "only completed sent markers are counted");

  // A concurrent/late worker gets no claim for an in-progress or handed-off
  // lease (including one whose original lease timer has elapsed).
  const noReclaimResults = [
    { rows: [{ customer: "cus_c", access_ends_at: future }] },
    { rows: [{ id: 21, name: "Tenant C" }] },
    { rows: [{ id: 22, name: "Manager", email: "manager-c@example.test" }] },
    { rows: [] },
  ];
  await sendCancellationWarningEmail(
    { stripeCustomerId: "cus_c", accessEndsAt: future },
    { execute: async () => noReclaimResults.shift(), sendEmail: async () => { acceptedSends++; } },
  );
  assert.equal(acceptedSends, 1, "lease expiry must not cause a second handoff");

  // If renewal arrives after the initial lookup but before handoff, the
  // authority-gated transition returns no row and the provider is never called.
  const renewedDuringClaim = [
    { rows: [{ customer: "cus_d", access_ends_at: future }] },
    { rows: [{ id: 31, name: "Tenant D" }] },
    { rows: [{ id: 32, name: "Manager", email: "manager-d@example.test" }] },
    { rows: [{ id: 4, lease_token: "lease-d" }] },
    { rows: [] }, // atomic handoff check sees the renewed subscription
    { rows: [] }, // owner-only pre-handoff release
  ];
  let renewalRaceSends = 0;
  await sendCancellationWarningEmail(
    { stripeCustomerId: "cus_d", accessEndsAt: future },
    {
      execute: async () => renewedDuringClaim.shift(),
      sendEmail: async () => { renewalRaceSends++; },
    },
  );
  assert.equal(renewalRaceSends, 0, "renewal between claim and handoff must suppress delivery");

  console.log("Cancellation warning regression tests passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}