// The ALPS "new subscription" alert from the Stripe invoice.paid webhook:
// one email per subscription, with what was bought, the monthly amount and
// any ALPS discount. Runs only inside the disposable database:
//   bash tests/run-fresh-schema.sh tests/new-subscription-alert.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The new subscription alert test requires the disposable fresh-schema database.");
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-new-subscription-alert-"));
let alerts;
try {
  const output = path.join(temp, "subscription-alert.mjs");
  await build({
    entryPoints: [path.join(testsDir, "new-subscription-alert.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  alerts = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const price = (serviceKey) => ({ id: `price_${serviceKey}`, metadata: { service_key: serviceKey } });
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
  const deps = {
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
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice({ billing_reason: "subscription_cycle" }), deps), "not_new_subscription");
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice({ customer: "cus_nobody" }), deps), "unknown_business");
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice(), { ...deps, adminEmail: "" }), "no_admin_email");
  assert.equal(sent.length, 0);

  // The first paid invoice sends one alert to ADMIN_EMAIL.
  assert.equal(await alerts.sendNewSubscriptionAlert(invoice(), deps), "sent");
  assert.equal(sent.length, 1);
  const [mail] = sent;
  assert.equal(mail.to, "alerts@alps.example.test");
  assert.equal(mail.subject, "New ComplyTrack subscription: Fairway <Golf> Club");
  assert.equal(mail.idempotencyKey, "new-subscription-alert:sub_alert_1");
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

  const rows = await db.execute(sql`SELECT stripe_subscription_id, client_id FROM new_subscription_alerts ORDER BY 1`);
  assert.deepEqual(rows.rows.map((r) => [r.stripe_subscription_id, Number(r.client_id)]),
    [["sub_alert_1", tenant.clientId], ["sub_alert_2", tenant.clientId]]);

  console.log("New subscription alert test passed");
} finally {
  await pool.end();
}
