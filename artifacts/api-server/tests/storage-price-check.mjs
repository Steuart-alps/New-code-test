// Storage add-on price: extra storage is sold at £1 per 10 GiB (a 10p per GiB
// monthly GBP Stripe price, bought in 10 GiB steps). Any other price, or a
// provider cost plus ALPS margin above it, must pause purchases rather than
// charge a different amount or sell at a loss. The real billing router runs against an
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
  "STORAGE_ADDON_PRICE_ID",
]) delete process.env[key];

const client = { id: 52, name: "Storage price fixture", stripeCustomerId: "cus_storage", stripeSubscriptionId: null, subscriptionStatus: "active" };
const state = { client, stripe: null, subscription: null, storagePrice: null, logged: [] };

const stubs = {
  schema: `
    export const clientsTable = { __table: "clients", id: "clients.id", stripeCustomerId: "clients.stripeCustomerId",
      stripeSubscriptionId: "clients.stripeSubscriptionId", subscriptionStatus: "clients.subscriptionStatus" };
    export const sitesTable = { __table: "sites", clientId: "sites.clientId" };
    export const appSettingsTable = { __table: "app_settings", clientId: "app_settings.clientId", key: "app_settings.key", value: "app_settings.value" };
    // Imported by lib/aiAllowance.ts (the AI add-on routes); never read here.
    export const aiUsageTable = { __table: "ai_usage", id: "ai_usage.id" };
    export const aiTopUpsTable = { __table: "ai_top_ups", id: "ai_top_ups.id" };
    export const aiAllowanceGrantsTable = { __table: "ai_allowance_grants", id: "ai_allowance_grants.id" };
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
      async transaction(fn) { return fn(this); },
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
  return { id: "price_storage", active: true, type: "recurring", currency: "gbp", unit_amount: 10, recurring: { interval: "month" }, metadata: {}, ...overrides };
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
  const { evaluateStorageAddonPrice: evaluate, isWholeStoragePacks, roundUpToStoragePacks, checkStorageAddonPrice, resetStoragePriceCheckCache } = lib;
  const GBP = { STORAGE_USD_EXCHANGE_RATE: "0.76" };

  console.log("── price calculation ──");
  check("10p per GiB (£1 per 10 GiB) covers the default 0.026 USD + 20% at 0.76 GBP/USD (2.3712p, so 3p)", () => {
    const result = evaluate(storagePrice(), GBP);
    assert.equal(result.status, "ok", result.message);
    assert.equal(result.expectedUnitAmount, 10);
    assert.equal(result.exactUnitAmount, 2.3712);
    assert.equal(result.costUnitAmount, 3);
    assert.equal(result.packGib, 10);
    assert.equal(result.minimumPurchaseGib, 10, "one 10 GiB step is £1, above Stripe's 30p minimum");
  });
  check("without an exchange rate the check assumes 1 USD = £1, which overstates the cost", () => {
    const result = evaluate(storagePrice(), {});
    assert.equal(result.status, "ok", result.message);
    assert.equal(result.usdExchangeRate, 1);
    assert.equal(result.exchangeRateAssumed, true);
    assert.equal(result.costUnitAmount, 4);
  });
  for (const fx of ["0", "-1", "abc"]) {
    check(`exchange rate "${fx}" is rejected`, () => assert.deepEqual(evaluate(storagePrice(), { STORAGE_USD_EXCHANGE_RATE: fx }).issues, ["exchange_rate_invalid"]));
  }
  check("costs rising above 10p pause sales (0.09 USD + 20% at 0.76 = 8.208p is fine, 0.11 USD = 10.032p is not)", () => {
    assert.equal(evaluate(storagePrice(), { ...GBP, STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0.09" }).status, "ok");
    const result = evaluate(storagePrice(), { ...GBP, STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0.11" });
    assert.equal(result.status, "drift");
    assert.deepEqual(result.issues, ["price_below_cost"]);
    assert.equal(result.costUnitAmount, 11);
    assert.match(result.message, /no longer covers/);
  });
  check("floating-point noise does not round a whole amount up (exactly 10p is still ok)", () => {
    const result = evaluate(storagePrice(), { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "0.1", STORAGE_ALPS_MARKUP_PERCENT: "0", STORAGE_USD_EXCHANGE_RATE: "1" });
    assert.equal(result.costUnitAmount, 10);
    assert.equal(result.status, "ok");
  });
  const misconfigured = {
    "inactive price": [{ active: false }, {}, "price_inactive"],
    "yearly price": [{ recurring: { interval: "year" } }, {}, "price_not_monthly"],
    "one-off price": [{ type: "one_time", recurring: null }, {}, "price_not_monthly"],
    "the old 2p per GiB price": [{ unit_amount: 2 }, {}, "price_not_storage_rate"],
    "a dearer price than shown": [{ unit_amount: 12 }, {}, "price_not_storage_rate"],
    "sub-penny decimal price": [{ unit_amount: null }, {}, "price_not_storage_rate"],
    "a USD price": [{ currency: "usd" }, {}, "currency_unsupported"],
    "invalid provider rate": [{}, { STORAGE_PROVIDER_USD_PER_GIB_MONTH: "abc" }, "rate_config_invalid"],
    "negative margin": [{}, { STORAGE_ALPS_MARKUP_PERCENT: "-5" }, "rate_config_invalid"],
  };
  for (const [name, [priceOverrides, env, issue]] of Object.entries(misconfigured)) {
    check(`${name} is misconfigured, not ok`, () => {
      const result = evaluate(storagePrice(priceOverrides), { ...GBP, ...env });
      assert.equal(result.status, "misconfigured");
      assert.ok(result.issues.includes(issue), JSON.stringify(result.issues));
    });
  }
  check("10 GiB steps", () => {
    assert.equal(isWholeStoragePacks(0), true);
    assert.equal(isWholeStoragePacks(30), true);
    assert.equal(isWholeStoragePacks(15), false);
    assert.equal(isWholeStoragePacks(-10), false);
    assert.equal(roundUpToStoragePacks(0), 0);
    assert.equal(roundUpToStoragePacks(1), 10);
    assert.equal(roundUpToStoragePacks(20), 20);
    assert.equal(roundUpToStoragePacks(21), 30);
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
    const notConfigured = await checkStorageAddonPrice({ env: GBP, findPriceId: async () => null });
    check("no storage price means the add-on is simply not offered", () => assert.equal(notConfigured.status, "not_configured"));
    const lookupFailed = await checkStorageAddonPrice({ env: GBP, maxAgeMs: 0, findPriceId: async () => { throw new Error("db down"); } });
    check("a failed price lookup is 'unavailable', never 'ok'", () => assert.equal(lookupFailed.status, "unavailable"));
  }

  console.log("── billing routes ──");
  process.env.STORAGE_ADDON_PRICE_ID = "price_storage";
  process.env.STORAGE_USD_EXCHANGE_RATE = "0.76";
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
  check("config offers the add-on at £1 per 10 GiB, in 10 GiB steps", () => {
    assert.equal(config.status, 200);
    assert.equal(config.data.storageAddonAvailable, true);
    assert.deepEqual(config.data.storageAddon, { unitAmount: 10, currency: "gbp", minimumGib: 10, packGib: 10 });
  });

  fresh(storagePrice({ unit_amount: 2 }));
  config = await request("GET", "/config");
  check("config hides the add-on while the Stripe price is not the storage price", () => {
    assert.equal(config.data.storageAddonAvailable, false);
    assert.equal(config.data.storageAddon, null);
  });
  check("a wrong price is logged as an operator error", () => assert.ok(state.logged.some((entry) => /price drift/.test(entry.msg))));

  fresh(new Error("Stripe down"));
  config = await request("GET", "/config");
  check("config hides the add-on when the Stripe price cannot be read", () => assert.equal(config.data.storageAddonAvailable, false));

  fresh(storagePrice({ unit_amount: 2 }));
  let response = await buy(20);
  check("a purchase at a wrong price is refused and nothing is changed or charged", () => {
    assert.equal(response.status, 503);
    assert.equal(response.data.code, "STORAGE_PRICE_UNDER_REVIEW");
    assert.match(response.data.error, /not been charged/);
    assert.deepEqual(state.stripe.calls.subscriptionUpdate, []);
    assert.deepEqual(state.stripe.calls.invoiceCreate, []);
    assert.ok(state.logged.some((entry) => /refused/.test(entry.msg) && entry.obj.storagePriceCheck?.expectedUnitAmount === 10));
  });

  fresh(storagePrice());
  process.env.STORAGE_PROVIDER_USD_PER_GIB_MONTH = "0.2";
  response = await buy(20);
  check("a purchase is refused when costs exceed the price", () => {
    assert.equal(response.status, 503);
    assert.deepEqual(state.stripe.calls.subscriptionUpdate, []);
  });
  delete process.env.STORAGE_PROVIDER_USD_PER_GIB_MONTH;

  for (const gib of [5, 15]) {
    fresh(storagePrice());
    response = await buy(gib);
    check(`${gib} GiB is not a whole 10 GiB step, so it is refused`, () => {
      assert.equal(response.status, 400);
      assert.match(response.data.error, /multiple of 10/);
      assert.deepEqual(state.stripe.calls.subscriptionUpdate, []);
    });
  }

  fresh(storagePrice());
  response = await buy(20);
  check("buying 20 GiB adds 20 GiB and puts £2 for the first month on the next bill", () => {
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.deepEqual(response.data, { gibAdded: 20, monthlyGib: 20, unitAmount: 10, currency: "gbp" });
    assert.equal(state.stripe.calls.subscriptionUpdate[0].params.items[0].quantity, 20);
    assert.equal(state.stripe.calls.subscriptionUpdate[0].params.proration_behavior, "none");
    assert.equal(state.stripe.calls.invoiceItemCreate[0].amount, 200);
    // Pending on the subscription's next invoice, not a separate card payment.
    assert.equal(state.stripe.calls.invoiceItemCreate[0].subscription, "sub_storage");
    assert.equal(state.stripe.calls.invoiceItemCreate[0].invoice, undefined);
    assert.deepEqual(state.stripe.calls.invoiceCreate, []);
  });

  fresh(storagePrice());
  state.stripe.invoiceItems.create = async () => { throw new Error("Stripe down"); };
  state.stripe.invoiceItems.list = async () => ({ data: [] });
  const deleted = [];
  state.stripe.subscriptionItems.del = async (id) => { deleted.push(id); return {}; };
  state.stripe.subscriptions.update = async () => {
    state.subscription.items.data.push({ id: "si_storage", quantity: 20, price: { id: "price_storage", metadata: { service_key: "storage" } } });
    return state.subscription;
  };
  response = await buy(20);
  check("if the first month can't be added, the storage is taken off again and nothing is charged", () => {
    assert.equal(response.status, 502);
    assert.match(response.data.error, /not been charged/);
    assert.deepEqual(deleted, ["si_storage"]);
  });

  console.log(`\n${passed} storage price checks passed`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}
