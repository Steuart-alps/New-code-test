// The 12-month retention clock: started for cancelled subscriptions and lapsed
// trials, never started on a Stripe error or for a business that is free with
// no trial end, cleared on resubscription, and
// rechecked against Stripe before a retention deletion. Runs only inside the
// disposable database:
//   bash tests/run-fresh-schema.sh tests/retention-clock.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The retention clock test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-retention-clock-"));
let offboarding;
try {
  const output = path.join(temp, "offboarding.mjs");
  await build({
    entryPoints: [path.join(testsDir, "client-data-deletion-feedback.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  offboarding = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const row = async (clientId) => (await db.execute(sql`
  SELECT cancelled_at, data_deletion_scheduled_at, data_deleted_at, offboarding_email_sent_at, trial_ends_at
  FROM clients WHERE id = ${clientId}`)).rows[0];
const monthsBetween = (from, to) => (new Date(to).getUTCFullYear() - new Date(from).getUTCFullYear()) * 12
  + new Date(to).getUTCMonth() - new Date(from).getUTCMonth();

try {
  const cancelled = await createTenant("retention-cancelled");
  const resubscribed = await createTenant("retention-resubscribed");
  const lapsedTrial = await createTenant("retention-lapsed-trial");
  const stripeDown = await createTenant("retention-stripe-down");
  const activeTrial = await createTenant("retention-active-trial");
  // Created directly: the fixture's sign-ups are limited to five an hour.
  const complimentary = { clientId: Number((await db.execute(sql`
    INSERT INTO clients (name, slug) VALUES ('Retention complimentary', ${`retention-complimentary-${Date.now()}`})
    RETURNING id`)).rows[0].id) };
  const setCustomer = (tenant, customer) =>
    db.execute(sql`UPDATE clients SET stripe_customer_id = ${customer} WHERE id = ${tenant.clientId}`);
  await setCustomer(cancelled, "cus_retention_cancelled");
  await setCustomer(resubscribed, "cus_retention_resubscribed");
  await setCustomer(stripeDown, "cus_retention_down");
  // Free with no trial end, and once bought an extra it has since cancelled.
  await setCustomer(complimentary, "cus_retention_complimentary");
  await db.execute(sql`UPDATE clients SET trial_ends_at = NULL WHERE id = ${complimentary.clientId}`);
  await db.execute(sql`UPDATE clients SET cancelled_at = now() - interval '2 months',
    data_deletion_scheduled_at = now() + interval '10 months', offboarding_email_sent_at = now() - interval '2 months'
    WHERE id = ${resubscribed.clientId}`);
  await db.execute(sql`UPDATE clients SET trial_ends_at = now() - interval '3 days' WHERE id = ${lapsedTrial.clientId}`);

  const sent = [];
  const scope = [cancelled, resubscribed, lapsedTrial, stripeDown, activeTrial, complimentary].map((tenant) => tenant.clientId);
  const result = await offboarding.runCancellationDetectionJob({
    clientIds: scope,
    findLiveSubscription: async (customer) => {
      if (customer === "cus_retention_down") throw new Error("Stripe unavailable");
      return customer === "cus_retention_resubscribed" ? { id: "sub_live", status: "active" } : null;
    },
    getSubscriptionHistory: async (customer) => ({
      any: true,
      canceled: customer === "cus_retention_cancelled" || customer === "cus_retention_complimentary",
    }),
    sendEmail: async (message) => { sent.push(message); },
  });
  assert.deepEqual(
    { detected: result.clientsDetected, lapsed: result.trialsLapsed, reactivated: result.clientsReactivated, skipped: result.skipped },
    { detected: 1, lapsed: 1, reactivated: 1, skipped: 1 },
    JSON.stringify(result),
  );

  const c = await row(cancelled.clientId);
  assert.ok(c.cancelled_at && c.data_deletion_scheduled_at, "a cancelled subscription starts the clock");
  assert.equal(monthsBetween(c.cancelled_at, c.data_deletion_scheduled_at), 12);
  const r = await row(resubscribed.clientId);
  assert.equal(r.cancelled_at, null, "a live subscription clears the clock");
  assert.equal(r.data_deletion_scheduled_at, null);
  const t = await row(lapsedTrial.clientId);
  assert.equal(new Date(t.cancelled_at).getTime(), new Date(t.trial_ends_at).getTime(), "a lapsed trial's clock starts at trial end");
  assert.equal(monthsBetween(t.trial_ends_at, t.data_deletion_scheduled_at), 12);
  assert.equal((await row(stripeDown.clientId)).cancelled_at, null, "a Stripe error never starts the clock");
  assert.equal((await row(activeTrial.clientId)).cancelled_at, null, "a running trial is untouched");
  const comp = await row(complimentary.clientId);
  assert.equal(comp.cancelled_at, null, "a business free with no trial end never starts the clock");
  assert.equal(comp.data_deletion_scheduled_at, null);
  assert.ok(sent.some((message) => /free trial has ended/i.test(message.html)), "the lapsed trial is warned");
  assert.ok(sent.some((message) => /subscription has ended/i.test(message.html)), "the cancelled subscriber is warned");
  assert.ok(sent.every((message) => message.idempotencyKey), "offboarding emails carry provider idempotency keys");

  // Retention deletion rechecks Stripe: a customer who resubscribed after the
  // clock started is not deleted, and the clock is cleared instead.
  await db.execute(sql`UPDATE clients SET data_deletion_scheduled_at = now() - interval '1 day' WHERE id = ${cancelled.clientId}`);
  const deleted = await offboarding.runDataDeletionJob({
    clientIds: [cancelled.clientId],
    findLiveSubscription: async () => ({ id: "sub_back", status: "active" }),
    sendEmail: async () => {},
  });
  assert.equal(deleted.clientsDeleted, 0);
  const back = await row(cancelled.clientId);
  assert.equal(back.data_deleted_at, null, "a resubscribed customer is not deleted");
  assert.equal(back.data_deletion_scheduled_at, null, "and the clock is cleared");

  // And a Stripe error on that recheck fails closed (no deletion, run fails).
  await db.execute(sql`UPDATE clients SET cancelled_at = now() - interval '13 months',
    data_deletion_scheduled_at = now() - interval '1 day' WHERE id = ${cancelled.clientId}`);
  await assert.rejects(offboarding.runDataDeletionJob({
    clientIds: [cancelled.clientId],
    findLiveSubscription: async () => { throw new Error("Stripe unavailable"); },
    sendEmail: async () => {},
  }), /Data deletion failed/);
  assert.equal((await row(cancelled.clientId)).data_deleted_at, null, "nothing is deleted while Stripe is unreachable");
  console.log("Retention clock checks passed.");
} finally {
  await pool.end();
}
