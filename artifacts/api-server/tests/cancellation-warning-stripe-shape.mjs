// Cancellation warnings and the in-app banner against real synced Stripe rows.
// The stripe.* columns are integer Unix seconds, and Stripe API versions from
// 2025-03-31.basil (what the app and the sync library request) no longer put
// current_period_end on the subscription. Runs only inside the disposable
// database:
//   bash tests/run-fresh-schema.sh tests/cancellation-warning-stripe-shape.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMigrations } from "stripe-replit-sync";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The cancellation warning Stripe-shape test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-cancellation-shape-"));
let offboarding;
try {
  const output = path.join(temp, "offboarding.mjs");
  await build({
    entryPoints: [path.join(testsDir, "cancellation-warning.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  offboarding = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const nowSeconds = Math.floor(Date.now() / 1000);
const day = 86_400;
// Basil-shaped subscription: no top-level current_period_end.
const insertSubscription = (fields) => db.execute(sql`
  INSERT INTO stripe.subscriptions (_raw_data, _account_id)
  VALUES (${JSON.stringify({ object: "subscription", created: nowSeconds - 30 * day, ...fields })}::jsonb, 'acct_shape_test')`);
const setCustomer = (tenant, customer) =>
  db.execute(sql`UPDATE clients SET stripe_customer_id = ${customer} WHERE id = ${tenant.clientId}`);

// The production API creates the sync schema at start-up; the fresh-schema
// test server does not, so build it here with the same library call.
await runMigrations({ databaseUrl: process.env.DATABASE_URL });
await db.execute(sql`INSERT INTO stripe.accounts (_raw_data)
  VALUES (${JSON.stringify({ id: "acct_shape_test", object: "account" })}::jsonb) ON CONFLICT DO NOTHING`);

try {
  const scheduled = await createTenant("cancel-shape-scheduled");
  const ended = await createTenant("cancel-shape-ended");
  const renewed = await createTenant("cancel-shape-renewed");
  await setCustomer(scheduled, "cus_shape_scheduled");
  await setCustomer(ended, "cus_shape_ended");
  await setCustomer(renewed, "cus_shape_renewed");

  const accessEnds = nowSeconds + 10 * day;
  // Scheduled from the billing portal: Stripe sets cancel_at to the period end.
  await insertSubscription({ id: "sub_shape_scheduled", customer: "cus_shape_scheduled", status: "active",
    cancel_at_period_end: true, cancel_at: accessEnds });
  // Cancelled outright (e.g. after failed payments): only ended_at is set.
  await insertSubscription({ id: "sub_shape_ended", customer: "cus_shape_ended", status: "canceled",
    cancel_at_period_end: false, cancel_at: null, ended_at: nowSeconds - day });
  await insertSubscription({ id: "sub_shape_renewed_old", customer: "cus_shape_renewed", status: "canceled",
    cancel_at_period_end: false, cancel_at: null, ended_at: nowSeconds - 2 * day });
  await insertSubscription({ id: "sub_shape_renewed", customer: "cus_shape_renewed", status: "active",
    cancel_at_period_end: false, cancel_at: null, created: nowSeconds - day });

  const sent = [];
  const sendEmail = async (message) => { sent.push(message); };
  const deps = { sendEmail, getAppUrl: () => "https://app.example.test" };

  // The daily reconciliation must run (it failed on integer > timestamp) and
  // warn exactly the two cancelled businesses, once each.
  const first = await offboarding.runCancellationWarningJob(deps);
  const scheduledMail = sent.filter((m) => m.idempotencyKey.startsWith(`cancellation-warning:${scheduled.clientId}:`));
  const endedMail = sent.filter((m) => m.idempotencyKey.startsWith(`cancellation-warning:${ended.clientId}:`));
  const renewedMail = sent.filter((m) => m.idempotencyKey.startsWith(`cancellation-warning:${renewed.clientId}:`));
  assert.equal(scheduledMail.length, 1, "a scheduled cancellation warns its owner once");
  assert.match(scheduledMail[0].subject, /access is ending/);
  assert.match(scheduledMail[0].text, /access will continue until/);
  assert.match(scheduledMail[0].text, /https:\/\/app\.example\.test\/settings#data-export/);
  assert.equal(endedMail.length, 1, "an outright cancellation (ended_at only) still gets its ended notice");
  assert.match(endedMail[0].subject, /has ended/);
  assert.equal(renewedMail.length, 0, "a renewed business is never warned");
  assert.equal(first.emailsSent, 2);

  // A webhook for the same cancellation, and a second reconciliation, are
  // deduplicated by the delivery claim.
  const webhook = await offboarding.sendCancellationWarningEmail(
    { stripeCustomerId: "cus_shape_scheduled", accessEndsAt: accessEnds }, deps);
  assert.equal(webhook.emailsSent, 0);
  const second = await offboarding.runCancellationWarningJob(deps);
  assert.equal(second.emailsSent, 0);
  assert.equal(sent.length, 2, "no second warning for the same cutoff");

  // The in-app banner reads the same synced row (it returned 503 before).
  const banner = await scheduled.request("GET", "/billing/cancellation-status");
  assert.equal(banner.status, 200, JSON.stringify(banner.data));
  assert.equal(new Date(banner.data.accessEndsAt).getTime(), accessEnds * 1000);
  const noBanner = await renewed.request("GET", "/billing/cancellation-status");
  assert.equal(noBanner.status, 200, JSON.stringify(noBanner.data));
  assert.equal(noBanner.data.accessEndsAt, null);

  console.log("Cancellation warning Stripe-shape tests passed.");
} finally {
  await pool.end();
}
