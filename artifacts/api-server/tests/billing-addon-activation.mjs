// Focused unit tests for paid add-on activation invoice collection.
//
// Covers add-on selection, site quantities, entitlement refresh, rollback,
// declined payments, lost Stripe responses, and stable idempotency keys.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));

async function loadCollector() {
  const outDir = await mkdtemp(path.join(testsDir, ".build-"));
  const outFile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(testsDir, "billing-addon-activation.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
  });
  return {
    lib: await import(new URL(`file://${outFile}`).href),
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  };
}

function fakeStripe({
  pay = "paid",
  retrieve = "open",
  invoiceCreateThrows = false,
  invoiceItemCreateThrows = false,
  serviceByPrice = {},
} = {}) {
  const calls = { create: [], item: [], pay: [], void: [], update: [], del: [] };
  const liveSubscription = {
    id: "sub_1",
    created: 1_699_999_000,
    items: {
      data: [{
        id: "si_core",
        current_period_start: 1_700_000_000,
        price: { metadata: { service_key: "core" } },
      }],
    },
  };
  const client = {
    subscriptions: {
      update: async (subscriptionId, params, options) => {
        calls.update.push({ subscriptionId, params, options });
        const { price, quantity } = params.items[0];
        const service = serviceByPrice[price];
        liveSubscription.items.data.push({
          id: `si_${service}`,
          current_period_start: 1_700_000_000,
          quantity,
          price: { id: price, metadata: { service_key: service } },
        });
        return liveSubscription;
      },
    },
    subscriptionItems: {
      del: async (id, params) => {
        calls.del.push({ id, params });
        liveSubscription.items.data = liveSubscription.items.data.filter((item) => item.id !== id);
        return { id, deleted: true };
      },
    },
    calls,
    liveSubscription,
    invoices: {
      create: async (params, options) => {
        calls.invoiceParams = params;
        calls.create.push(options.idempotencyKey);
        if (invoiceCreateThrows) throw new Error("invoice creation failed");
        return { id: "in_addon_1" };
      },
      finalizeInvoice: async () => ({ id: "in_addon_1", status: "open" }),
      pay: async (_id, _params, options) => {
        calls.pay.push(options.idempotencyKey);
        if (pay === "throws") throw new Error("connection dropped");
        return { id: "in_addon_1", status: pay };
      },
      retrieve: async () => {
        if (retrieve === "throws") throw new Error("Stripe unavailable");
        return { id: "in_addon_1", status: retrieve };
      },
      voidInvoice: async (id) => {
        calls.void.push(id);
        return { id, status: "void" };
      },
    },
    invoiceItems: {
      create: async (params, options) => {
        if (invoiceItemCreateThrows) throw new Error("invoice item creation failed");
        calls.invoiceItemParams = params;
        calls.item.push(options.idempotencyKey);
        return { id: "ii_addon_1" };
      },
    },
  };
  return client;
}

const { lib, cleanup } = await loadCollector();
try {
  const serviceFixtures = [
    {
      service: "doctrack",
      label: "DocTrack",
      priceId: "price_doctrack_month",
      unitAmount: 1250,
    },
    {
      service: "traintrack",
      label: "TrainTrack",
      priceId: "price_traintrack_month",
      unitAmount: 1750,
    },
  ];

  for (const fixture of serviceFixtures) {
    const stripe = fakeStripe({
      serviceByPrice: { [fixture.priceId]: fixture.service },
    });
    const events = [];
    const priceLookups = [];
    const entitled = ["core", fixture.service];
    const result = await lib.activatePaidAddonService({
      allowedServiceKeys: serviceFixtures.map((item) => item.service),
      service: fixture.service,
      serviceLabel: fixture.label,
      clientId: 41,
      customerId: "cus_1",
      subscription: stripe.liveSubscription,
      stripe,
      getServicePrice: async (service) => {
        priceLookups.push(service);
        assert.equal(service, fixture.service, "activation must resolve the requested service price");
        return {
          priceId: fixture.priceId,
          unitAmount: fixture.unitAmount,
          currency: "gbp",
          interval: "month",
        };
      },
      countClientSites: async () => 3,
      findLiveSubscription: async () => stripe.liveSubscription,
      collectFirstMonthInvoice: lib.collectAddonFirstMonthInvoice,
      invalidateEntitlements: (clientId) => events.push(`invalidate:${clientId}`),
      getEntitledServices: async (clientId) => {
        events.push(`entitlements:${clientId}`);
        return entitled;
      },
    });

    assert.deepEqual(result, { status: "activated", entitled });
    assert.deepEqual(priceLookups, [fixture.service]);
    assert.deepEqual(stripe.calls.update, [{
      subscriptionId: "sub_1",
      params: {
        items: [{ price: fixture.priceId, quantity: 3 }],
        proration_behavior: "none",
      },
      options: {
        idempotencyKey: `svc-add-sub_1-${fixture.service}-1700000000`,
      },
    }]);
    assert.equal(stripe.calls.invoiceItemParams.amount, fixture.unitAmount * 3);
    assert.match(
      stripe.calls.invoiceItemParams.description,
      new RegExp(`${fixture.label} — 1 month access, 3 sites`),
    );
    assert.deepEqual(events, ["invalidate:41", "entitlements:41"]);
    assert.deepEqual(stripe.calls.del, []);
  }

  {
    const stripe = fakeStripe();
    let priceLookups = 0;
    const result = await lib.activatePaidAddonService({
      allowedServiceKeys: ["doctrack", "traintrack"],
      service: "not-a-service",
      serviceLabel: "Unknown",
      clientId: 41,
      customerId: "cus_1",
      subscription: stripe.liveSubscription,
      stripe,
      getServicePrice: async () => {
        priceLookups++;
        return null;
      },
      countClientSites: async () => 1,
      findLiveSubscription: async () => stripe.liveSubscription,
      collectFirstMonthInvoice: lib.collectAddonFirstMonthInvoice,
      invalidateEntitlements: () => {},
      getEntitledServices: async () => [],
    });
    assert.deepEqual(result, { status: "unknown_service" });
    assert.equal(priceLookups, 0);
    assert.deepEqual(stripe.calls.update, []);
  }

  {
    const stripe = fakeStripe();
    stripe.liveSubscription.items.data.push({
      id: "si_doctrack",
      current_period_start: 1_700_000_000,
      price: { metadata: { service_key: "doctrack" } },
    });
    const result = await lib.activatePaidAddonService({
      allowedServiceKeys: ["doctrack", "traintrack"],
      service: "doctrack",
      serviceLabel: "DocTrack",
      clientId: 41,
      customerId: "cus_1",
      subscription: stripe.liveSubscription,
      stripe,
      getServicePrice: async () => ({
        priceId: "price_doctrack_month",
        unitAmount: 1000,
        currency: "gbp",
        interval: "month",
      }),
      countClientSites: async () => 3,
      findLiveSubscription: async () => stripe.liveSubscription,
      collectFirstMonthInvoice: lib.collectAddonFirstMonthInvoice,
      invalidateEntitlements: () => {},
      getEntitledServices: async () => [],
    });
    assert.deepEqual(result, { status: "already_active" });
    assert.deepEqual(stripe.calls.update, []);
    assert.deepEqual(stripe.calls.create, []);
  }

  for (const failure of ["invoice_create", "invoice_item_create"]) {
    const stripe = fakeStripe({
      serviceByPrice: { price_doctrack_month: "doctrack" },
      invoiceCreateThrows: failure === "invoice_create",
      invoiceItemCreateThrows: failure === "invoice_item_create",
    });
    const invalidated = [];
    const result = await lib.activatePaidAddonService({
      allowedServiceKeys: ["doctrack"],
      service: "doctrack",
      serviceLabel: "DocTrack",
      clientId: 41,
      customerId: "cus_1",
      subscription: stripe.liveSubscription,
      stripe,
      getServicePrice: async (service) => {
        assert.equal(service, "doctrack");
        return {
          priceId: "price_doctrack_month",
          unitAmount: 1000,
          currency: "gbp",
          interval: "month",
        };
      },
      countClientSites: async () => 2,
      findLiveSubscription: async () => stripe.liveSubscription,
      collectFirstMonthInvoice: lib.collectAddonFirstMonthInvoice,
      invalidateEntitlements: (clientId) => invalidated.push(clientId),
      getEntitledServices: async () => ["core", "doctrack"],
    });
    assert.deepEqual(result, { status: "charge_failed" }, `${failure} should fail activation`);
    assert.deepEqual(stripe.calls.del, [{
      id: "si_doctrack",
      params: { proration_behavior: "none" },
    }]);
    assert.equal(
      stripe.liveSubscription.items.data.some(
        (item) => item.price?.metadata?.service_key === "doctrack",
      ),
      false,
      `${failure} must remove the newly added subscription item`,
    );
    assert.deepEqual(invalidated, [41]);
    assert.equal(
      stripe.calls.invoiceParams?.auto_advance ?? false,
      false,
      "a partially configured invoice must not collect automatically later",
    );
  }

  {
    const stripe = fakeStripe({
      serviceByPrice: { price_traintrack_month: "traintrack" },
      pay: "throws",
      retrieve: "throws",
    });
    const invalidated = [];
    let entitlementRefreshes = 0;
    const result = await lib.activatePaidAddonService({
      allowedServiceKeys: ["traintrack"],
      service: "traintrack",
      serviceLabel: "TrainTrack",
      clientId: 41,
      customerId: "cus_1",
      subscription: stripe.liveSubscription,
      stripe,
      getServicePrice: async () => ({
        priceId: "price_traintrack_month",
        unitAmount: 1000,
        currency: "gbp",
        interval: "month",
      }),
      countClientSites: async () => 1,
      findLiveSubscription: async () => stripe.liveSubscription,
      collectFirstMonthInvoice: lib.collectAddonFirstMonthInvoice,
      invalidateEntitlements: (clientId) => invalidated.push(clientId),
      getEntitledServices: async () => {
        entitlementRefreshes++;
        return ["core", "traintrack"];
      },
    });
    assert.deepEqual(result, { status: "payment_unknown" });
    assert.deepEqual(stripe.calls.del, [], "indeterminate payment must preserve the add-on item");
    assert.deepEqual(invalidated, [41]);
    assert.equal(entitlementRefreshes, 0);
  }

  {
    const stripe = fakeStripe({
      serviceByPrice: { price_traintrack_month: "traintrack" },
      pay: "unpaid",
      retrieve: "open",
    });
    const result = await lib.activatePaidAddonService({
      allowedServiceKeys: ["traintrack"],
      service: "traintrack",
      serviceLabel: "TrainTrack",
      clientId: 41,
      customerId: "cus_1",
      subscription: stripe.liveSubscription,
      stripe,
      getServicePrice: async () => ({
        priceId: "price_traintrack_month",
        unitAmount: 1000,
        currency: "gbp",
        interval: "month",
      }),
      countClientSites: async () => 1,
      findLiveSubscription: async () => stripe.liveSubscription,
      collectFirstMonthInvoice: lib.collectAddonFirstMonthInvoice,
      invalidateEntitlements: () => {},
      getEntitledServices: async () => ["core", "traintrack"],
    });
    assert.deepEqual(result, { status: "charge_failed" });
    assert.deepEqual(stripe.calls.void, ["in_addon_1"]);
    assert.deepEqual(stripe.calls.del, [{
      id: "si_traintrack",
      params: { proration_behavior: "none" },
    }]);
  }

  const collectorInput = {
    customerId: "cus_1",
    amount: 1000,
    currency: "gbp",
    description: "SafeTrack — 1 month access, 1 site (no proration)",
    metadata: { addon_service: "safetrack", client_id: "1", period_start: "1" },
    idempotencyPrefix: "svc-add-sub_1-safetrack-1",
  };

  {
    const stripe = fakeStripe();
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, collectorInput), "paid");
    // A request retry must present the exact same Stripe keys, so Stripe can
    // return its original invoice/payment instead of creating another charge.
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, collectorInput), "paid");
    assert.deepEqual(stripe.calls.create, [
      "svc-add-sub_1-safetrack-1-inv",
      "svc-add-sub_1-safetrack-1-inv",
    ]);
    assert.deepEqual(stripe.calls.item, [
      "svc-add-sub_1-safetrack-1-item",
      "svc-add-sub_1-safetrack-1-item",
    ]);
    assert.deepEqual(stripe.calls.pay, [
      "svc-add-sub_1-safetrack-1-pay",
      "svc-add-sub_1-safetrack-1-pay",
    ]);
  }

  {
    // A declined payment is explicitly voided, allowing the route to remove
    // the subscription item without a later automatic invoice charge.
    const stripe = fakeStripe({ pay: "throws", retrieve: "open" });
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, collectorInput), "not_collected");
    assert.deepEqual(stripe.calls.void, ["in_addon_1"]);
  }

  {
    // Stripe may have charged the card even though the payment response was
    // lost.  Retrieval confirms payment and never compensates it away.
    const stripe = fakeStripe({ pay: "throws", retrieve: "paid" });
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, collectorInput), "paid");
    assert.deepEqual(stripe.calls.void, []);
  }

  {
    // If neither the payment response nor retrieval is available, preserve
    // access; removing it could leave a charged client without entitlement.
    const stripe = fakeStripe({ pay: "throws", retrieve: "throws" });
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, collectorInput), "unknown");
    assert.deepEqual(stripe.calls.void, []);
  }

  console.log("Paid add-on activation safety tests passed.");
} finally {
  await cleanup();
}