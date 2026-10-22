// Real API (routes, sessions, tenant checks, SQL) for the AI add-on suite.
// Only Stripe is replaced (ai-addon-stripe.stub.ts, swapped in by the
// suite's bundler); Claude is a local stand-in reached through
// ANTHROPIC_BASE_URL.
import type { AddressInfo } from "node:net";
import app, { markApplicationReady } from "../src/app";
import { pool } from "@workspace/db";
import { syncClientSubscriptionQuantity } from "../src/lib/billing";
import { invalidateAiPlan } from "../src/lib/aiAllowance";
import { calls, definePrice, getSubscription, setInvoiceOutcome, setSubscription } from "./ai-addon-stripe.stub";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1") {
  throw new Error("This entry point is only for the isolated AI add-on suite");
}

export async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  markApplicationReady();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { void pool.end().then(() => resolve()); });
    }),
  };
}

export { pool, syncClientSubscriptionQuantity, invalidateAiPlan, calls, definePrice, getSubscription, setInvoiceOutcome, setSubscription };
