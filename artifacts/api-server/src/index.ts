import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./lib/stripeClient";
import cron from "node-cron";
import { runReminderJob } from "./routes/notifications";
import { runRuntimeMigrations } from "./lib/runtimeMigrations";
import { reconcileAllSubscriptionQuantities, type QuantityCorrection } from "./lib/billing";
import { sendSystemEmail } from "./lib/email";
import { runTrialReminderJob } from "./lib/trialReminders";
import { runCheckReminderEmailJob } from "./lib/checkReminderEmails";

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

  // Remind clients whose free trial is about to end (daily at 08:15)
  cron.schedule("15 8 * * *", runTrialReminders);
  logger.info("Trial reminder scheduler started (daily at 08:15)");

  // Email safety check reminders for overdue/due-soon checks (daily at 08:45)
  cron.schedule("45 8 * * *", async () => {
    logger.info("Running daily check reminder email job...");
    try {
      const result = await runCheckReminderEmailJob();
      logger.info({ result }, "Check reminder email job complete");
    } catch (err) {
      logger.error({ err }, "Check reminder email job failed");
    }
  });
  logger.info("Check reminder scheduler started (daily at 08:45)");
}

async function runTrialReminders() {
  logger.info("Running trial ending reminder job...");
  try {
    const result = await runTrialReminderJob();
    logger.info({ result }, "Trial ending reminder job complete");
  } catch (err) {
    logger.error({ err }, "Trial ending reminder job failed");
  }
}

async function runBillingReconciliation() {
  logger.info("Running billing reconciliation...");
  try {
    const result = await reconcileAllSubscriptionQuantities();
    if (result.corrections.length > 0) {
      logger.warn(
        {
          clientsChecked: result.clients,
          driftCount: result.corrections.length,
          corrections: result.corrections,
        },
        "Billing reconciliation corrected drift — investigate upstream cause (missed webhook or failed sync)",
      );
      await notifyAdminOfBillingDrift(result.corrections);
    } else {
      logger.info(
        { clientsChecked: result.clients, driftCount: 0 },
        "Billing reconciliation complete — no drift detected",
      );
    }
  } catch (err) {
    logger.error({ err }, "Billing reconciliation failed");
  }
}

/**
 * Best-effort admin email when the reconciliation job had to correct drift.
 * Requires ADMIN_EMAIL (and Resend) to be configured; otherwise just logs.
 */
async function notifyAdminOfBillingDrift(corrections: QuantityCorrection[]) {
  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) {
    logger.info(
      "ADMIN_EMAIL not configured — skipping billing drift notification email",
    );
    return;
  }
  const rowsHtml = corrections
    .map(
      (c) =>
        `<tr><td style="padding:6px 12px;border:1px solid #e2e8f0;">${c.clientName ?? "(unknown)"} (id ${c.clientId})</td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${c.subscriptionId}</td><td style="padding:6px 12px;border:1px solid #e2e8f0;text-align:center;">${c.fromQuantity}</td><td style="padding:6px 12px;border:1px solid #e2e8f0;text-align:center;">${c.toQuantity}</td></tr>`,
    )
    .join("");
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
      <h2 style="color:#1e293b;">Billing drift detected and corrected</h2>
      <p>The daily billing reconciliation found ${corrections.length} client subscription${corrections.length === 1 ? "" : "s"} whose Stripe quantity did not match the real site count. The quantities have been corrected automatically, but drift usually means something upstream broke (missed webhook or failed sync) and is worth investigating.</p>
      <table style="border-collapse:collapse;margin:16px 0;">
        <tr>
          <th style="padding:6px 12px;border:1px solid #e2e8f0;background:#f1f5f9;text-align:left;">Client</th>
          <th style="padding:6px 12px;border:1px solid #e2e8f0;background:#f1f5f9;text-align:left;">Subscription</th>
          <th style="padding:6px 12px;border:1px solid #e2e8f0;background:#f1f5f9;">Was billing</th>
          <th style="padding:6px 12px;border:1px solid #e2e8f0;background:#f1f5f9;">Corrected to</th>
        </tr>
        ${rowsHtml}
      </table>
    </div>`;
  const text = [
    `Billing drift detected and corrected (${corrections.length} client${corrections.length === 1 ? "" : "s"}):`,
    ...corrections.map(
      (c) =>
        `- ${c.clientName ?? "(unknown)"} (id ${c.clientId}), subscription ${c.subscriptionId}: quantity ${c.fromQuantity} -> ${c.toQuantity}`,
    ),
    "",
    "Drift usually means something upstream broke (missed webhook or failed sync) and is worth investigating.",
  ].join("\n");
  try {
    await sendSystemEmail({
      to: adminEmail,
      subject: `Billing drift corrected for ${corrections.length} client${corrections.length === 1 ? "" : "s"}`,
      html,
      text,
    });
    logger.info({ adminEmail }, "Billing drift notification email sent");
  } catch (err) {
    logger.error({ err }, "Failed to send billing drift notification email");
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
  // Catch up trial reminders on startup too, so a server that was down at
  // 08:15 doesn't miss the 3-day warning window (deduped per client).
  setTimeout(runTrialReminders, 20_000);
});
