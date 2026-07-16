import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./lib/stripeClient";
import cron from "node-cron";
import { runReminderJob } from "./routes/notifications";
import { runRuntimeMigrations } from "./lib/runtimeMigrations";
import { reconcileAllSubscriptionQuantities } from "./lib/billing";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — Stripe sync skipped");
    return;
  }
  try {
    logger.info("Initializing Stripe schema...");
    await runMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const stripeSync = await getStripeSync();
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
    logger.info("Stripe webhook configured");

    stripeSync.syncBackfill()
      .then(() => logger.info("Stripe data synced"))
      .catch((err: any) => logger.error({ err }, "Stripe backfill error"));
  } catch (err) {
    logger.error({ err }, "Failed to initialize Stripe — continuing without it");
  }
}

function startScheduler() {
  // Run reminder job every day at 8am
  cron.schedule("0 8 * * *", async () => {
    logger.info("Running scheduled contractor reminder job...");
    try {
      const result = await runReminderJob();
      logger.info({ result }, "Scheduled reminder job complete");
    } catch (err) {
      logger.error({ err }, "Scheduled reminder job failed");
    }
  });
  logger.info("Contractor reminder scheduler started (daily at 08:00)");

  // Reconcile Stripe subscription quantities daily so any billing drift from
  // missed webhooks or transient Stripe failures self-heals.
  cron.schedule("30 8 * * *", runBillingReconciliation);
  logger.info("Billing reconciliation scheduler started (daily at 08:30)");
}

async function runBillingReconciliation() {
  logger.info("Running billing reconciliation...");
  try {
    const result = await reconcileAllSubscriptionQuantities();
    logger.info({ result }, "Billing reconciliation complete");
  } catch (err) {
    logger.error({ err }, "Billing reconciliation failed");
  }
}

app.listen(port, async (err?: any) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  await runRuntimeMigrations();
  await initStripe();
  startScheduler();
  // Also reconcile once shortly after startup so drift never waits a full day
  // (best-effort; exits quietly per client when Stripe isn't reachable).
  setTimeout(runBillingReconciliation, 15_000);
});
