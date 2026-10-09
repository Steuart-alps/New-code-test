import app, { markApplicationReady } from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import { getStripeCredentialSource, getStripeSync } from "./lib/stripeClient";
import cron from "node-cron";
import { runReminderJob } from "./routes/notifications";
import { runRuntimeMigrations } from "./lib/runtimeMigrations";
import { reconcileAllSubscriptionQuantities, type QuantityCorrection } from "./lib/billing";
import {
  getBillingReadiness,
  isStripeCatalogueVerified,
  positiveMsFromEnv,
  startStripeInitialization,
  type StripeAttemptResult,
} from "./lib/stripeStartup";
import {
  ensureServicePrices,
  getServicePricePreflight,
  getServicePriceReadinessBlocker,
  type ServicePricePreflight,
} from "./lib/services";
import { getPublicAppUrl, sendSystemEmail } from "./lib/email";
import { runTrialReminderJob } from "./lib/trialReminders";
import { runCheckReminderEmailJob } from "./lib/checkReminderEmails";
import { runDocAckReminderJob } from "./lib/docAckReminders";
import { runBikeOverdueJob } from "./lib/bikeOverdueReminders";
import { runTwoFactorResetAlertRecovery } from "./lib/twoFactorResetAlerts";
import { runFixTrackOverdueAlertJob } from "./lib/fixTrackOverdueAlerts";
import { runContractorComplianceReminderJob } from "./lib/contractorComplianceReminders";
import { runTrainingExpiryReminderJob } from "./lib/trainingExpiryReminders";
import { runCancellationDetectionJob, runCancellationWarningJob, runDataDeletionJob } from "./lib/offboarding";
import { runMonthlyComplianceSummaryJob } from "./lib/monthlyComplianceSummary";
import { runContractorInsuranceExpiryReminderJob } from "./lib/contractorInsuranceExpiryReminders";
import { runTrackActionReminderJob } from "./lib/trackActionReminders";
import { registerSafeTrackAckReminderSchedule } from "./lib/safeTrackAckReminderSchedule";
import { runScheduledServicePriceAudit, SERVICE_PRICE_AUDIT_CRON } from "./lib/servicePriceAudit";
import { cleanupStagedPhotoUploads } from "./lib/stagedPhotoCleanup";
import { purgeExpiredAnalyticsEvents } from "./lib/analytics";
import { ObjectStorageService } from "./lib/objectStorage";

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

/**
 * One Stripe initialization attempt. Supervised by startStripeInitialization,
 * which bounds it with a deadline and retries failures; `onStage` names each
 * step so a stall can be attributed (see lib/stripeStartup.ts). Errors
 * propagate to the supervisor, which reports them as a readiness blocker.
 */
async function initStripe(onStage: (stage: string) => void): Promise<StripeAttemptResult> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — Stripe sync skipped");
    return { blocker: "Stripe service-price catalogue could not be read", catalogueVerified: false };
  }
  onStage("sync schema migrations");
  await runMigrations({ databaseUrl });
  logger.info("Stripe schema ready");

  const stripeSync = await getStripeSync(onStage);
  // Keep the existing Replit webhook address when deployed there: a new URL
  // registers a second Stripe webhook rather than replacing the first.
  const replitDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const webhookBaseUrl = replitDomain ? `https://${replitDomain}` : getPublicAppUrl();
  onStage("managed webhook");
  await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
  logger.info("Stripe webhook configured");

  onStage("backfill sync");
  await stripeSync.syncBackfill();
  logger.info("Stripe data synced");
  onStage("service-price catalogue");

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
        { missing: preflight.missing, duplicates: preflight.duplicates, issues: preflight.issues, configured: preflight.configured },
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
        { missing: finalPreflight.missing, duplicates: finalPreflight.duplicates, issues: finalPreflight.issues, configured: finalPreflight.configured },
        "Stripe service-price preflight failed — affected modules cannot be activated",
      );
    }
  } catch (err) {
    catalogueReadFailed = true;
    logger.error({ err }, "Stripe service-price preflight could not read synced catalogue");
  }
  return {
    blocker: getServicePriceReadinessBlocker({
      catalogueReadFailed,
      repairFailed,
      finalPreflight,
    }),
    // Only a completed read and repair is a verdict an administrator must
    // act on; read/repair failures may be transient and are retried.
    catalogueVerified: !catalogueReadFailed && !repairFailed && finalPreflight !== null,
  };
}

let stagedPhotoCleanupRunning = false;
async function runStagedPhotoCleanup() {
  if (stagedPhotoCleanupRunning) return;
  const storage = new ObjectStorageService();
  try {
    storage.getPrivateObjectDir();
  } catch {
    // Without configured private storage nothing can be deleted; leave the
    // receipts for a correctly configured instance rather than backing off.
    return;
  }
  stagedPhotoCleanupRunning = true;
  try {
    // Bounded per run; a backlog drains over successive runs.
    const result = await cleanupStagedPhotoUploads(storage, {
      limit: 200,
      onError: (err) => logger.warn({ err }, "Staged photo cleanup item failed; will retry with backoff"),
    });
    if (result.examined > 0) logger.info({ result }, "Staged photo cleanup complete");
  } catch (err) {
    logger.error({ err }, "Staged photo cleanup failed");
  } finally {
    stagedPhotoCleanupRunning = false;
  }
}

let analyticsPurgeRunning = false;
async function runAnalyticsRetentionPurge() {
  if (analyticsPurgeRunning) return;
  analyticsPurgeRunning = true;
  try {
    const deleted = await purgeExpiredAnalyticsEvents();
    if (deleted > 0) logger.info({ deleted }, "Analytics retention purge complete");
  } catch (err) {
    logger.error({ err }, "Analytics retention purge failed");
  } finally {
    analyticsPurgeRunning = false;
  }
}

let twoFactorResetAlertRecoveryRunning = false;
async function runTwoFactorResetAlertRecoveryOnce() {
  if (twoFactorResetAlertRecoveryRunning) return;
  twoFactorResetAlertRecoveryRunning = true;
  try {
    const result = await runTwoFactorResetAlertRecovery();
    if (result.examined > 0) logger.info({ result }, "Two-factor reset alert recovery complete");
  } catch (err) {
    logger.error({ err }, "Two-factor reset alert recovery failed");
  } finally {
    twoFactorResetAlertRecoveryRunning = false;
  }
}

function startScheduler() {
  // Deliver queued two-factor reset security alerts that a provider outage or
  // restart left undelivered: at boot, then every minute (due rows only).
  void runTwoFactorResetAlertRecoveryOnce();
  cron.schedule("* * * * *", runTwoFactorResetAlertRecoveryOnce);
  logger.info("Two-factor reset alert recovery scheduler started (every minute)");

  // Remove cancelled or expired unclaimed staged photos (and their objects)
  // at boot and every 10 minutes. Restart-safe: unfinished items are retried.
  void runStagedPhotoCleanup();
  cron.schedule("*/10 * * * *", runStagedPhotoCleanup);
  logger.info("Staged photo cleanup scheduler started (every 10 minutes)");

  // Delete first-party analytics events older than 13 months: at boot, then
  // daily at 03:20. Bounded batches; a backlog drains over successive runs.
  void runAnalyticsRetentionPurge();
  cron.schedule("20 3 * * *", runAnalyticsRetentionPurge);
  logger.info("Analytics retention purge scheduler started (daily at 03:20)");

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

  // Alert managers about contractor insurance, DBS/PVG and certificates.
  // Run at 08:55 London time so 60/30-day date boundaries stay predictable.
  cron.schedule("55 8 * * *", async () => {
    logger.info("Running contractor compliance reminder job...");
    try {
      const result = await runContractorComplianceReminderJob();
      logger.info({ result }, "Contractor compliance reminder job complete");
    } catch (err) {
      logger.error({ err }, "Contractor compliance reminder job failed");
    }
  }, { timezone: "Europe/London" });
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

  // Replay unconfirmed overdue-bike digests with their persisted provider
  // idempotency key while the provider still deduplicates it. Recovery never
  // creates a new digest; new alerts still come only from the daily scan.
  cron.schedule("*/5 * * * *", async () => {
    try {
      const result = await runBikeOverdueJob({}, { recoverOnly: true });
      if (result.clientsEmailed > 0 || result.errors > 0) logger.info({ result }, "Bike overdue recovery complete");
    } catch (err) {
      logger.error({ err }, "Bike overdue recovery failed");
    }
  });

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

  // Check daily at 08:00 UK local time; the job creates new monthly mail
  // only on the 1st and resumes unfinished deliveries on subsequent days.
  cron.schedule("0 8 * * *", async () => {
    logger.info("Running monthly compliance summary job...");
    try {
      const result = await runMonthlyComplianceSummaryJob();
      logger.info({ result }, "Monthly compliance summary job complete");
    } catch (err) {
      logger.error({ err }, "Monthly compliance summary job failed");
    }
  }, { timezone: "Europe/London" });
  logger.info("Monthly compliance summary scheduler started (daily at 08:00 Europe/London)");

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

  // Check tenant-specific SafeTrack acknowledgement reminder settings every
  // five minutes. Each account chooses daily or weekly cadence and local time.
  registerSafeTrackAckReminderSchedule(cron.schedule);
  logger.info("SafeTrack acknowledgement reminder scheduler started (every five minutes)");

  // Read-only audit of the synced Stripe price catalogue, so a price or
  // product archived after startup is reported before a client's add-on
  // activation fails. Alerts once per incident and reports recovery; it never
  // changes prices, products, subscriptions or charges.
  cron.schedule(SERVICE_PRICE_AUDIT_CRON, () => runScheduledServicePriceAudit());
  logger.info("Stripe service-price audit scheduler started (hourly at :25)");
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
  // Never correct subscriptions against a catalogue this process has not read.
  if (!isStripeCatalogueVerified()) {
    logger.warn({ billingState: getBillingReadiness().phase }, "Billing reconciliation skipped — Stripe catalogue not verified");
    return;
  }
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
    logger.error(
      "ADMIN_EMAIL not configured — billing drift notification email was not sent",
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
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_EMAIL?.trim()) {
    logger.warn("ADMIN_EMAIL not configured — internal billing and data-deletion notices cannot be delivered");
  }
  await runRuntimeMigrations();
  // Stripe start-up is bounded: /readyz reports "starting" until the first
  // attempt settles or STRIPE_INIT_TIMEOUT_MS passes, then "ok" or "degraded"
  // with a blocker. Failures retry in the background; billing activation stays
  // blocked until the catalogue is verified (see lib/stripeStartup.ts).
  const stripeStartup = startStripeInitialization({
    credentialSource: getStripeCredentialSource,
    runAttempt: initStripe,
    required: process.env.NODE_ENV === "production",
    timeoutMs: positiveMsFromEnv(process.env.STRIPE_INIT_TIMEOUT_MS, 120_000),
    retryDelaysMs: [30_000, 60_000, 120_000, 300_000, 900_000],
    logger,
    // Reconcile once shortly after the catalogue is verified so drift never
    // waits a full day (best-effort; exits quietly per client when Stripe fails).
    onCatalogueVerified: () => { setTimeout(runBillingReconciliation, 15_000); },
  });
  markApplicationReady();
  // Keep the previous ordering (jobs start after Stripe start-up) without
  // letting a stalled Stripe dependency postpone them indefinitely.
  await stripeStartup.firstSettledOrDeadline;
  startScheduler();
  // Catch up trial reminders on startup too, so a server that was down at
  // 08:15 doesn't miss the 3-day warning window (deduped per client).
  setTimeout(runTrialReminders, 20_000);
  // First catalogue audit after the startup preflight; deduped across restarts.
  setTimeout(() => runScheduledServicePriceAudit(), 30_000);
  setTimeout(() => {
    void runFixTrackOverdueAlertJob(undefined, { recoverOnly: true }).catch((err) => {
      logger.error({ err }, "FixTrack startup alert recovery failed");
    });
  }, 25_000);
});
