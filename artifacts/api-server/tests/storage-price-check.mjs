// Storage add-on price alignment: the Stripe per-GiB price must match the
// provider rate plus ALPS margin (with explicit currency conversion, rounding
// and Stripe's minimum charge), and drift must pause purchases rather than
// charge a different amount. The real billing router runs against an
// in-memory DB stub and a fake Stripe client; nothing external is contacted.
//   node tests/storage-price-check.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-storage-price-check-"));
const outFile = path.join(outDir, "storage-price-check.mjs");

for (const key of [
  "STORAGE_PROVIDER_USD_PER_GIB_MONTH", "STORAGE_ALPS_MARKUP_PERCENT", "STORAGE_USD_EXCHANGE_RATE",
  "STORAGE_PRICE_TOLERANCE_PERCENT", "STORAGE_ADDON_PRICE_ID",
]) delete process.env[key];

const client = { id: 52, name: "Storage price fixture", stripeCustomerId: "cus_storage", stripeSubscriptionId: null, subscriptionStatus: "active" };
const state = { client, stripe: null, subscription: null, storagePrice: null, logged: [] };

const stubs = {
  schema: `
    export const clientsTable = { __table: "clients", id: "clients.id", stripeCustomerId: "clients.stripeCustomerId",
      stripeSubscriptionId: "clients.stripeSubscriptionId", subscriptionStatus: "clients.subscriptionStatus" };
    export const sitesTable = { __table: "sites", clientId: "sites.clientId" };
    export const appSettingsTable = { __table: "app_settings", clientId: "app_settings.clientId", key: "app_settings.key", value: "app_settings.value" };
  `,
  drizzle: `
    export const eq = (left, right) => ({ left, right });
    export const sql = (strings, ...values) => ({ text: strings.join("?"), values });
    sql.raw = (text) => ({ text, values: [] });
    // billing.ts imports offboarding.ts (#116), which needs these at load.
    export const and = (...conditions) => ({ and: conditions });
    export const isNull = (column) => ({ isNull: column });
    export const isNotNull = (column) => ({ isNotNull: column });
    export const inArray = (column, values) => ({ column, values });
    export const lt = (left, right) => ({ left, right });
  `,
  db: `
    const state = globalThis.__storagePriceCheckState;
    export const db = {
      select() {
        let table;
        const rows = () => table?.__table === "sites" ? [{ count: 1 }] : table?.__table === "clients" ? [state.client] : [];
        return {
          from(value) { table = value; return this; },
          where() { return this; },
          async limit() { return rows(); },
          then(resolve, reject) { return Promise.resolve(rows()).then(resolve, reject); },
        };
      },
      async execute() { return { rows: [] }; },
    };
  `,
  stripe: `
    const state = globalThis.__storagePriceCheckState;
    export const getStripePublishableKey = async () => "pk_test_storage_price";
    export const getUncachableStripeClient = async () => state.stripe;
    export const getStripeSync = async () => { throw new Error("Unexpected Stripe sync"); };
  `,
  auth: `
    export const getClientId = (req) => req.currentUser?.clientId ?? null;
    export const requireAuth = (_req, _res, next) => next();
    export const requireRole = () => (_req, _res, next) => next();
    export const requireClientAdmin = (_req, _res, next) => next();
    export const denyViewers = (_req, _res, next) => next();
    export const requirePlatformOperator = (_req, _res, next) => next();
  `,
  trialLock: `
    export const invalidateTrialLock = () => {};
    export const isClientBillingLocked = async () => false;
  `,
  alpsDiscount: `
    export const attachDiscountCheckoutSession = async () => {};
    export const getAlpsDiscountCouponId = async () => null;
    export const getClientDiscountCodeStatus = async () => ({});
    export const hashDiscountCode = (value) => value;
    export const issueClientDiscountCode = async () => ({});
    export const normaliseAlpsDiscountCode = (value) => value;
    export const redeemAlpsDiscountOnSubscription = async () => ({});
    export const releaseAlpsDiscountReservation = async () => {};
    export const reserveAlpsDiscount = async () => null;
    export const verifyClientDiscountCode = async () => false;
  `,
  logger: `
    const state = globalThis.__storagePriceCheckState;
    export const logger = { error(obj, msg) { state.logged.push({ level: "error", obj, msg }); }, info() {}, warn() {}, debug() {} };
  `,
};

function makeSubscription() {
  return {
    id: "sub_storage", created: 1_699_999_000, status: "active",
    items: { data: [{ id: "si_core", current_period_start: 1_700_000_000, quantity: 1,
      price: { id: "price_core", unit_amount: 1000, currency: "gbp", metadata: { service_key: "core" } } }] },
  };
}

function storagePrice(overrides = {}) {
  return { id: "price_storage", active: true, type: "recurring", currency: "gbp", unit_amount: 2, recurring: { interval: "month" }, metadata: {}, ...overrides };
}

function fakeStripe() {
  const calls = { priceRetrieve: [], subscriptionUpdate: [], invoiceCreate: [], invoiceItemCreate: [] };
  return {
    calls,
    prices: { retrieve: async (id) => {
      calls.priceRetrieve.push(id);
      if (state.storagePrice instanceof Error) throw state.storagePrice;
      return state.storagePrice;
    } },
    subscriptions: {
      list: async () => ({ data: [state.subscription] }),
      update: async (subscriptionId, params, options) => {
        calls.subscriptionUpdate.push({ subscriptionId, params, options });
        return state.subscription;
      },
    },
    subscriptionItems: { del: async () => ({}), update: async () => ({}) },
    invoices: {
      create: async (params) => { calls.invoiceCreate.push(params); return { id: "in_storage" }; },
      finalizeInvoice: async (id) => ({ id, status: "open" }),
      pay: async (id) => ({ id, status: "paid" }),
      retrieve: async (id) => ({ id, status: "paid" }),
      voidInvoice: async (id) => ({ id, status: "void" }),
    },
    invoiceItems: { create: async (params) => { calls.invoiceItemCreate.push(params); return { id: "ii_storage" }; } },
  };
}

let server;
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

try {
  globalThis.__storagePriceCheckState = state;
  await build({
    entryPoints: [path.join(testsDir, "storage-price-check.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
    plugins: [{
      name: "offline-billing-dependencies",
      setup(builder) {
        for (const [filter, name] of [
          [/^@workspace\/db\/schema$/, "schema"], [/^@workspace\/db$/, "db"], [/^drizzle-orm$/, "drizzle"],
          [/stripeClient$/, "stripe"], [/trialLock$/, "trialLock"], [/alpsDiscount$/, "alpsDiscount"],
          [/logger$/, "logger"], [/\/middleware\/requireAuth$/, "auth"],
        ]) builder.onResolve({ filter }, () => ({ path: name, namespace: "storage-price-test" }));
        builder.onLoad({ filter: /.*/, namespace: "storage-price-test" }, (args) => ({ contents: stubs[args.path], loader: "js", resolveDir: testsDir }));
      },
    }],
  });
  const lib = await import(pathToFileURL(outFile).href);
  const { evaluateStorageAddonPrice: evaluate, minimumStoragePurchaseGib, checkStorageAddonPrice, resetStoragePriceCheckCache } = lib;
  const GBP = { STORAGE_USD_EXCHANGE_RATE: "0.79" };

  console.log("── price calculation ──");
  check("default 0.015 USD + 20% at 0.79 GBP/USD is 1.422p, rounded up to 2p: in line", () => {
    const result = evaluate(storagePrice(), GBP);
    assert.equal(result.status, "ok", result.message);
    assert.equal(result.exactUnitAmount, 1.422);
    assert.equal(result.expectedUnitAmount, 2);
    assert.deepEqual(result.allowedUnitAmount, { min: 2, max: 2 });
    assert.equal(result.minimumPurchaseGib, 15, "15 GiB × 2p reaches Stripe's 30p minimum");
  });
  check("a GBP price without an exchange rate cannot be checked, so it is not trusted", () => {
    const result = evaluate(storagePrice(), {});
    assert.equal(result.status, "misconfigured");
    assert.deepEqual(result.issues, ["exchange_rate_missing"]);
  });
  for (const fx of ["0", "-1", "abc"]) {
    check(`exchange rate "${fx}" is rejected`, () => assert.deepEqual(evaluate(storagePrice(), { STORAGE_USD_EXCHANGE_RATE: fx }).issues, ["exchange_rate_invalid"]));
  }
  check("a USD price needs no exchange rate (1.8c rounds up to 2c; minimum 25 GiB for 50c)", () => {
    const result = evaluate(storagePrice({ currency: "usd" }), {});
    assert.equal(result.status, "ok", result.message);
    assert.equal(result.usdExchangeRate, 1);
    assert.equal(result.minimumPurchaseGib, 25);
  });
  check("provider rate rising to 0.023 USD makes the 2p price drift (expected 3p)", () => {
    const result = evaluate(storagePrice(), { ...GBP, STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0.023" });
    assert.equal(result.status, "drift");
    assert.deepEqual(result.issues, ["price_below_expected"]);
    assert.equal(result.expectedUnitAmount, 3);
    assert.match(result.message, /expected 0\.03 GBP/);
  });
  check("a price above the margin is drift too (customers would pay more than shown)", () => {
    assert.deepEqual(evaluate(storagePrice({ unit_amount: 5 }), GBP).issues, ["price_above_expected"]);
  });
  check("tolerance is applied after rounding up (1.00 USD + 20% at 0.80 = 96p, 5% → 92p to 101p)", () => {
    const env = { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "1", STORAGE_USD_EXCHANGE_RATE: "0.8" };
    assert.deepEqual(evaluate(storagePrice(), env).allowedUnitAmount, { min: 92, max: 101 });
    for (const [amount, status] of [[91, "drift"], [92, "ok"], [96, "ok"], [101, "ok"], [102, "drift"]]) {
      assert.equal(evaluate(storagePrice({ unit_amount: amount }), env).status, status, `${amount}p`);
    }
    assert.deepEqual(evaluate(storagePrice({ unit_amount: 96 }), { ...env, STORAGE_PRICE_TOLERANCE_PERCENT: "0" }).allowedUnitAmount, { min: 96, max: 96 });
  });
  check("floating-point noise does not round a whole amount up (0.07 USD → 7c, not 8c)", () => {
    const result = evaluate(storagePrice({ currency: "usd", unit_amount: 7 }), { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0.07", STORAGE_ALPS_MARKUP_PERCENT: "0" });
    assert.equal(result.expectedUnitAmount, 7);
    assert.equal(result.status, "ok");
  });
  check("a near-zero rate still expects at least 1 minor unit", () => {
    assert.equal(evaluate(storagePrice({ unit_amount: 1 }), { ...GBP, STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0" }).expectedUnitAmount, 1);
  });
  const misconfigured = {
    "inactive price": [{ active: false }, {}, "price_inactive"],
    "yearly price": [{ recurring: { interval: "year" } }, {}, "price_not_monthly"],
    "one-off price": [{ type: "one_time", recurring: null }, {}, "price_not_monthly"],
    "sub-penny decimal price": [{ unit_amount: null }, {}, "price_not_whole_minor_units"],
    "unsupported currency": [{ currency: "jpy" }, {}, "currency_unsupported"],
    "invalid provider rate": [{}, { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "abc" }, "rate_config_invalid"],
    "negative margin": [{}, { STORAGE_ALPS_MARKUP_PERCENT: "-5" }, "rate_config_invalid"],
    "invalid tolerance": [{}, { STORAGE_PRICE_TOLERANCE_PERCENT: "100" }, "tolerance_invalid"],
  };
  for (const [name, [priceOverrides, env, issue]] of Object.entries(misconfigured)) {
    check(`${name} is misconfigured, not ok`, () => {
      const result = evaluate(storagePrice(priceOverrides), { ...GBP, ...env });
      assert.equal(result.status, "misconfigured");
      assert.ok(result.issues.includes(issue), JSON.stringify(result.issues));
    });
  }
  check("Stripe minimum-charge quantities", () => {
    assert.equal(minimumStoragePurchaseGib(2, "gbp"), 15);
    assert.equal(minimumStoragePurchaseGib(30, "gbp"), 1);
    assert.equal(minimumStoragePurchaseGib(31, "GBP"), 1);
    assert.equal(minimumStoragePurchaseGib(7, "usd"), 8);
    assert.equal(minimumStoragePurchaseGib(2, "jpy"), null);
  });

  console.log("── cached check ──");
  {
    const env = { ...GBP, STORAGE_ADDON_PRICE_ID: "price_storage" };
    state.stripe = fakeStripe();
    state.storagePrice = storagePrice();
    resetStoragePriceCheckCache();
    assert.equal((await checkStorageAddonPrice({ env, now: 0 })).status, "ok");
    assert.equal((await checkStorageAddonPrice({ env, now: 60_000 })).status, "ok");
    check("page loads reuse a recent result instead of calling Stripe each time", () => assert.equal(state.stripe.calls.priceRetrieve.length, 1));
    await checkStorageAddonPrice({ env, now: 11 * 60_000 });
    check("the result is refreshed after 10 minutes", () => assert.equal(state.stripe.calls.priceRetrieve.length, 2));
    state.storagePrice = new Error("Stripe down");
    const unavailable = await checkStorageAddonPrice({ env, maxAgeMs: 0 });
    check("an unreadable Stripe price is 'unavailable', never 'ok'", () => assert.equal(unavailable.status, "unavailable"));
    const notConfigured = await checkStorageAddonPrice({ env: GBP });
    check("no price id means the add-on is simply not offered", () => assert.equal(notConfigured.status, "not_configured"));
  }

  console.log("── billing routes ──");
  process.env.STORAGE_ADDON_PRICE_ID = "price_storage";
  process.env.STORAGE_USD_EXCHANGE_RATE = "0.79";
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = { id: 9, role: "client_admin", clientId: client.id };
    req.log = { error: (obj, msg) => state.logged.push({ level: "error", obj, msg }), warn() {}, info() {} };
    next();
  });
  app.use("/api/billing", lib.billingRouter);
  server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api/billing`;
  const request = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const fresh = (price) => {
    resetStoragePriceCheckCache();
    state.subscription = makeSubscription();
    state.stripe = fakeStripe();
    state.storagePrice = price;
    state.logged.length = 0;
  };
  const buy = (gib) => request("POST", "/storage", { gib, requestId: crypto.randomUUID() });

  fresh(storagePrice());
  let config = await request("GET", "/config");
  check("config offers the add-on with its real price and minimum quantity", () => {
    assert.equal(config.status, 200);
    assert.equal(config.data.storageAddonAvailable, true);
    assert.deepEqual(config.data.storageAddon, { unitAmount: 2, currency: "gbp", minimumGib: 15 });
  });

  fresh(storagePrice({ unit_amount: 1 }));
  config = await request("GET", "/config");
  check("config hides the add-on while the price has drifted", () => {
    assert.equal(config.data.storageAddonAvailable, false);
    assert.equal(config.data.storageAddon, null);
  });
  check("drift is logged as an operator error", () => assert.ok(state.logged.some((entry) => /price drift/.test(entry.msg))));

  fresh(new Error("Stripe down"));
  config = await request("GET", "/config");
  check("config hides the add-on when the Stripe price cannot be read", () => assert.equal(config.data.storageAddonAvailable, false));

  fresh(storagePrice({ unit_amount: 1 }));
  let response = await buy(20);
  check("a purchase at a drifted price is refused and nothing is changed or charged", () => {
    assert.equal(response.status, 503);
    assert.equal(response.data.code, "STORAGE_PRICE_UNDER_REVIEW");
    assert.match(response.data.error, /not been charged/);
    assert.deepEqual(state.stripe.calls.subscriptionUpdate, []);
    assert.deepEqual(state.stripe.calls.invoiceCreate, []);
    assert.ok(state.logged.some((entry) => /refused/.test(entry.msg) && entry.obj.storagePriceCheck?.expectedUnitAmount === 2));
  });

  fresh(storagePrice());
  process.env.STORAGE_USD_EXCHANGE_RATE = "";
  response = await buy(20);
  check("a purchase without an exchange rate for a GBP price is refused", () => {
    assert.equal(response.status, 503);
    assert.deepEqual(state.stripe.calls.subscriptionUpdate, []);
  });
  process.env.STORAGE_USD_EXCHANGE_RATE = "0.79";

  fresh(storagePrice());
  response = await buy(5);
  check("a purchase below Stripe's minimum charge is refused with the minimum", () => {
    assert.equal(response.status, 400);
    assert.equal(response.data.code, "STORAGE_PURCHASE_BELOW_MINIMUM");
    assert.equal(response.data.minimumGib, 15);
    assert.match(response.data.error, /15 GiB.*0\.30 GBP/);
    assert.deepEqual(state.stripe.calls.subscriptionUpdate, []);
  });

  fresh(storagePrice());
  response = await buy(15);
  check("an in-line purchase charges exactly price × GiB and adds the GiB to the subscription", () => {
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.deepEqual(response.data, { gibAdded: 15, monthlyGib: 15, unitAmount: 2, currency: "gbp" });
    assert.equal(state.stripe.calls.subscriptionUpdate[0].params.items[0].quantity, 15);
    assert.equal(state.stripe.calls.invoiceItemCreate[0].amount, 30);
  });

  console.log(`\n${passed} storage price checks passed`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}
