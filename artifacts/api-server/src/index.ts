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
  type StripeStartupHandle,
} from "./lib/stripeStartup";
import { pool } from "@workspace/db";
import { getContractorTokenProblem } from "./lib/runtimeMigrations";
import {
  captureJobFailure,
  getJobLastSuccess,
  loadJobRunHistory,
  registerDailyJob,
  runMonitoredJob,
  stopAcceptingJobs,
  waitForInFlightJobs,
} from "./lib/jobMonitor";
import { setReadinessNote } from "./lib/readinessDetails";
import { Sentry, isErrorReportingEnabled } from "./lib/sentry";
import {
  ensureServicePrices,
  ensureStoragePrice,
  getServicePricePreflight,
  getServicePriceReadinessBlocker,
  type ServicePricePreflight,
} from "./lib/services";
import { describeEmailConfigurationIssues, escapeHtml, getPublicAppUrl, sendSystemEmail } from "./lib/email";
import { runTrialEndedEmailJob, runTrialReminderJob } from "./lib/trialReminders";
import { runStorageWarningEmailJob } from "./lib/storageWarningEmails";
import { runCheckReminderEmailJob } from "./lib/checkReminderEmails";
import { runDocAckReminderJob } from "./lib/docAckReminders";
import { runBikeOverdueJob } from "./lib/bikeOverdueReminders";
import { runTwoFactorResetAlertRecovery } from "./lib/twoFactorResetAlerts";
import { runFixTrackOverdueAlertJob } from "./lib/fixTrackOverdueAlerts";
import { runContractorComplianceReminderJob } from "./lib/contractorComplianceReminders";
import { runCertificateFollowUpJob } from "./lib/certificateFollowUp";
import { runTrainingExpiryReminderJob } from "./lib/trainingExpiryReminders";
import { runCancellationDetectionJob, runCancellationWarningJob, runDataDeletionJob, runDeletionReminderJob } from "./lib/offboarding";
import { eraseClientStorageObjects } from "./lib/clientStorageErasure";
import { runCancelledStorageClassJob } from "./lib/cancelledClientStorage";
import { runMonthlyComplianceSummaryJob } from "./lib/monthlyComplianceSummary";
import { runContractorInsuranceExpiryReminderJob } from "./lib/contractorInsuranceExpiryReminders";
import { runTrackActionReminderJob } from "./lib/trackActionReminders";
import { runTrackReminderJob } from "./lib/trackReminders";
import { registerSafeTrackAckReminderSchedule } from "./lib/safeTrackAckReminderSchedule";
import { runScheduledServicePriceAudit, SERVICE_PRICE_AUDIT_CRON } from "./lib/servicePriceAudit";
import { runStripeTaxCheck, STRIPE_TAX_CHECK_CRON } from "./lib/stripeTaxCheck";
import { runScheduledStoragePriceAudit, STORAGE_PRICE_AUDIT_CRON } from "./lib/storagePriceAudit";
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
  // The managed webhook is keyed by URL: after PUBLIC_APP_URL changes, the sync
  // library deletes the webhook it registered for the old URL and creates one
  // for the new URL (it also deletes stripe-sync webhooks this database does
  // not know, e.g. one left by an older deployment on the same Stripe account).
  const webhookBaseUrl = getPublicAppUrl();
  onStage("managed webhook");
  await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
  logger.info("Stripe webhook configured");

  onStage("backfill sync");
  // The sync library's default (no arguments) copies nothing, so name the
  // scope: products and prices feed the service-price catalogue check below,
  // customers and subscriptions feed billing state.
  await stripeSync.syncBackfill({ object: "all" });
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

  // The extra-storage price (£1 per 10 GB) is made the same way. A failure
  // only hides "Buy storage"; it never blocks start-up.
  try {
    if (await ensureStoragePrice()) logger.info("Created the Stripe extra-storage price");
  } catch (err) {
    logger.error({ err }, "ensureStoragePrice failed — extra storage stays unavailable until the next start");
  }

  // Report Stripe Tax settings that would stop VAT being charged correctly.
  // Read-only and informational, so it runs alongside start-up rather than
  // holding up readiness.
  void runStripeTaxCheck().catch((err) => logger.warn({ err }, "Stripe Tax settings could not be checked"));

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
  } finally {
    twoFactorResetAlertRecoveryRunning = false;
  }
}

// Every schedule runs on UK local time, so "08:00" means 08:00 in London all
// year round (BST and GMT) and date boundaries match what customers see.
const SCHEDULE_TIMEZONE = "Europe/London";
const scheduledTasks: Array<{ stop: () => unknown }> = [];

/**
 * Register a cron job. Each run goes through runMonitoredJob: failures are
 * logged and sent to Sentry, successes recorded in scheduled_job_runs, and
 * in-flight runs are awaited on shutdown. `daily` jobs appear in /readyz
 * details when they have not succeeded for 26 hours.
 */
function schedule(expression: string, job: string, run: () => Promise<unknown>, options: { daily?: boolean } = {}) {
  if (options.daily) registerDailyJob(job);
  scheduledTasks.push(
    cron.schedule(expression, () => { void runMonitoredJob(job, run); }, { timezone: SCHEDULE_TIMEZONE }),
  );
}

/** Run a job and log its result under `message` (failures are handled by runMonitoredJob). */
function logged<T>(message: string, run: () => Promise<T>, quiet?: (result: T) => boolean) {
  return async () => {
    const result = await run();
    if (!quiet?.(result)) logger.info({ result }, message);
    return result;
  };
}

const CONTRACTOR_INSURANCE_JOB = "contractor-insurance-expiry-weekly";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The weekly insurance digest runs on Mondays only. If the process was down at
 * that moment, run it once at start-up: its per-client weekly delivery claims
 * stop a second digest in the same week.
 */
async function catchUpWeeklyInsuranceDigest() {
  let last: Date | null;
  try {
    last = await getJobLastSuccess(CONTRACTOR_INSURANCE_JOB);
  } catch (err) {
    logger.warn({ err }, "Could not read contractor insurance digest history; skipping catch-up");
    return;
  }
  // Never run on this database: wait for the regular Monday schedule.
  if (!last || Date.now() - last.getTime() <= WEEK_MS) return;
  logger.info({ lastSuccess: last.toISOString() }, "Weekly contractor insurance digest was missed — catching up");
  await runMonitoredJob(CONTRACTOR_INSURANCE_JOB, logged(
    "Contractor insurance expiry reminder job complete",
    runContractorInsuranceExpiryReminderJob,
  ));
}

function startScheduler() {
  // Deliver queued two-factor reset security alerts that a provider outage or
  // restart left undelivered: at boot, then every minute (due rows only).
  void runMonitoredJob("two-factor-reset-alert-recovery", runTwoFactorResetAlertRecoveryOnce);
  schedule("* * * * *", "two-factor-reset-alert-recovery", runTwoFactorResetAlertRecoveryOnce);
  logger.info("Two-factor reset alert recovery scheduler started (every minute)");

  // Remove cancelled or expired unclaimed staged photos (and their objects)
  // at boot and every 10 minutes. Restart-safe: unfinished items are retried.
  void runMonitoredJob("staged-photo-cleanup", runStagedPhotoCleanup);
  schedule("*/10 * * * *", "staged-photo-cleanup", runStagedPhotoCleanup);
  logger.info("Staged photo cleanup scheduler started (every 10 minutes)");

  // Delete first-party analytics events older than 13 months: at boot, then
  // daily at 03:20. Bounded batches; a backlog drains over successive runs.
  void runMonitoredJob("analytics-retention-purge", runAnalyticsRetentionPurge);
  schedule("20 3 * * *", "analytics-retention-purge", runAnalyticsRetentionPurge, { daily: true });
  logger.info("Analytics retention purge scheduler started (daily at 03:20)");

  schedule("35 8 * * *", "operational-action-reminders", logged(
    "Operational action reminder job complete", runTrackActionReminderJob,
  ), { daily: true });
  logger.info("Operational action reminder scheduler started (daily at 08:35)");

  schedule("0 8 * * *", "contractor-reminders", logged("Scheduled reminder job complete", runReminderJob), { daily: true });
  logger.info("Contractor reminder scheduler started (daily at 08:00)");

  // Follow up contractor visits with no certificate 3 days on: a draft for
  // the contractor in Contractor Approvals and one email to the site's
  // Maintenance person (daily at 08:05; once per visit).
  schedule("5 8 * * *", "certificate-follow-up", logged(
    "Certificate follow-up job complete", () => runCertificateFollowUpJob(),
  ), { daily: true });
  logger.info("Certificate follow-up scheduler started (daily at 08:05)");

  // Alert managers about contractor insurance, DBS/PVG and certificates.
  // Run at 08:55 London time so 60/30-day date boundaries stay predictable.
  schedule("55 8 * * *", "contractor-compliance-reminders", logged(
    "Contractor compliance reminder job complete", runContractorComplianceReminderJob,
  ), { daily: true });
  logger.info("Contractor compliance reminder scheduler started (daily at 08:55)");

  // Alert managers when staff training certificates are expiring within 30 days
  // or have already expired (daily at 09:00; deduped per record milestone).
  schedule("0 9 * * *", "training-expiry-reminders", logged(
    "Training expiry reminder job complete", () => runTrainingExpiryReminderJob(),
  ), { daily: true });
  logger.info("Training expiry reminder scheduler started (daily at 09:00)");

  // Reconcile Stripe subscription quantities daily so any billing drift from
  // missed webhooks or transient Stripe failures self-heals.
  schedule("30 8 * * *", "billing-reconciliation", runBillingReconciliation, { daily: true });
  logger.info("Billing reconciliation scheduler started (daily at 08:30)");

  // Remind clients whose free trial is about to end, and tell those whose
  // trial has just ended without a subscription (daily at 08:15).
  schedule("15 8 * * *", "trial-reminders", runTrialReminders, { daily: true });
  logger.info("Trial reminder scheduler started (daily at 08:15)");

  // Email a business's managers once when its stored files pass the storage
  // warning level set in Settings (daily at 08:10, from the usage ledger).
  schedule("10 8 * * *", "storage-warning-emails", logged(
    "Storage warning email job complete", () => runStorageWarningEmailJob(),
  ), { daily: true });
  logger.info("Storage warning email scheduler started (daily at 08:10)");

  // Email safety check reminders for overdue/due-soon checks (daily at 08:45)
  schedule("45 8 * * *", "check-reminder-emails", logged(
    "Check reminder email job complete", runCheckReminderEmailJob,
  ), { daily: true });
  logger.info("Check reminder scheduler started (daily at 08:45)");

  // Remind managers about outstanding document acknowledgements (daily at
  // 08:50; each client gets at most one email per 7 days).
  schedule("50 8 * * *", "doc-ack-reminders", logged(
    "Doc acknowledgement reminder job complete", runDocAckReminderJob,
  ), { daily: true });
  logger.info("Doc acknowledgement reminder scheduler started (daily at 08:50)");

  // Email managers a digest of overdue/stale urgent FixTrack issues
  // (daily at 08:40; each client gets at most one email per day).
  schedule("40 8 * * *", "fixtrack-overdue-alerts", logged(
    "FixTrack overdue alert job complete", () => runFixTrackOverdueAlertJob(),
  ), { daily: true });
  logger.info("FixTrack overdue alert scheduler started (daily at 08:40)");

  // Recovery-only reconciliation resumes persisted pending/sending snapshots
  // with their original provider idempotency key. It never creates a new
  // digest, so manager alerts still originate only from the daily schedule.
  schedule("*/5 * * * *", "fixtrack-alert-recovery", logged(
    "FixTrack alert recovery complete",
    () => runFixTrackOverdueAlertJob(undefined, { recoverOnly: true }),
    (result) => result.clientsEmailed === 0,
  ));
  logger.info("FixTrack alert recovery scheduler started (every 5 minutes)");

  // Notify tenant managers about overdue bike hires (daily scan; initial alert
  // then a safely claimed weekly repeat while the hire remains active).
  schedule("20 8 * * *", "bike-overdue-alerts", logged(
    "Bike overdue job complete", () => runBikeOverdueJob(), (result) => result.hiresFound === 0,
  ), { daily: true });
  logger.info("Bike overdue repeat-notification scheduler started (daily at 08:20)");

  // Replay unconfirmed overdue-bike digests with their persisted provider
  // idempotency key while the provider still deduplicates it. Recovery never
  // creates a new digest; new alerts still come only from the daily scan.
  schedule("*/5 * * * *", "bike-overdue-recovery", logged(
    "Bike overdue recovery complete",
    () => runBikeOverdueJob({}, { recoverOnly: true }),
    (result) => result.clientsEmailed === 0 && result.errors === 0,
  ));

  // Detect newly cancelled subscriptions and lapsed trials, start the 12-month
  // retention clock, and clear it again for anyone who has resubscribed
  // (daily at 07:00; sends one offboarding email per client).
  schedule("0 7 * * *", "cancellation-detection", logged(
    "Cancellation detection job complete", () => runCancellationDetectionJob(),
  ), { daily: true });
  logger.info("Cancellation detection scheduler started (daily at 07:00)");

  // One reminder, with the download link, 30 days before a cancelled
  // business's 12-month deletion (daily at 07:15).
  schedule("15 7 * * *", "deletion-reminders", logged(
    "Deletion reminder job complete", () => runDeletionReminderJob(),
  ), { daily: true });
  logger.info("Deletion reminder scheduler started (daily at 07:15)");

  // Reconcile any cancellation/scheduled-cancellation webhook missed by Stripe
  // sync and warn account admins before their paid access cutoff.
  schedule("50 6 * * *", "cancellation-warnings", logged(
    "Cancellation warning reconciliation complete", () => runCancellationWarningJob(),
  ), { daily: true });
  logger.info("Cancellation warning scheduler started (daily at 06:50)");

  // Hard-delete compliance data for clients whose 12-month window has passed
  // (daily at 03:00; irreversible — runs only after data_deletion_scheduled_at).
  // A failed client fails the run (alerted via Sentry and ADMIN_EMAIL) and is
  // retried the next day.
  schedule("0 3 * * *", "data-deletion", logged(
    "Data deletion job complete",
    () => runDataDeletionJob({ eraseStorage: eraseClientStorageObjects }),
    (result) => result.clientsDeleted === 0,
  ), { daily: true });
  logger.info("Data deletion scheduler started (daily at 03:00)");

  // Cancelled businesses' files move to cold storage 30 days after
  // cancellation and back again if they resubscribe (daily at 04:00, after
  // the deletion job). Cuts what kept-but-unused files cost during the 12 months.
  schedule("0 4 * * *", "cancelled-storage-class", logged(
    "Cancelled storage class job complete",
    () => runCancelledStorageClassJob(),
    (result) => result.archived === 0 && result.restored === 0,
  ), { daily: true });
  logger.info("Cancelled storage class scheduler started (daily at 04:00)");

  // Check daily at 08:00 UK local time; the job creates new monthly mail
  // only on the 1st and resumes unfinished deliveries on subsequent days.
  schedule("0 8 * * *", "monthly-compliance-summary", logged(
    "Monthly compliance summary job complete", () => runMonthlyComplianceSummaryJob(),
  ), { daily: true });
  logger.info("Monthly compliance summary scheduler started (daily at 08:00 Europe/London)");

  // Alert client admins weekly (Monday 09:00) when contractor public liability
  // insurance is expiring within 30 days or has already expired. Missed runs
  // are caught up at start-up (catchUpWeeklyInsuranceDigest).
  schedule("0 9 * * 1", CONTRACTOR_INSURANCE_JOB, logged(
    "Contractor insurance expiry reminder job complete", runContractorInsuranceExpiryReminderJob,
  ));
  logger.info("Contractor insurance expiry reminder scheduler started (weekly Monday at 09:00)");

  // Check tenant-specific SafeTrack acknowledgement reminder settings every
  // five minutes. Each account chooses daily or weekly cadence and local time.
  registerSafeTrackAckReminderSchedule((expression, task) =>
    schedule(expression, "safetrack-ack-reminders", async () => { await task(); }));
  logger.info("SafeTrack acknowledgement reminder scheduler started (every five minutes)");

  // Read-only audit of the synced Stripe price catalogue, so a price or
  // product archived after startup is reported before a client's add-on
  // activation fails. Alerts once per incident and reports recovery; it never
  // changes prices, products, subscriptions or charges.
  schedule(SERVICE_PRICE_AUDIT_CRON, "service-price-audit", () => runScheduledServicePriceAudit());
  logger.info("Stripe service-price audit scheduler started (hourly at :25)");

  // Re-check Stripe Tax settings hourly so the /readyz note clears soon after
  // they are fixed in the Stripe dashboard. Read-only.
  schedule(STRIPE_TAX_CHECK_CRON, "stripe-tax-check", () => runStripeTaxCheck());

  // In-app reminders (bell + mobile push, never email) to each track's owner
  // for unsubmitted AM/PM checklists and kitchen diaries and overdue checks.
  // Hourly; each business is evaluated at its own local 09:00/11:00/21:00.
  schedule("5 * * * *", "track-reminders", logged(
    "Track reminder job complete", () => runTrackReminderJob(),
    (result) => result.notificationsCreated === 0 && result.errors === 0,
  ), { daily: true });
  logger.info("Track owner reminder scheduler started (hourly at :05)");

  // Storage add-on price vs provider rate plus margin. Purchases pause on
  // drift; this alerts operators once per finding and reports recovery.
  schedule(STORAGE_PRICE_AUDIT_CRON, "storage-price-audit", () => runScheduledStoragePriceAudit());
  logger.info("Storage add-on price audit scheduler started (hourly at :35)");
}
async function runTrialReminders() {
  logger.info("Running trial ending reminder job...");
  const result = await runTrialReminderJob();
  logger.info({ result }, "Trial ending reminder job complete");
  const ended = await runTrialEndedEmailJob();
  if (ended.clientsNotified > 0) logger.info({ result: ended }, "Trial ended emails sent");
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
    throw err;
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
        `<tr><td style="padding:6px 12px;border:1px solid #e2e8f0;">${escapeHtml(c.clientName ?? "(unknown)")} (id ${c.clientId})</td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${c.subscriptionId}</td><td style="padding:6px 12px;border:1px solid #e2e8f0;text-align:center;">${c.fromQuantity}</td><td style="padding:6px 12px;border:1px solid #e2e8f0;text-align:center;">${c.toQuantity}</td></tr>`,
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
// Sentry.init() has already been called by bootstrap.ts, so these are also
// captured there if SENTRY_DSN is configured; the fatal handler waits for
// that report to be sent before exiting.

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
      html: `<p><strong>Unhandled promise rejection</strong></p><pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:12px;overflow:auto;">${escapeHtml(`${message}\n\n${stack}`)}</pre>`,
      text: `Unhandled promise rejection\n\n${message}\n\n${stack}`,
    });
  } catch {
    // best-effort — don't throw from inside an error handler
  }
});

process.on("uncaughtException", async (err: Error) => {
  logger.fatal({ err }, `Uncaught exception: ${err.message}`);
  // Schedule the exit first: the process is in an undefined state, and a slow
  // or hung email provider must not keep it alive. Render restarts it.
  setTimeout(() => process.exit(1), 5_000);

  const adminEmail = process.env.ADMIN_EMAIL?.trim();
  if (adminEmail) {
    try {
      await sendSystemEmail({
        to: adminEmail,
        subject: `[ComplyTrack] FATAL uncaught exception on ${new Date().toISOString()}`,
        html: `<p><strong>Uncaught exception — process may restart</strong></p><pre style="background:#fee2e2;padding:12px;border-radius:6px;font-size:12px;overflow:auto;">${escapeHtml(`${err.message}\n\n${err.stack ?? ""}`)}</pre>`,
        text: `Uncaught exception — process may restart\n\n${err.message}\n\n${err.stack ?? ""}`,
      });
    } catch {
      // best-effort
    }
  }
  if (isErrorReportingEnabled()) await Sentry.flush(2_000).catch(() => false);
  // Give the event loop a moment so pino can flush, then exit.
  setTimeout(() => process.exit(1), 500);
});

let stripeStartup: StripeStartupHandle | null = null;

const server = app.listen(port, (err?: any) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  void startApplication();
});

async function startApplication() {
  if (process.env.NODE_ENV === "production" && !process.env.ADMIN_EMAIL?.trim()) {
    logger.warn("ADMIN_EMAIL not configured — internal billing and data-deletion notices cannot be delivered");
  }
  // Informational only: production without SENTRY_DSN still starts, and
  // /readyz says error reports are off rather than implying alerts work.
  if (process.env.NODE_ENV === "production" && !isErrorReportingEnabled()) {
    setReadinessNote("errorReports", { configured: false, missing: ["SENTRY_DSN"] });
  }
  const emailIssues = describeEmailConfigurationIssues();
  if (emailIssues.length > 0) {
    logger.warn({ issues: emailIssues }, "Email delivery is not fully configured");
    setReadinessNote("email", { issues: emailIssues });
  }

  // A failed migration must stop this instance: /healthz stays 503 until
  // migrations finish, and exiting non-zero fails the Render deploy so the
  // previous healthy instance keeps serving.
  try {
    await runRuntimeMigrations();
  } catch (err) {
    logger.fatal({ err }, "Runtime migrations failed — exiting so this deploy is not promoted");
    captureJobFailure("runtime-migrations", err);
    if (isErrorReportingEnabled()) await Sentry.flush(2_000).catch(() => false);
    process.exit(1);
  }
  const contractorTokenProblem = getContractorTokenProblem();
  setReadinessNote("contractorLinks", contractorTokenProblem ? { disabled: true, reason: contractorTokenProblem } : null);
  await loadJobRunHistory();

  // Billing reads (deletion eligibility, subscription state, portfolio) query
  // the synced stripe.* tables. Without Stripe no attempt creates them, so
  // create them empty: those reads then see "no subscription" instead of
  // failing. With Stripe configured, the initialization attempt does this.
  if (!getStripeCredentialSource() && process.env.DATABASE_URL) {
    try {
      await runMigrations({ databaseUrl: process.env.DATABASE_URL });
    } catch (err) {
      logger.warn({ err }, "Could not create the Stripe sync schema while Stripe is unconfigured");
    }
  }

  // Stripe start-up is bounded: /readyz reports "starting" until the first
  // attempt settles or STRIPE_INIT_TIMEOUT_MS passes, then "ok" or "degraded"
  // with a blocker. Failures retry in the background; billing activation stays
  // blocked until the catalogue is verified (see lib/stripeStartup.ts).
  stripeStartup = startStripeInitialization({
    credentialSource: getStripeCredentialSource,
    runAttempt: initStripe,
    required: process.env.NODE_ENV === "production",
    timeoutMs: positiveMsFromEnv(process.env.STRIPE_INIT_TIMEOUT_MS, 120_000),
    retryDelaysMs: [30_000, 60_000, 120_000, 300_000, 900_000],
    logger,
    // Reconcile once shortly after the catalogue is verified so drift never
    // waits a full day (best-effort; exits quietly per client when Stripe fails).
    onCatalogueVerified: () => {
      setTimeout(() => void runMonitoredJob("billing-reconciliation", runBillingReconciliation), 15_000);
    },
  });
  markApplicationReady();
  // Keep the previous ordering (jobs start after Stripe start-up) without
  // letting a stalled Stripe dependency postpone them indefinitely.
  await stripeStartup.firstSettledOrDeadline;
  if (shuttingDown) return;
  startScheduler();
  // Catch up trial reminders on startup too, so a server that was down at
  // 08:15 doesn't miss the 3-day warning window (deduped per client).
  setTimeout(() => void runMonitoredJob("trial-reminders", runTrialReminders), 20_000);
  // First catalogue audit after the startup preflight; deduped across restarts.
  setTimeout(() => void runMonitoredJob("service-price-audit", () => runScheduledServicePriceAudit()), 30_000);
  setTimeout(() => void runMonitoredJob("storage-price-audit", () => runScheduledStoragePriceAudit()), 35_000);
  setTimeout(() => {
    void runMonitoredJob("fixtrack-alert-recovery", () => runFixTrackOverdueAlertJob(undefined, { recoverOnly: true }));
  }, 25_000);
  setTimeout(() => void catchUpWeeklyInsuranceDigest(), 45_000);
}

// ── Graceful shutdown ───────────────────────────────────────────────────────
// Render sends SIGTERM on every deploy and restart, then SIGKILL after 30 s.
// Stop scheduling, stop accepting connections, let running jobs finish (up to
// 20 s; their delivery leases make an interrupted run safe to resume), then
// close the database pool and exit.
let shuttingDown = false;
const SHUTDOWN_JOB_WAIT_MS = 20_000;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down: stopping schedulers and closing the server");
  // Hard stop just inside Render's 30-second grace period.
  setTimeout(() => {
    logger.warn("Graceful shutdown timed out; exiting");
    process.exit(1);
  }, 27_000).unref();

  for (const task of scheduledTasks) {
    try { task.stop(); } catch { /* already stopped */ }
  }
  stopAcceptingJobs();
  stripeStartup?.stop();

  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const jobsFinished = await waitForInFlightJobs(SHUTDOWN_JOB_WAIT_MS);
  if (!jobsFinished) logger.warn("Scheduled jobs still running at shutdown; their leases will expire and be retried");
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);

  await pool.end().catch((err) => logger.warn({ err }, "Database pool did not close cleanly"));
  logger.info("Shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
