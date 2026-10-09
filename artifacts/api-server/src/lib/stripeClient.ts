import Stripe from "stripe";

let connectionSettings: any;

/** Default bound on the Replit connector credential request. */
const DEFAULT_CONNECTOR_TIMEOUT_MS = 10_000;

function replitConnectorToken(): string | null {
  return process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;
}

/**
 * Where Stripe credentials would come from, without reading or requesting them.
 * Null means Stripe is not configured for this process.
 */
export function getStripeCredentialSource(): "env" | "replit-connector" | null {
  if (process.env.STRIPE_SECRET_KEY) return "env";
  if (process.env.REPLIT_CONNECTORS_HOSTNAME && replitConnectorToken()) return "replit-connector";
  return null;
}

async function getCredentials() {
  // Standard configuration: keys from the environment, as on any host.
  const envSecret = process.env.STRIPE_SECRET_KEY;
  if (envSecret) {
    return {
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
      secretKey: envSecret,
    };
  }

  // Fallback for Replit deployments: keys from Replit's Stripe connector.
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = replitConnectorToken();

  if (!xReplitToken) {
    throw new Error("STRIPE_SECRET_KEY is not set (and no Replit Stripe connector is available)");
  }

  const connectorName = "stripe";
  const isProduction = process.env.REPLIT_DEPLOYMENT === "1";
  const targetEnvironment = isProduction ? "production" : "development";

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set("include_secrets", "true");
  url.searchParams.set("connector_names", connectorName);
  url.searchParams.set("environment", targetEnvironment);

  // Bound the connector request: an unanswered request previously left API
  // start-up waiting indefinitely. The error names no token or secret.
  const parsedTimeout = Number(process.env.STRIPE_CONNECTOR_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_CONNECTOR_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`Stripe connector credential request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }

  const data = await response.json() as any;
  connectionSettings = data.items?.[0];

  if (!connectionSettings || (!connectionSettings.settings.publishable || !connectionSettings.settings.secret)) {
    throw new Error(`Stripe ${targetEnvironment} connection not found`);
  }

  return {
    publishableKey: connectionSettings.settings.publishable,
    secretKey: connectionSettings.settings.secret,
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
