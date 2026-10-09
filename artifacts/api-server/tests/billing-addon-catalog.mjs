// Deterministic billing add-on contract coverage. The real Express billing
// router and price resolver run against an in-memory DB evaluator and fake
// Stripe client; this test never connects to an external provider.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const fixtures = JSON.parse(await readFile(path.join(testsDir, "fixtures/billable-addons.json"), "utf8"));
const outDir = await mkdtemp(path.join(testsDir, ".build-billing-addon-catalog-"));
const outFile = path.join(outDir, "billing-addon-catalog.mjs");

const client = {
  id: 41,
  name: "Offline billing fixture",
  stripeCustomerId: "cus_offline_test",
  stripeSubscriptionId: null,
  subscriptionStatus: "active",
  trialEndsAt: new Date(0),
  selectedServices: [],
};

function makeSubscription() {
  return {
    id: "sub_offline_test",
    created: 1_699_999_000,
    status: "active",
    items: {
      data: [{
        id: "si_core",
        current_period_start: 1_700_000_000,
        quantity: 3,
        price: {
          id: "price_core",
          unit_amount: 1000,
          currency: "gbp",
          metadata: { service_key: "core" },
        },
      }],
    },
  };
}

const priceRows = Object.fromEntries(
  [
    { key: "core", label: "ComplyTrack", amountPence: 1000 },
    ...fixtures,
    { key: "bundle", label: "ComplyTrack Complete", amountPence: 5000 },
  ].map(({ key, label, amountPence }) => [key, {
    id: `price_${key}`,
    key,
    metadataKey: key,
    label,
    unitAmount: amountPence,
    currency: "gbp",
    interval: "month",
    intervalCount: 1,
    active: true,
    productActive: true,
  }]),
);

const state = {
  client,
  siteCount: 3,
  priceRows,
  legacyPriceRow: null,
  queries: [],
  calls: null,
  stripe: null,
  subscription: null,
};

const stubs = {
  schema: `
    export const clientsTable = {
      __table: "clients", id: "clients.id", name: "clients.name",
      stripeCustomerId: "clients.stripeCustomerId",
      stripeSubscriptionId: "clients.stripeSubscriptionId",
      subscriptionStatus: "clients.subscriptionStatus",
      selectedServices: "clients.selectedServices",
      trialEndsAt: "clients.trialEndsAt",
      cancelledAt: "clients.cancelledAt",
      dataDeletionScheduledAt: "clients.dataDeletionScheduledAt",
      dataDeletedAt: "clients.dataDeletedAt",
    };
    export const sitesTable = { __table: "sites", clientId: "sites.clientId" };
    // Imported by lib/email.ts (billing routes import the mailer); never read here.
    export const appSettingsTable = {
      __table: "app_settings", clientId: "app_settings.clientId",
      key: "app_settings.key", value: "app_settings.value",
    };
  `,
  drizzle: `
    export const eq = (left, right) => ({ left, right });
    export const sql = (strings, ...values) => ({
      text: strings.reduce((text, part, index) => text + part + (index < values.length ? "?" : ""), ""),
      values,
    });
  `,
  db: `
    const state = globalThis.__billingAddonCatalogState;
    export const db = {
      select() {
        let table;
        const rows = () => {
          if (table?.__table === "sites") return [{ count: state.siteCount }];
          if (table?.__table === "clients") return [state.client];
          return [];
        };
        return {
          from(value) { table = value; return this; },
          where() { return this; },
          async limit() { return rows(); },
          then(resolve, reject) { return Promise.resolve(rows()).then(resolve, reject); },
        };
      },
      async execute(query) {
        state.queries.push(query);
        const text = query?.text ?? "";
        if (text.includes("SELECT pr.metadata->>'service_key' AS service_key")) {
          const rows = Object.values(state.priceRows)
            .filter((row) => row.metadataKey)
            .filter((row) => !text.includes("p.active = true") || row.productActive)
            .filter((row) => !text.includes("pr.active = true") || row.active)
            .filter((row) => !text.includes("interval') = 'month'") || row.interval === "month")
            .filter((row) => !text.includes("interval_count") || row.intervalCount === 1)
            .filter((row) => !text.includes("pr.currency =") || row.currency === "gbp")
            .map((row) => ({ service_key: row.metadataKey }));
          return { rows };
        }
        if (text.includes("pr.metadata->>'service_key' =")) {
          const key = query.values.find((value) => Object.hasOwn(state.priceRows, value));
          const row = state.priceRows[key];
          const valid = row
            && row.metadataKey === key
            && (!text.includes("p.active = true") || row.productActive)
            && (!text.includes("pr.active = true") || row.active)
            && (!text.includes("interval') = 'month'") || row.interval === "month")
            && (!text.includes("interval_count") || row.intervalCount === 1)
            && (!text.includes("pr.currency =") || row.currency === "gbp");
          return { rows: valid ? [{
            price_id: row.id,
            unit_amount: row.unitAmount,
            currency: row.currency,
            recurring: { interval: row.interval, interval_count: row.intervalCount },
          }] : [] };
        }
        if (text.includes("(pr.metadata->>'service_key') IS NULL")) {
          const row = state.legacyPriceRow;
          const valid = row
            && (!text.includes("p.active = true") || row.productActive)
            && (!text.includes("pr.active = true") || row.active)
            && (!text.includes("interval') = 'month'") || row.interval === "month")
            && (!text.includes("interval_count") || row.intervalCount === 1)
            && (!text.includes("pr.currency =") || row.currency === "gbp");
          return { rows: valid ? [{
            price_id: row.id,
            unit_amount: row.unitAmount,
            currency: row.currency,
            recurring: { interval: row.interval, interval_count: row.intervalCount },
          }] : [] };
        }
        return { rows: [] };
      },
    };
  `,
  stripe: `
    const state = globalThis.__billingAddonCatalogState;
    export const getStripePublishableKey = async () => "pk_test_offline_catalog";
    export const getUncachableStripeClient = async () => state.stripe;
    export const getStripeSync = async () => { throw new Error("Unexpected Stripe sync"); };
  `,
  auth: `
    export const getClientId = (req) => req.currentUser?.clientId ?? null;
    export const requireAuth = (_req, _res, next) => next();
    export const requireRole = (..._roles) => (_req, _res, next) => next();
    export const requireClientAdmin = (_req, _res, next) => next();
    export const denyViewers = (_req, _res, next) => next();
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
    export const releaseAlpsDiscountReservation = async () => {};
    export const reserveAlpsDiscount = async () => null;
    export const verifyClientDiscountCode = async () => false;
  `,
  logger: `export const logger = { error() {}, info() {}, warn() {} };`,
};

function fakeStripe() {
  const calls = {
    subscriptionList: [],
    subscriptionUpdate: [],
    subscriptionItemDelete: [],
    invoiceCreate: [],
    invoiceItemCreate: [],
    invoiceFinalize: [],
    invoicePay: [],
    invoiceRetrieve: [],
    invoiceVoid: [],
  };
  const stripe = {
    calls,
    subscriptions: {
      list: async (params) => {
        calls.subscriptionList.push(params);
        return { data: [state.subscription] };
      },
      update: async (subscriptionId, params, options) => {
        calls.subscriptionUpdate.push({ subscriptionId, params, options });
        const { price, quantity } = params.items[0];
        const row = Object.values(state.priceRows).find((candidate) => candidate.id === price);
        state.subscription.items.data.push({
          id: `si_${row.key}`,
          current_period_start: 1_700_000_000,
          quantity,
          price: {
            id: price,
            unit_amount: row.unitAmount,
            currency: row.currency,
            metadata: { service_key: row.metadataKey },
          },
        });
        return state.subscription;
      },
    },
    subscriptionItems: {
      del: async (id, params) => {
        calls.subscriptionItemDelete.push({ id, params });
        state.subscription.items.data = state.subscription.items.data.filter((item) => item.id !== id);
        return { id, deleted: true };
      },
    },
    invoices: {
      create: async (params, options) => {
        calls.invoiceCreate.push({ params, options });
        return { id: `in_${calls.invoiceCreate.length}` };
      },
      finalizeInvoice: async (invoiceId) => {
        calls.invoiceFinalize.push(invoiceId);
        return { id: invoiceId, status: "open" };
      },
      pay: async (invoiceId, params, options) => {
        calls.invoicePay.push({ invoiceId, params, options });
        return { id: invoiceId, status: "paid" };
      },
      retrieve: async (invoiceId) => {
        calls.invoiceRetrieve.push(invoiceId);
        return { id: invoiceId, status: "open" };
      },
      voidInvoice: async (invoiceId) => {
        calls.invoiceVoid.push(invoiceId);
        return { id: invoiceId, status: "void" };
      },
    },
    invoiceItems: {
      create: async (params, options) => {
        calls.invoiceItemCreate.push({ params, options });
        return { id: `ii_${calls.invoiceItemCreate.length}` };
      },
    },
  };
  state.calls = calls;
  return stripe;
}

let server;
try {
  globalThis.__billingAddonCatalogState = state;
  await build({
    entryPoints: [path.join(testsDir, "billing-addon-catalog.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
    plugins: [{
      name: "offline-billing-dependencies",
      setup(builder) {
        for (const [filter, name] of [
          [/^@workspace\/db\/schema$/, "schema"],
          [/^@workspace\/db$/, "db"],
          [/^drizzle-orm$/, "drizzle"],
          [/stripeClient$/, "stripe"],
          [/trialLock$/, "trialLock"],
          [/alpsDiscount$/, "alpsDiscount"],
          [/logger$/, "logger"],
          [/\/middleware\/requireAuth$/, "auth"],
        ]) {
          builder.onResolve({ filter }, () => ({ path: name, namespace: "billing-catalog-test" }));
        }
        builder.onLoad({ filter: /.*/, namespace: "billing-catalog-test" }, (args) => ({
          contents: stubs[args.path],
          loader: "js",
          resolveDir: testsDir,
        }));
      },
    }],
  });

  const { billingRouter, ADDON_KEYS, SERVICES, SERVICE_PRICE_CATALOGUE, getServicePrice } =
    await import(pathToFileURL(outFile).href);
  assert.equal(fixtures.length, 21, "the independently pinned add-on fixture must contain all 21 billable services");
  assert.deepEqual(
    Object.keys(SERVICES).filter((key) => key !== "core"),
    fixtures.map(({ key }) => key),
    "production SERVICES must agree with the pinned add-on catalogue",
  );
  assert.deepEqual(
    fixtures.map(({ key }) => ({ key, ...SERVICES[key] })),
    fixtures,
    "production SERVICES labels and amounts must agree with the pinned add-on catalogue",
  );
  assert.deepEqual(
    ADDON_KEYS,
    fixtures.map(({ key }) => key),
    "activation allowlist must agree with the pinned add-on catalogue",
  );
  assert.deepEqual(
    SERVICE_PRICE_CATALOGUE
      .filter(({ key }) => key !== "core" && key !== "bundle")
      .map(({ key, label, amountPence }) => ({ key, label, amountPence })),
    fixtures,
    "Stripe metadata price catalogue must agree with the independent add-on fixture",
  );

  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const clientId = req.header("x-test-client");
    req.currentUser = {
      id: 8,
      role: "client_admin",
      ...(clientId ? { clientId: Number(clientId) } : {}),
    };
    req.log = { error() {}, warn() {} };
    next();
  });
  app.use("/api/billing", billingRouter);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/billing`;
  async function request(method, route, body, { clientContext = false } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(clientContext ? { "x-test-client": String(client.id) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      data: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null,
    };
  }

  const config = await request("GET", "/config");
  assert.equal(config.status, 200);
  assert.equal(config.data.publishableKey, "pk_test_offline_catalog");
  assert.deepEqual(
    config.data.services.catalog
      .filter(({ key }) => key !== "core" && key !== "bundle")
      .map(({ key, label, amountPence }) => ({ key, label, amountPence })),
    fixtures,
    "GET /billing/config must return every pinned billable add-on with the expected label and amount",
  );
  assert.equal(config.data.services.catalog.find(({ key }) => key === "core")?.label, "ComplyTrack");
  assert.equal(config.data.services.catalog.find(({ key }) => key === "bundle")?.amountPence, 5000);

  for (const forbidden of ["unknown-service", "core", "bundle"]) {
    const before = state.calls;
    const response = await request(
      "POST",
      "/services",
      { service: forbidden, action: "add" },
      { clientContext: true },
    );
    assert.equal(response.status, 400, `${forbidden} must not be accepted as a self-service add-on`);
    assert.equal(state.calls, before, "rejected service keys must not touch fake Stripe");
  }

  for (const fixture of fixtures) {
    state.subscription = makeSubscription();
    state.stripe = fakeStripe();
    state.queries.length = 0;
    const response = await request(
      "POST",
      "/services",
      { service: fixture.key, action: "add" },
      { clientContext: true },
    );
    assert.equal(response.status, 200,
      `${fixture.key} should be accepted by the real /billing/services route: ${JSON.stringify(response.data)}; calls=${JSON.stringify(state.calls)}; queries=${state.queries.length}`);
    assert.ok(response.data.entitled.includes(fixture.key), `${fixture.key} should become entitled`);

    assert.deepEqual(state.calls.subscriptionUpdate, [{
      subscriptionId: "sub_offline_test",
      params: {
        items: [{ price: `price_${fixture.key}`, quantity: 3 }],
        proration_behavior: "none",
      },
      options: { idempotencyKey: `svc-add-sub_offline_test-${fixture.key}-1700000000` },
    }], `${fixture.key}: use the resolved price, exact site quantity and no proration`);
    const addedItem = state.subscription.items.data.find(
      (item) => item.price?.metadata?.service_key === fixture.key,
    );
    assert.ok(addedItem, `${fixture.key}: activated Stripe item must carry service_key metadata`);
    assert.equal(addedItem.price.id, `price_${fixture.key}`);
    assert.equal(addedItem.price.currency, "gbp");
    assert.equal(addedItem.price.unit_amount, fixture.amountPence);
    assert.equal(addedItem.quantity, 3);

    assert.equal(state.calls.invoiceCreate.length, 1, `${fixture.key}: collect one immediate first-month invoice`);
    assert.deepEqual(state.calls.invoiceCreate[0].params, {
      customer: "cus_offline_test",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      description: `${fixture.label} — 1 month access, 3 sites (no proration)`,
      automatic_tax: { enabled: true },
      metadata: {
        addon_service: fixture.key,
        client_id: String(client.id),
        period_start: "1700000000",
      },
    });
    assert.equal(state.calls.invoiceItemCreate.length, 1);
    assert.equal(state.calls.invoiceItemCreate[0].params.amount, fixture.amountPence * 3);
    assert.equal(state.calls.invoiceItemCreate[0].params.currency, "gbp");
    assert.equal(state.calls.invoiceItemCreate[0].params.invoice, "in_1");
    assert.equal(state.calls.invoiceFinalize.length, 1);
    assert.equal(state.calls.invoicePay.length, 1);
    assert.equal(state.calls.invoiceVoid.length, 0);
    assert.equal(state.calls.subscriptionItemDelete.length, 0);

    const priceQuery = state.queries.find((query) =>
      query.text.includes("pr.metadata->>'service_key' ="),
    );
    assert.ok(priceQuery, `${fixture.key}: production getServicePrice resolver must be used`);
    assert.match(priceQuery.text, /p\.active = true/);
    assert.match(priceQuery.text, /pr\.active = true/);
    assert.match(priceQuery.text, /interval'\) = 'month'/);
    assert.match(priceQuery.text, /interval_count/);
    assert.match(priceQuery.text, /pr\.currency =/);
    assert.equal(state.priceRows[fixture.key].metadataKey, fixture.key);
    assert.equal(state.priceRows[fixture.key].active, true);
    assert.equal(state.priceRows[fixture.key].productActive, true);
    assert.equal(state.priceRows[fixture.key].interval, "month");
    assert.equal(state.priceRows[fixture.key].currency, "gbp");
    assert.deepEqual(await getServicePrice(fixture.key), {
      priceId: `price_${fixture.key}`,
      unitAmount: fixture.amountPence,
      currency: "gbp",
      interval: "month",
    }, `${fixture.key}: real resolver should return the configured active recurring GBP price`);
  }

  const configuredPrice = state.priceRows.safetrack;
  configuredPrice.currency = "usd";
  state.subscription = makeSubscription();
  state.stripe = fakeStripe();
  state.queries.length = 0;
  const mismatchedPrice = await request(
    "POST",
    "/services",
    { service: "safetrack", action: "add" },
    { clientContext: true },
  );
  assert.equal(mismatchedPrice.status, 503, "a non-GBP synced price must block self-service activation");
  assert.ok(mismatchedPrice.data.missingServicePrices.includes("safetrack"));
  assert.deepEqual(state.calls.subscriptionUpdate, [], "price preflight must reject before Stripe mutation");
  assert.equal(await getServicePrice("safetrack"), null, "the real service resolver must reject non-GBP prices");
  const preflightQuery = state.queries.find((query) =>
    query.text.includes("SELECT pr.metadata->>'service_key' AS service_key"),
  );
  const mismatchedResolverQuery = state.queries.find((query) =>
    query.text.includes("pr.metadata->>'service_key' ="),
  );
  assert.match(preflightQuery.text, /pr\.currency =/, "readiness must use the same GBP requirement as activation");
  assert.match(mismatchedResolverQuery.text, /pr\.currency =/, "service price resolution must require GBP");
  configuredPrice.currency = "gbp";

  const missingRow = state.priceRows.pattrack;
  delete state.priceRows.pattrack;
  state.subscription = makeSubscription();
  state.stripe = fakeStripe();
  state.queries.length = 0;
  const missingPrice = await request(
    "POST",
    "/services",
    { service: "pattrack", action: "add" },
    { clientContext: true },
  );
  assert.equal(missingPrice.status, 503, "a missing active catalogue price must block self-service activation");
  assert.ok(missingPrice.data.missingServicePrices.includes("pattrack"));
  assert.deepEqual(state.calls.subscriptionUpdate, [], "missing price preflight must happen before Stripe mutation");

  // Removing an add-on whose catalogue price is missing (or archived) must
  // still delete the client's existing item: no price lookup, no proration,
  // no invoice and no other subscription change.
  for (const [variant, setup] of [
    ["missing", () => {}],
    ["archived", () => { state.priceRows.pattrack = { ...missingRow, active: false }; }],
  ]) {
    setup();
    state.subscription = makeSubscription();
    state.subscription.items.data.push({
      id: "si_pattrack_existing",
      current_period_start: 1_700_000_000,
      quantity: 3,
      price: { id: "price_pattrack_retired", unit_amount: 1000, currency: "gbp", metadata: { service_key: "pattrack" } },
    });
    state.stripe = fakeStripe();
    state.queries.length = 0;
    const removed = await request("POST", "/services", { service: "pattrack", action: "remove" }, { clientContext: true });
    assert.equal(removed.status, 200, `${variant} price: removal must succeed: ${JSON.stringify(removed.data)}`);
    assert.deepEqual(state.calls.subscriptionItemDelete, [
      { id: "si_pattrack_existing", params: { proration_behavior: "none" } },
    ], `${variant} price: delete exactly the client's existing item without proration`);
    assert.deepEqual(state.calls.subscriptionUpdate, []);
    assert.equal(state.calls.invoiceCreate.length + state.calls.invoiceItemCreate.length + state.calls.invoicePay.length, 0,
      `${variant} price: removal must never charge`);
    assert.ok(!state.queries.some((query) => query.text.includes("pr.metadata->>'service_key' =")),
      `${variant} price: removal must not resolve the catalogue price`);
    assert.ok(!state.subscription.items.data.some((item) => item.price?.metadata?.service_key === "pattrack"));
    delete state.priceRows.pattrack;
  }
  state.subscription = makeSubscription();
  state.stripe = fakeStripe();
  const notActive = await request("POST", "/services", { service: "pattrack", action: "remove" }, { clientContext: true });
  assert.equal(notActive.status, 409, "removing a service the client does not have is still rejected");
  assert.deepEqual(state.calls.subscriptionItemDelete, []);
  state.priceRows.pattrack = missingRow;

  state.priceRows.core = undefined;
  state.legacyPriceRow = {
    id: "price_legacy_core",
    unitAmount: 1000,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
    active: true,
    productActive: true,
  };
  state.queries.length = 0;
  assert.equal(await getServicePrice("core"), null, "legacy core fallback must reject a non-GBP monthly price");
  const fallbackQuery = state.queries.find((query) =>
    query.text.includes("(pr.metadata->>'service_key') IS NULL"),
  );
  assert.match(fallbackQuery.text, /pr\.currency =/);
  state.legacyPriceRow.currency = "gbp";
  assert.deepEqual(await getServicePrice("core"), {
    priceId: "price_legacy_core",
    unitAmount: 1000,
    currency: "gbp",
    interval: "month",
  }, "legacy metadata-free core fallback remains available for GBP monthly prices");

  console.log("Billing add-on catalogue regression tests passed for all 21 services.");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  delete globalThis.__billingAddonCatalogState;
  await rm(outDir, { recursive: true, force: true });
}