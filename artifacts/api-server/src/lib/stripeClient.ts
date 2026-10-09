import Stripe from "stripe";

/**
 * Where Stripe credentials come from, without reading them. Null means Stripe
 * is not configured for this process (start-up then reports billing as
 * unconfigured instead of attempting initialization).
 */
export function getStripeCredentialSource(): "env" | null {
  return process.env.STRIPE_SECRET_KEY ? "env" : null;
}

async function getCredentials() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
    secretKey,
  };
}

// WARNING: Never cache this client. Always call this function to get a fresh client.
export async function getUncachableStripeClient() {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, { apiVersion: "2025-08-27.basil" as any });
}

export async function getStripePublishableKey() {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey() {
  const { secretKey } = await getCredentials();
  return secretKey;
}

let stripeSync: any = null;

/**
 * `onStage` lets start-up report which step is running (SDK import, credential
 * lookup, client construction) so a stall can be attributed to one of them.
 */
export async function getStripeSync(onStage?: (stage: string) => void) {
  if (!stripeSync) {
    onStage?.("sync SDK import");
    const { StripeSync } = await import("stripe-replit-sync");
    onStage?.("credential lookup");
    const secretKey = await getStripeSecretKey();
    onStage?.("sync client construction");
    stripeSync = new StripeSync({
      poolConfig: { connectionString: process.env.DATABASE_URL!, max: 2 },
      stripeSecretKey: secretKey,
    });
  }
  return stripeSync;
}
