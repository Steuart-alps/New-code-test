// ALPS billing alerts from the Stripe webhook (new subscriptions and
// cancellations emailed once, plan changes recorded) and the Monday digest.
// Runs only inside the disposable database:
//   bash tests/run-fresh-schema.sh tests/billing-alerts.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The billing alert test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-billing-alerts-"));
let alerts;
try {
  const output = path.join(temp, "billing-alerts.mjs");
  await build({
    entryPoints: [path.join(testsDir, "billing-alerts.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  alerts = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const price = (serviceKey, unit_amount = 1000) => ({ id: `price_${serviceKey}`, unit_amount, metadata: { service_key: serviceKey } });
// Basil-shaped invoice: the subscription id sits under parent.subscription_details.
const invoice = (fields = {}) => ({
  object: "invoice", id: "in_test", billing_reason: "subscription_create", livemode: true,
  customer: "cus_alert_paid", customer_email: "owner@example.test", currency: "gbp",
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_alert_1" } },
  total: 3600, total_excluding_tax: 3000, amount_paid: 3600,
  total_discount_amounts: [{ amount: 3000, discount: "di_1" }],
  lines: { data: [{ description: "3 × ComplyTrack (at £10.00 / month)" }] },
  ...fields,
});

try {
  const tenant = await createTenant("subscription-alert");
  await db.execute(sql`UPDATE clients SET stripe_customer_id = 'cus_alert_paid', name = 'Fairway <Golf> Club' WHERE id = ${tenant.clientId}`);
  await db.execute(sql`INSERT INTO billing_discount_codes (client_id, code_hash, code_hint)
    VALUES (${tenant.clientId}, 'hash-for-test', 'K7Q2')`);

  const sent = [];
  const retrieved = [];
  // Instant emails are off in production (Monday digest only); most checks
  // below switch them on to inspect each email.
  const deps = {
    emailAtOnce: true,
    adminEmail: "alerts@alps.example.test",
    getAppUrl: () => "https://app.example.test",
    sendEmail: async (message) => { sent.push(message); },
    retrieveSubscription: async (id) => {
      retrieved.push(id);
      return {
        items: { data: [
          { quantity: 3, price: price("core") },
          { quantity: 3, price: price("firetrack") },
        ] },
        discounts: [{ coupon: { name: "ALPS client 50% discount", percent_off: 50 } }],
      };
    },
  };

  // Renewals, add-on invoices and other businesses are not new subscriptions.
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice({ billing_reason: "subscription_cycle" }), deps), "not_applicable");
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice({ customer: "cus_nobody" }), deps), "unknown_business");
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice(), { ...deps, adminEmail: "" }), "no_admin_email");
  assert.equal(sent.length, 0);

  // The first paid invoice sends one alert to ADMIN_EMAIL.
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice(), deps), "sent");
  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.to, "alerts@alps.example.test");
  assert.equal(mail.subject, "New ComplyTrack subscription: Fairway <Golf> Club");
  assert.equal(mail.idempotencyKey, "billing-alert:new_subscription:sub_alert_1");
  assert.match(mail.text, /Bought: ComplyTrack, FireTrack/);
  assert.match(mail.text, /Sites: 3/);
  assert.match(mail.text, /Monthly amount: £30\.00 \+ VAT £6\.00 = £36\.00/);
  assert.match(mail.text, /Paid today: £36\.00/);
  assert.match(mail.text, /Discount: ALPS client 50% discount \(ALPS code ending K7Q2\), £30\.00 off this payment/);
  assert.match(mail.text, /Paid by: owner@example\.test/);
  assert.match(mail.text, /https:\/\/dashboard\.stripe\.com\/subscriptions\/sub_alert_1/);
  assert.match(mail.html, /Fairway &lt;Golf&gt; Club has subscribed/);
  assert.doesNotMatch(mail.html, /<Golf>/);
  assert.match(mail.html, /data-complytrack-email="1"/);

  // Stripe delivering the same event again (or the pre-basil shape of the
  // same invoice) sends nothing more.
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice(), deps), "already_sent");
  const legacyShape = invoice({ parent: null, subscription: "sub_alert_1" });
  assert.equal(await alerts.sendNewSubscriptionAlert(legacyShape, deps), "already_sent");
  assert.equal(sent.length, 1);
  assert.deepEqual(retrieved, ["sub_alert_1"]);

  // A failed send frees the claim so a later delivery can retry.
  const failing = { ...deps, sendEmail: async () => { throw new Error("provider down"); } };
  await assert.rejects(alerts.sendNewSubscriptionAlert(invoice({ parent: { subscription_details: { subscription: "sub_alert_2" } } }), failing), /provider down/);
  const retry = invoice({ parent: { subscription_details: { subscription: "sub_alert_2" } }, livemode: false,
    total_discount_amounts: [], total: 2400, total_excluding_tax: 2000, amount_paid: 2400 });
  // If Stripe cannot be read, Stripe's line descriptions say what was bought.
  const unreadable = { ...deps, retrieveSubscription: async () => { throw new Error("stripe down"); } };
  assert.equal(await alerts.sendNewSubscriptionAlert(retry, unreadable), "sent");
  const second = sent.at(-1);
  assert.match(second.text, /Bought: 3 × ComplyTrack \(at £10\.00 \/ month\)/);
  assert.match(second.text, /Discount: None/);
  assert.match(second.text, /dashboard\.stripe\.com\/test\/subscriptions\/sub_alert_2/);

  const rows = await db.execute(sql`SELECT alert_key, client_id, monthly_pence FROM billing_alerts WHERE kind = 'new_subscription' ORDER BY 1`);
  assert.deepEqual(rows.rows.map((r) => [r.alert_key, Number(r.client_id), Number(r.monthly_pence)]),
    [["sub_alert_1", tenant.clientId, 3000], ["sub_alert_2", tenant.clientId, 2000]]);

  // ---- Cancellation ----
  const cancelling = {
    id: "sub_alert_1", object: "subscription", customer: "cus_alert_paid", status: "active", livemode: true,
    cancel_at_period_end: true, cancel_at: Math.floor(Date.UTC(2026, 10, 27, 12) / 1000), start_date: Math.floor(Date.UTC(2026, 9, 27, 12) / 1000),
    cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive", comment: "Budget <cut>" },
    items: { data: [{ quantity: 3, price: price("core") }, { quantity: 3, price: price("firetrack") }] },
    discounts: [{ coupon: { name: "ALPS client 50% discount", percent_off: 50 } }],
  };
  let current = cancelling;
  const cancelDeps = { ...deps, retrieveSubscription: async () => current };
  // Not cancelling: nothing.
  assert.equal(await alerts.sendCancellationAlert({ ...cancelling, cancel_at_period_end: false, cancel_at: null }, cancelDeps), "not_applicable");
  // A delayed event for a cancellation that was since undone: nothing.
  current = { ...cancelling, cancel_at_period_end: false, cancel_at: null };
  assert.equal(await alerts.sendCancellationAlert(cancelling, cancelDeps), "not_applicable");
  current = cancelling;
  const before = sent.length;
  assert.equal(await alerts.sendCancellationAlert(cancelling, cancelDeps), "sent");
  const cancelMail = sent.at(-1);
  assert.equal(sent.length, before + 1);
  assert.equal(cancelMail.subject, "ComplyTrack cancellation: Fairway <Golf> Club");
  assert.match(cancelMail.text, /Had: ComplyTrack, FireTrack/);
  assert.match(cancelMail.text, /Monthly amount lost: £30\.00 \+ VAT/);
  assert.match(cancelMail.text, /Access ends: 27 November 2026/);
  assert.match(cancelMail.text, /Reason: Too expensive/);
  assert.match(cancelMail.text, /Their comment: Budget <cut>/);
  assert.match(cancelMail.html, /Budget &lt;cut&gt;/);
  // The "ended" event at period end sends nothing more.
  current = { ...cancelling, status: "canceled", ended_at: cancelling.cancel_at };
  assert.equal(await alerts.sendCancellationAlert(current, cancelDeps), "already_sent");
  assert.equal(sent.length, before + 1);

  // Undone in the portal: dropped from the figures, and a later cancellation is announced again.
  assert.equal(await alerts.withdrawCancellation({ ...cancelling, cancel_at_period_end: false, cancel_at: null }, cancelDeps), true);
  current = { ...cancelling, cancellation_details: { reason: "payment_failed" }, status: "canceled", cancel_at_period_end: false, cancel_at: null,
    ended_at: Math.floor(Date.now() / 1000) };
  assert.equal(await alerts.sendCancellationAlert(current, cancelDeps), "sent");
  assert.match(sent.at(-1).text, /Reason: Payment failed/);
  assert.match(sent.at(-1).text, /Access ended:/);

  // ---- Plan changes (digest only) ----
  const planEvent = (id, previous, now) => ({
    id, type: "customer.subscription.updated",
    data: {
      object: { id: "sub_alert_2", customer: "cus_alert_paid", status: "active", items: { data: now } },
      previous_attributes: { items: { object: "list", data: previous } },
    },
  });
  const sentBeforePlan = sent.length;
  const upgrade = planEvent("evt_plan_1",
    [{ quantity: 2, price: price("core") }],
    [{ quantity: 3, price: price("core") }, { quantity: 3, price: price("kitchentrack") }, { quantity: 1, price: price("ai", 1500) }]);
  assert.equal(await alerts.recordPlanChange(upgrade, { ...deps, emailAtOnce: false }), "recorded");
  assert.equal(await alerts.recordPlanChange(upgrade, deps), "already_sent");
  // A status-only update is not a plan change.
  assert.equal(await alerts.recordPlanChange({ id: "evt_status", data: { object: upgrade.data.object, previous_attributes: { status: "incomplete" } } }, deps), "not_applicable");
  assert.equal(sent.length, sentBeforePlan);
  const plan = (await db.execute(sql`SELECT summary, monthly_pence FROM billing_alerts WHERE kind = 'plan_change'`)).rows[0];
  assert.equal(plan.summary, "added KitchenTrack, AI features; sites 2 → 3 (+£55.00 a month + VAT)");
  assert.equal(Number(plan.monthly_pence), 5500);
  // Emailed at once only when asked.
  const downgrade = planEvent("evt_plan_2", upgrade.data.object.items.data, [{ quantity: 3, price: price("core") }]);
  assert.equal(await alerts.recordPlanChange(downgrade, { ...deps, emailAtOnce: true }), "sent");
  assert.match(sent.at(-1).text, /removed KitchenTrack, AI features \(−£45\.00 a month \+ VAT\)/);

  // ---- Monday digest ----
  assert.equal(alerts.moduleForTable("fire_safety_checks"), "FireTrack");
  assert.equal(alerts.moduleForTable("kitchen_probe_checks"), "KitchenTrack");
  assert.equal(alerts.moduleForTable("sites"), null);
  const other = await createTenant("subscription-alert-other");
  await db.execute(sql`INSERT INTO audit_log (client_id, table_name, row_id, action, diff) VALUES
    (${tenant.clientId}, 'fire_safety_checks', 1, 'create', '{}'::jsonb),
    (${tenant.clientId}, 'fire_safety_checks', 2, 'create', '{}'::jsonb),
    (${other.clientId}, 'fire_safety_checks', 3, 'update', '{}'::jsonb),
    (${tenant.clientId}, 'kitchen_probe_checks', 4, 'create', '{}'::jsonb),
    (${tenant.clientId}, 'sites', 5, 'create', '{}'::jsonb)`);
  // An old row outside the week is left out.
  await db.execute(sql`INSERT INTO billing_alerts (kind, alert_key, business_name, summary, monthly_pence, created_at)
    VALUES ('new_subscription', 'sub_old', 'Old Co', 'old', 9999, now() - interval '9 days')`);
  const digestNow = () => new Date(Date.now() + 60_000);
  const digest = await alerts.runBillingDigest({ ...deps, now: digestNow });
  assert.deepEqual(digest, { sent: true });
  const digestMail = sent.at(-1);
  // 2 new (£30 + £20), 1 cancelled (£30), plan changes +£55 −£45 → net +£30.
  assert.match(digestMail.subject, /^ComplyTrack week: \+1 business, \+£30\.00 a month$/);
  assert.match(digestMail.text, /New: \+2 \(\+£50\.00 a month\)/);
  assert.match(digestMail.text, /Cancelled: −1 \(−£30\.00 a month\)/);
  assert.match(digestMail.text, /Plan changes: \+£10\.00 a month/);
  assert.match(digestMail.text, /- Payment failed: 1/);
  assert.match(digestMail.text, /Most used modules \(records saved or updated\):\n- FireTrack: 3 \(in 2 businesses\)\n- KitchenTrack: 1 \(in 1 business\)\n\n/);
  assert.doesNotMatch(digestMail.text, /Old Co/);
  assert.match(digestMail.text, /New free trials: [1-9]/);
  assert.match(digestMail.html, /Why businesses cancelled/);
  assert.match(digestMail.html, /Most used modules/);
  assert.match(digestMail.html, /Fairway &lt;Golf&gt; Club/);
  // Once a week.
  assert.deepEqual(await alerts.runBillingDigest({ ...deps, now: digestNow }), { sent: false, reason: "already_sent" });

  // The business dashboard: platform operators only, any dates.
  assert.equal((await tenant.request("GET", "/admin/business-dashboard")).status, 403);
  const month = await alerts.getBillingSummary({ from: new Date(Date.now() - 30 * 86_400_000), to: digestNow() });
  assert.deepEqual(month.newSubscriptions.map((r) => r.businessName), ["Old Co", "Fairway <Golf> Club", "Fairway <Golf> Club"]);
  assert.equal(month.gainedPence, 9999 + 3000 + 2000);
  assert.equal(month.netBusinesses, 2);
  assert.deepEqual(month.reasons, [{ reason: "payment_failed", label: "Payment failed", count: 1 }]);
  assert.deepEqual(month.modules[0], { module: "FireTrack", changes: 3, businesses: 2 });
  assert.ok(month.weeks.length >= 5, JSON.stringify(month.weeks));
  assert.ok(month.weeks.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.weekStart) && new Date(`${w.weekStart}T12:00:00Z`).getUTCDay() === 1));
  assert.equal(month.weeks.reduce((n, w) => n + w.newCount, 0), 3);
  assert.equal(month.weeks.reduce((n, w) => n + w.cancelledCount, 0), 1);
  assert.equal(month.weeks.reduce((n, w) => n + w.netPence, 0), month.netPence);

  // As configured (digest only): changes are recorded with the details the
  // instant emails had, and nothing is sent.
  const configured = { ...deps, emailAtOnce: undefined };
  const sentBeforeQuiet = sent.length;
  const quietInvoice = invoice({ parent: { subscription_details: { subscription: "sub_quiet" } } });
  assert.equal(await alerts.sendNewSubscriptionAlert(quietInvoice, configured), "recorded");
  current = { ...cancelling, id: "sub_quiet" };
  assert.equal(await alerts.sendCancellationAlert(current, { ...configured, retrieveSubscription: async () => current }), "recorded");
  assert.equal(sent.length, sentBeforeQuiet);
  const quiet = (await db.execute(sql`SELECT kind, summary FROM billing_alerts WHERE alert_key = 'sub_quiet' ORDER BY kind`)).rows;
  assert.equal(quiet[0].kind, "cancellation");
  assert.match(quiet[0].summary, /Access ends 27 November 2026\. Reason: Too expensive \("Budget <cut>"\)/);
  assert.equal(quiet[1].kind, "new_subscription");
  assert.match(quiet[1].summary, /Discount: ALPS client 50% discount \(ALPS code ending K7Q2\), £30\.00 off this payment/);

  console.log("Billing alert test passed");
} finally {
  await pool.end();
}
