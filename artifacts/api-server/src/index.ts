// Sentry must be initialised before anything else so all auto-instrumentation
// (Express, http, DB calls) is active from the very first request.
import { initSentry } from "./lib/sentry";
initSentry();

import app, { markApplicationReady } from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./lib/stripeClient";
import cron from "node-cron";
import { runReminderJob } from "./routes/notifications";
import { runRuntimeMigrations } from "./lib/runtimeMigrations";
import { reconcileAllSubscriptionQuantities, type QuantityCorrection } from "./lib/billing";
import {
  ensureServicePrices,
  getServicePricePreflight,
  getServicePriceReadinessBlocker,
  type ServicePricePreflight,
} from "./lib/services";
import { sendSystemEmail } from "./lib/email";
import { runTrialReminderJob } from "./lib/trialReminders";
import { runCheckReminderEmailJob } from "./lib/checkReminderEmails";
import { runDocAckReminderJob } from "./lib/docAckReminders";
import { runBikeOverdueJob } from "./lib/bikeOverdueReminders";
import { runFixTrackOverdueAlertJob } from "./lib/fixTrackOverdueAlerts";
import { runContractorComplianceReminderJob } from "./lib/contractorComplianceReminders";
import { runTrainingExpiryReminderJob } from "./lib/trainingExpiryReminders";
import { runCancellationDetectionJob, runCancellationWarningJob, runDataDeletionJob } from "./lib/offboarding";
import { runMonthlyComplianceSummaryJob } from "./lib/monthlyComplianceSummary";
import { runContractorInsuranceExpiryReminderJob } from "./lib/contractorInsuranceExpiryReminders";
import { runTrackActionReminderJob } from "./lib/trackActionReminders";
import { registerSafeTrackAckReminderSchedule } from "./lib/safeTrackAckReminderSchedule";

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

async function initStripe(): Promise<string | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — Stripe sync skipped");
    return "Stripe service-price catalogue could not be read";
  }
  try {
    logger.info("Initializing Stripe schema...");
    await runMigrations({ databaseUrl });
    logger.info("Stripe schema ready");

    const stripeSync = await getStripeSync();
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
    logger.info("Stripe webhook configured");

    await stripeSync.syncBackfill();
    logger.info("Stripe data synced");

    // Read-only launch preflight: report every gap from the synced catalogue
    // before attempting the idempotent repair below. This cannot grant access
    // or alter any subscription.
    let catalogueReadFailed = false;
    try {
      const preflight = await getServicePricePreflight();
      if (preflight.ready) {
        logger.info({ configured: preflight.configured }, "Stripe service-price preflight passed");
      } else {
        logger.error(
          { missing: preflight.missing, configured: preflight.configured },
          "Stripe service-price preflight failed — affected modules cannot be activated",
        );
      }
    } catch (err) {
      catalogueReadFailed = true;
      logger.error({ err }, "Stripe service-price preflight could not read synced catalogue");
    }

    // Ensure every module in the service catalogue has a Stripe product + price.
    // Idempotent — only creates what's missing, after the sync has made existing
    // prices visible to the catalogue read.
    let repairFailed = false;
    try {
      const prices = await ensureServicePrices();
      if (prices.created.length > 0) {
        logger.info({ created: prices.created }, "Created missing Stripe service prices");
      } else {
        logger.info("All Stripe service prices already exist");
      }
    } catch (err) {
      repairFailed = true;
      logger.error({ err }, "ensureServicePrices failed — run POST /api/admin/ensure-service-prices manually");
    }

    // Confirm the repair result before the application becomes ready. This is
    // read-only and cannot grant a client an entitlement.
    let finalPreflight: ServicePricePreflight | null = null;
    try {
      finalPreflight = await getServicePricePreflight();
      if (finalPreflight.ready) {
        logger.info({ configured: finalPreflight.configured }, "Stripe service-price preflight passed");
      } else {
        logger.error(
          { missing: finalPreflight.missing, configured: finalPreflight.configured },
          "Stripe service-price preflight failed — affected modules cannot be activated",
        );
      }
    } catch (err) {
      catalogueReadFailed = true;
      logger.error({ err }, "Stripe service-price preflight could not read synced catalogue");
    }
    return getServicePriceReadinessBlocker({
      catalogueReadFailed,
      repairFailed,
      finalPreflight,
    });
  } catch (err) {
    logger.error({ err }, "Failed to initialize Stripe — continuing without it");
    return "Stripe service-price catalogue initialization failed";
  }
}

function startScheduler() {
  cron.schedule("35 8 * * *", async () => {
    logger.info("Running operational action reminder job...");
    try {
      const result = await runTrackActionReminderJob();
      logger.info({ result }, "Operational action reminder job complete");
    } catch (err) {
      logger.error({ err }, "Operational action reminder job failed");
    }
  });
  logger.info("Operational action reminder scheduler started (daily at 08:35)");

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

  // Alert managers when contractor insurance is expiring/expired or a DBS
  // check is out of date (daily at 08:55; each contractor+milestone once).
  cron.schedule("55 8 * * *", async () => {
    logger.info("Running contractor compliance reminder job...");
    try {
      const result = await runContractorComplianceReminderJob();
      logger.info({ result }, "Contractor compliance reminder job complete");
    } catch (err) {
      logger.error({ err }, "Contractor compliance reminder job failed");
    }
  });
  logger.info("Contractor compliance reminder scheduler started (daily at 08:55)");

  // Alert managers when staff training certificates are expiring within 30 days
  // or have already expired (daily at 09:00; deduped per record milestone).
  cron.schedule("0 9 * * *", async () => {
    logger.info("Running training expiry reminder job...");
    try {
      const result = await runTrainingExpiryReminderJob();
      logger.info({ result }, "Training expiry reminder job complete");
    } catch (err) {
      logger.error({ err }, "Training expiry reminder job failed");
    }
  });
  logger.info("Training expiry reminder scheduler started (daily at 09:00)");

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

  // Remind managers about outstanding document acknowledgements (daily at
  // 08:50; each client gets at most one email per 7 days).
  cron.schedule("50 8 * * *", async () => {
    logger.info("Running doc acknowledgement reminder job...");
    try {
      const result = await runDocAckReminderJob();
      logger.info({ result }, "Doc acknowledgement reminder job complete");
    } catch (err) {
      logger.error({ err }, "Doc acknowledgement reminder job failed");
    }
  });
  logger.info("Doc acknowledgement reminder scheduler started (daily at 08:50)");

  // Email managers a digest of overdue/stale urgent FixTrack issues
  // (daily at 08:40; each client gets at most one email per day).
  cron.schedule("40 8 * * *", async () => {
    logger.info("Running FixTrack overdue alert job...");
    try {
      const result = await runFixTrackOverdueAlertJob();
      logger.info({ result }, "FixTrack overdue alert job complete");
    } catch (err) {
      logger.error({ err }, "FixTrack overdue alert job failed");
    }
  });
  logger.info("FixTrack overdue alert scheduler started (daily at 08:40)");

  // Recovery-only reconciliation resumes persisted pending/sending snapshots
  // with their original provider idempotency key. It never creates a new
  // digest, so manager alerts still originate only from the daily schedule.
  cron.schedule("*/5 * * * *", async () => {
    try {
      const result = await runFixTrackOverdueAlertJob(undefined, { recoverOnly: true });
      if (result.clientsEmailed > 0) logger.info({ result }, "FixTrack alert recovery complete");
    } catch (err) {
      logger.error({ err }, "FixTrack alert recovery failed");
    }
  });
  logger.info("FixTrack alert recovery scheduler started (every 5 minutes)");

  // Notify tenant managers about overdue bike hires (daily scan; initial alert
  // then a safely claimed weekly repeat while the hire remains active).
  cron.schedule("20 8 * * *", async () => {
    try {
      const result = await runBikeOverdueJob();
      if (result.hiresFound > 0) logger.info({ result }, "Bike overdue job complete");
    } catch (err) {
      logger.error({ err }, "Bike overdue job failed");
    }
  });
  logger.info("Bike overdue repeat-notification scheduler started (daily at 08:20)");

  // Detect newly cancelled subscriptions and start the 12-month retention clock
  // (daily at 07:00; sends one offboarding email per client).
  cron.schedule("0 7 * * *", async () => {
    logger.info("Running cancellation detection job...");
    try {
      const result = await runCancellationDetectionJob();
      logger.info({ result }, "Cancellation detection job complete");
    } catch (err) {
      logger.error({ err }, "Cancellation detection job failed");
    }
  });
  logger.info("Cancellation detection scheduler started (daily at 07:00)");

  // Reconcile any cancellation/scheduled-cancellation webhook missed by Stripe
  // sync and warn account admins before their paid access cutoff.
  cron.schedule("50 6 * * *", async () => {
    try {
      const result = await runCancellationWarningJob();
      logger.info({ result }, "Cancellation warning reconciliation complete");
    } catch (err) {
      logger.error({ err }, "Cancellation warning reconciliation failed");
    }
  });
  logger.info("Cancellation warning scheduler started (daily at 06:50)");

  // Hard-delete compliance data for clients whose 12-month window has passed
  // (daily at 03:00; irreversible — runs only after data_deletion_scheduled_at).
  cron.schedule("0 3 * * *", async () => {
    logger.info("Running data deletion job...");
    try {
      const result = await runDataDeletionJob();
      if (result.clientsDeleted > 0) logger.info({ result }, "Data deletion job complete");
    } catch (err) {
      logger.error({ err }, "Data deletion job failed");
    }
  });
  logger.info("Data deletion scheduler started (daily at 03:00)");

  // Email all client admins a monthly compliance summary on the 1st of each
  // month at 08:05 — covers the previous calendar month.
  cron.schedule("5 8 1 * *", async () => {
    logger.info("Running monthly compliance summary job...");
    try {
      const result = await runMonthlyComplianceSummaryJob();
      logger.info({ result }, "Monthly compliance summary job complete");
    } catch (err) {
      logger.error({ err }, "Monthly compliance summary job failed");
    }
  });
  logger.info("Monthly compliance summary scheduler started (1st of month at 08:05)");

  // Alert client admins weekly (Monday 09:00) when contractor public liability
  // insurance is expiring within 30 days or has already expired.
  cron.schedule("0 9 * * 1", async () => {
    logger.info("Running contractor insurance expiry reminder job...");
    try {
      const result = await runContractorInsuranceExpiryReminderJob();
      logger.info({ result }, "Contractor insurance expiry reminder job complete");
    } catch (err) {
      logger.error({ err }, "Contractor insurance expiry reminder job failed");
    }
  });
  logger.info("Contractor insurance expiry reminder scheduler started (weekly Monday at 09:00)");

  // Alert client admins weekly (Monday 09:30) when staff haven't acknowledged
  // required SafeTrack documents (risk assessments, SOPs, handbook entries)
  // within 7 days of publication.
  registerSafeTrackAckReminderSchedule(cron.schedule);
  logger.info("SafeTrack acknowledgement reminder scheduler started (weekly Monday at 09:30)");
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

// ── Global error handlers ──────────────────────────────────────────────────
// These are a last-resort safety net for errors that escape every try/catch
// (e.g. bugs in async cron jobs that aren't individually guarded).
// Sentry.init() has already been called above so these will also be captured
// there if SENTRY_DSN is configured.

process.on("unhandledRejection", async (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  logger.error({ reason }, `Unhandled promise rejection: ${message}`);

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (!adminEmail) return;
  try {
    await sendSystemEmail({
      to: adminEmail,
      subject: `[ComplyTrack] Unhandled rejection on ${new Date().toISOString()}`,
      html: `<p><strong>Unhandled promise rejection</strong></p><pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:12px;overflow:auto;">${message}\n\n${stack}</pre>`,
      text: `Unhandled promise rejection\n\n${message}\n\n${stack}`,
    });
  } catch {
    // best-effort — don't throw from inside an error handler
  }
});

process.on("uncaughtException", async (err: Error) => {
  logger.fatal({ err }, `Uncaught exception: ${err.message}`);

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (adminEmail) {
    try {
      await sendSystemEmail({
        to: adminEmail,
        subject: `[ComplyTrack] FATAL uncaught exception on ${new Date().toISOString()}`,
        html: `<p><strong>Uncaught exception — process may restart</strong></p><pre style="background:#fee2e2;padding:12px;border-radius:6px;font-size:12px;overflow:auto;">${err.message}\n\n${err.stack ?? ""}</pre>`,
        text: `Uncaught exception — process may restart\n\n${err.message}\n\n${err.stack ?? ""}`,
      });
    } catch {
      // best-effort
    }
  }
  // Give the event loop a tick so pino can flush, then exit so the process
  // manager (or Replit) can restart the server cleanly.
  setTimeout(() => process.exit(1), 500);
});

app.listen(port, async (err?: any) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  await runRuntimeMigrations();
  const readinessBlocker = await initStripe();
  markApplicationReady(readinessBlocker);
  startScheduler();
  // Also reconcile once shortly after startup so drift never waits a full day
  // (best-effort; exits quietly per client when Stripe isn't reachable).
  setTimeout(runBillingReconciliation, 15_000);
  // Catch up trial reminders on startup too, so a server that was down at
  // 08:15 doesn't miss the 3-day warning window (deduped per client).
  setTimeout(runTrialReminders, 20_000);
  setTimeout(() => {
    void runFixTrackOverdueAlertJob(undefined, { recoverOnly: true }).catch((err) => {
      logger.error({ err }, "FixTrack startup alert recovery failed");
    });
  }, 25_000);
});
