// Regression coverage for PestTrack's paid-service wiring. This is deliberately
// offline: activating an add-on must never require a production Stripe account
// to prove the price, invoice, and entitlement contracts.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(testsDir, "..");
const workspaceDir = path.resolve(apiDir, "../..");
const outDir = await mkdtemp(path.join(testsDir, ".build-"));
const outFile = path.join(outDir, "pesttrack-billing.mjs");

function fakeStripe() {
  const calls = { create: [], item: [], pay: [] };
  return {
    calls,
    invoices: {
      create: async (_params, options) => {
        calls.create.push(options.idempotencyKey);
        return { id: "in_pest_1" };
      },
      finalizeInvoice: async () => ({ id: "in_pest_1", status: "open" }),
      pay: async (_id, _params, options) => {
        calls.pay.push(options.idempotencyKey);
        return { id: "in_pest_1", status: "paid" };
      },
      retrieve: async () => ({ id: "in_pest_1", status: "paid" }),
      voidInvoice: async () => ({ id: "in_pest_1", status: "void" }),
    },
    invoiceItems: {
      create: async (_params, options) => {
        calls.item.push(options.idempotencyKey);
        return { id: "ii_pest_1" };
      },
    },
  };
}

try {
  await build({
    entryPoints: [path.join(testsDir, "pesttrack-billing.entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outFile,
    logLevel: "silent",
    external: ["pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*", "nodemailer"],
    banner: { js: "import { createRequire } from 'node:module'; globalThis.require = createRequire(import.meta.url);" },
  });

  const { ADDON_KEYS, SERVICES, collectAddonFirstMonthInvoice } =
    await import(new URL(`file://${outFile}`).href);
  assert.deepEqual(SERVICES.pesttrack, { label: "PestTrack", amountPence: 1000 });
  assert.ok(ADDON_KEYS.includes("pesttrack"), "PestTrack must be accepted as a paid add-on");

  // The first-month collection uses stable, PestTrack-scoped Stripe keys.
  // Retrying the same activation therefore cannot create a second charge.
  const stripe = fakeStripe();
  const input = {
    customerId: "cus_pest_client_41",
    amount: 1000,
    currency: "gbp",
    description: "PestTrack — 1 month access, 1 site (no proration)",
    metadata: { addon_service: "pesttrack", client_id: "41", period_start: "1700000000" },
    idempotencyPrefix: "svc-add-sub_pest_1-pesttrack-1700000000",
  };
  assert.equal(await collectAddonFirstMonthInvoice(stripe, input), "paid");
  assert.equal(await collectAddonFirstMonthInvoice(stripe, input), "paid");
  assert.deepEqual(stripe.calls.create, [
    "svc-add-sub_pest_1-pesttrack-1700000000-inv",
    "svc-add-sub_pest_1-pesttrack-1700000000-inv",
  ]);
  assert.deepEqual(stripe.calls.item, [
    "svc-add-sub_pest_1-pesttrack-1700000000-item",
    "svc-add-sub_pest_1-pesttrack-1700000000-item",
  ]);
  assert.deepEqual(stripe.calls.pay, [
    "svc-add-sub_pest_1-pesttrack-1700000000-pay",
    "svc-add-sub_pest_1-pesttrack-1700000000-pay",
  ]);

  const [billingRoute, routeIndex, signupPlan, navGroups, settingsPage] = await Promise.all([
    readFile(path.join(apiDir, "src/routes/billing.ts"), "utf8"),
    readFile(path.join(apiDir, "src/routes/index.ts"), "utf8"),
    readFile(path.join(workspaceDir, "artifacts/compliance-tracker/src/lib/signup-plan.ts"), "utf8"),
    readFile(path.join(workspaceDir, "artifacts/compliance-tracker/src/lib/nav-groups.ts"), "utf8"),
    readFile(path.join(workspaceDir, "artifacts/compliance-tracker/src/pages/settings.tsx"), "utf8"),
  ]);

  // A missing synced PestTrack price is a safe failure: it is detected before
  // Stripe subscription mutation or invoice collection.
  const priceCheck = billingRoute.indexOf('if (!price) return res.status(400).json({ error: "Service price not configured" });');
  const activation = billingRoute.indexOf('if (action === "add")');
  assert.ok(priceCheck >= 0 && priceCheck < activation, "missing add-on price must fail before activation");

  // The route derives the client solely from authenticated context. The
  // clientId request field is intentionally parsed only for compatibility and
  // must never be used to bill or alter a different tenant.
  assert.match(billingRoute, /const clientId = getClientId\(req\);/);
  assert.equal(
    (billingRoute.match(/\bbodyClientId\b/g) ?? []).length,
    1,
    "request clientId must not influence billing tenant selection",
  );
  assert.match(
    routeIndex,
    /router\.use\("\/pest-track",\s*requireAuth,\s*requireService\("pesttrack"\),\s*pestTrackRouter\)/,
    "PestTrack API access must remain entitlement-gated",
  );
  assert.match(navGroups, /href: "\/pest-track",\s+label: "PestTrack",\s+icon: Bug,\s+serviceKey: "pesttrack"/);
  assert.match(signupPlan, /"pesttrack"/, "signup plan must preserve PestTrack selection");
  assert.match(
    settingsPage,
    /servicesConfig\.catalog[\s\S]*handleServiceAction\(service\.key,\s*"add"\)/,
    "billing settings must expose catalog add-ons, including PestTrack",
  );

  console.log("PestTrack billing wiring tests passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}