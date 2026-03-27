import { getUncachableStripeClient } from "./stripeClient";

async function seedPlans() {
  const stripe = await getUncachableStripeClient();
  console.log("Checking existing ComplyTrack plans...");

  const existing = await stripe.products.search({ query: "active:'true'" });
  const names = existing.data.map((p) => p.name);
  console.log("Existing active products:", names.length ? names.join(", ") : "none");

  // ── Starter plan ────────────────────────────────────────────────────────────
  if (!names.includes("Starter")) {
    const starter = await stripe.products.create({
      name: "Starter",
      description: "Up to 3 users · Core compliance tracking · Email reminders",
      metadata: { features: "3 users,External checks,Internal checks,Email reminders" },
    });
    await stripe.prices.create({
      product: starter.id,
      unit_amount: 4900,
      currency: "gbp",
      recurring: { interval: "month" },
    });
    await stripe.prices.create({
      product: starter.id,
      unit_amount: 49000,
      currency: "gbp",
      recurring: { interval: "year" },
    });
    console.log("✓ Created Starter plan (£49/mo · £490/yr)");
  } else {
    console.log("  Starter already exists, skipping");
  }

  // ── Professional plan ────────────────────────────────────────────────────────
  if (!names.includes("Professional")) {
    const pro = await stripe.products.create({
      name: "Professional",
      description: "Up to 10 users · All modules · Departments · Priority support",
      metadata: {
        features: "10 users,All modules,Departments,Priority support",
        recommended: "true",
      },
    });
    await stripe.prices.create({
      product: pro.id,
      unit_amount: 9900,
      currency: "gbp",
      recurring: { interval: "month" },
    });
    await stripe.prices.create({
      product: pro.id,
      unit_amount: 99000,
      currency: "gbp",
      recurring: { interval: "year" },
    });
    console.log("✓ Created Professional plan (£99/mo · £990/yr)");
  } else {
    console.log("  Professional already exists, skipping");
  }

  // ── Enterprise plan ──────────────────────────────────────────────────────────
  if (!names.includes("Enterprise")) {
    const enterprise = await stripe.products.create({
      name: "Enterprise",
      description: "Unlimited users · White-label · Dedicated onboarding · SLA",
      metadata: { features: "Unlimited users,White-label,Dedicated onboarding,SLA" },
    });
    await stripe.prices.create({
      product: enterprise.id,
      unit_amount: 24900,
      currency: "gbp",
      recurring: { interval: "month" },
    });
    await stripe.prices.create({
      product: enterprise.id,
      unit_amount: 249000,
      currency: "gbp",
      recurring: { interval: "year" },
    });
    console.log("✓ Created Enterprise plan (£249/mo · £2,490/yr)");
  } else {
    console.log("  Enterprise already exists, skipping");
  }

  console.log("\nDone. Webhooks will sync these to the database automatically.");
  process.exit(0);
}

seedPlans().catch((err) => {
  console.error(err);
  process.exit(1);
});
