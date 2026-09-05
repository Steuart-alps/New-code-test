// Focused unit tests for paid add-on activation invoice collection.
//
// Covers a declined payment, a lost Stripe payment response, and stable
// idempotency keys used when the caller retries an activation.
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

function fakeStripe({ pay = "paid", retrieve = "open" } = {}) {
  const calls = { create: [], item: [], pay: [], void: [] };
  return {
    calls,
    invoices: {
      create: async (_params, options) => {
        calls.create.push(options.idempotencyKey);
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
      create: async (_params, options) => {
        calls.item.push(options.idempotencyKey);
        return { id: "ii_addon_1" };
      },
    },
  };
}

const input = {
  customerId: "cus_1",
  amount: 1000,
  currency: "gbp",
  description: "SafeTrack — 1 month access, 1 site (no proration)",
  metadata: { addon_service: "safetrack", client_id: "1", period_start: "1" },
  idempotencyPrefix: "svc-add-sub_1-safetrack-1",
};

const { lib, cleanup } = await loadCollector();
try {
  {
    const stripe = fakeStripe();
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, input), "paid");
    // A request retry must present the exact same Stripe keys, so Stripe can
    // return its original invoice/payment instead of creating another charge.
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, input), "paid");
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
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, input), "not_collected");
    assert.deepEqual(stripe.calls.void, ["in_addon_1"]);
  }

  {
    // Stripe may have charged the card even though the payment response was
    // lost.  Retrieval confirms payment and never compensates it away.
    const stripe = fakeStripe({ pay: "throws", retrieve: "paid" });
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, input), "paid");
    assert.deepEqual(stripe.calls.void, []);
  }

  {
    // If neither the payment response nor retrieval is available, preserve
    // access; removing it could leave a charged client without entitlement.
    const stripe = fakeStripe({ pay: "throws", retrieve: "throws" });
    assert.equal(await lib.collectAddonFirstMonthInvoice(stripe, input), "unknown");
    assert.deepEqual(stripe.calls.void, []);
  }

  console.log("Paid add-on activation safety tests passed.");
} finally {
  await cleanup();
}