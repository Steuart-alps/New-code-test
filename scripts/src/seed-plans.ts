import { getUncachableStripeClient } from "./stripeClient";

const PRODUCT_NAME = "ComplyTrack";
const PER_SITE_AMOUNT = 1000; // £10.00 / month per site, in pence
const LEGACY_TIERS = ["Starter", "Professional", "Enterprise"];

async function seedPlans() {
  const stripe = await getUncachableStripeClient();
  console.log("Configuring ComplyTrack per-site pricing...");

  const existing = await stripe.products.search({ query: "active:'true'" });

  // ── Archive legacy tiered products ──────────────────────────────────────────
  // Existing subscriptions on these prices keep running; archiving only stops the
  // tiers from appearing for new customers (and from /billing/plans).
  for (const product of existing.data) {
    if (LEGACY_TIERS.includes(product.name)) {
      await stripe.products.update(product.id, { active: false });
      console.log(`  Archived legacy plan: ${product.name}`);
    }
  }

  // ── Per-site product + price ────────────────────────────────────────────────
  let product = existing.data.find((p) => p.name === PRODUCT_NAME);
  if (!product) {
    product = await stripe.products.create({
      name: PRODUCT_NAME,
      description: "Health & safety compliance tracking — billed per site",
      metadata: { per_site: "true" },
    });
    console.log(`✓ Created product: ${PRODUCT_NAME}`);
  } else {
    console.log(`  Product ${PRODUCT_NAME} already exists`);
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const hasPerSitePrice = prices.data.some(
    (pr) =>
      pr.recurring?.interval === "month" &&
      pr.unit_amount === PER_SITE_AMOUNT &&
      pr.currency === "gbp",
  );

  if (!hasPerSitePrice) {
    await stripe.prices.create({
      product: product.id,
      unit_amount: PER_SITE_AMOUNT,
      currency: "gbp",
      recurring: { interval: "month" },
      metadata: { per_site: "true" },
    });
    console.log("✓ Created per-site price (£10/site/month)");
  } else {
    console.log("  Per-site price already exists, skipping");
  }

  console.log("\nDone. Webhooks will sync these to the database automatically.");
  process.exit(0);
}

seedPlans().catch((err) => {
  console.error(err);
  process.exit(1);
});
