import { getUncachableStripeClient } from "./stripeClient";

// Per-site service catalog. Keep in sync with artifacts/api-server/src/lib/services.ts
const CORE = { key: "core", name: "ComplyTrack", amount: 1000, description: "Health & safety compliance tracking — billed per site" };
const ADDONS = [
  { key: "firetrack", name: "FireTrack", amount: 1000, description: "Digital fire safety logbook — billed per site" },
  { key: "kitchentrack", name: "KitchenTrack", amount: 1000, description: "Daily kitchen food safety diary — billed per site" },
  { key: "legionellatrack", name: "LegionellaTrack", amount: 1000, description: "Legionella water safety logbook (L8/HSG274 compliance) — billed per site" },
];
const BUNDLE = { key: "bundle", name: "ComplyTrack Complete", amount: 5000, description: "Every ComplyTrack service, current and future — billed per site" };
const LEGACY_TIERS = ["Starter", "Professional", "Enterprise"];

async function ensureProductWithPrice(
  stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>,
  existing: { data: any[] },
  svc: { key: string; name: string; amount: number; description: string },
) {
  let product = existing.data.find((p) => p.name === svc.name);
  if (!product) {
    product = await stripe.products.create({
      name: svc.name,
      description: svc.description,
      metadata: { per_site: "true", service_key: svc.key },
    });
    console.log(`✓ Created product: ${svc.name}`);
  } else if (product.metadata?.service_key !== svc.key) {
    await stripe.products.update(product.id, {
      metadata: { ...product.metadata, per_site: "true", service_key: svc.key },
    });
    console.log(`  Tagged product ${svc.name} with service_key=${svc.key}`);
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const match = prices.data.find(
    (pr) => pr.recurring?.interval === "month" && pr.unit_amount === svc.amount && pr.currency === "gbp",
  );
  if (!match) {
    await stripe.prices.create({
      product: product.id,
      unit_amount: svc.amount,
      currency: "gbp",
      recurring: { interval: "month" },
      metadata: { per_site: "true", service_key: svc.key },
    });
    console.log(`✓ Created price for ${svc.name} (£${svc.amount / 100}/site/month)`);
  } else if (match.metadata?.service_key !== svc.key) {
    await stripe.prices.update(match.id, {
      metadata: { ...match.metadata, per_site: "true", service_key: svc.key },
    });
    console.log(`  Tagged price for ${svc.name} with service_key=${svc.key}`);
  } else {
    console.log(`  ${svc.name} price already configured`);
  }
}

async function seedPlans() {
  const stripe = await getUncachableStripeClient();
  console.log("Configuring ComplyTrack per-site service pricing...");

  const existing = await stripe.products.search({ query: "active:'true'", limit: 100 });

  // Archive legacy tiered products (existing subscriptions keep running).
  for (const product of existing.data) {
    if (LEGACY_TIERS.includes(product.name)) {
      await stripe.products.update(product.id, { active: false });
      console.log(`  Archived legacy plan: ${product.name}`);
    }
  }

  for (const svc of [CORE, ...ADDONS, BUNDLE]) {
    await ensureProductWithPrice(stripe, existing, svc);
  }

  console.log("\nDone. Webhooks will sync these to the database automatically.");
  process.exit(0);
}

seedPlans().catch((err) => {
  console.error(err);
  process.exit(1);
});
