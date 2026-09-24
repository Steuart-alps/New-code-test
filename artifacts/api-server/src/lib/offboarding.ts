/**
 * Offboarding and data-retention jobs.
 *
 * Two jobs run daily:
 *
 * 1. runCancellationDetectionJob — finds clients whose Stripe subscription has
 *    been cancelled, stamps cancelled_at + data_deletion_scheduled_at (12 months
 *    later), and sends a one-shot offboarding email.
 *
 * 2. runDataDeletionJob — finds clients whose 12-month retention window has
 *    passed and hard-deletes all their compliance records, then stamps
 *    data_deleted_at. The client row itself is retained for audit purposes.
 */
import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, isNull, lte, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl, escapeHtml } from "./email";
import { findLiveSubscription } from "./billing";
import { randomUUID } from "crypto";

const RETENTION_MONTHS = 12;

// ── Helpers ────────────────────────────────────────────────────────────────────

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

async function getClientRecipients(clientId: number) {
  // Prefer consultants; fall back to client admin users.
  const consultants = await db.execute(sql`
    SELECT u.id, u.email, u.name
    FROM users u
    JOIN consultant_clients cc ON cc.user_id = u.id
    WHERE cc.client_id = ${clientId} AND u.active = true
  `);
  if ((consultants.rows ?? []).length > 0) {
    return consultants.rows as { id: number; email: string; name: string }[];
  }
  const admins = await db.execute(sql`
    SELECT id, email, name FROM users
    WHERE client_id = ${clientId} AND active = true AND role = 'client_admin'
    LIMIT 5
  `);
  return admins.rows as { id: number; email: string; name: string }[];
}

// ── Offboarding email ──────────────────────────────────────────────────────────

function buildOffboardingEmail(opts: {
  recipientName: string;
  companyName: string;
  deletionDate: Date;
  settingsUrl: string;
}) {
  const deletionStr = opts.deletionDate.toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const safeName    = escapeHtml(opts.recipientName);
  const safeCompany = escapeHtml(opts.companyName);
  const subject = `Your ComplyTrack data will be deleted on ${deletionStr}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Your ComplyTrack subscription has ended</h2>
      <p>Hi ${safeName},</p>
      <p>The subscription for <strong>${safeCompany}</strong> has been cancelled.</p>
      <p>In line with our data retention policy, all compliance records, documents and logs
         associated with this account will be <strong>permanently deleted on ${deletionStr}</strong>
         — ${RETENTION_MONTHS} months from today.</p>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:20px;margin:20px 0;">
        <p style="margin:0 0 12px;color:#92400e;font-weight:600;">⬇ Export your records before this date</p>
        <p style="margin:0 0 16px;color:#78350f;font-size:14px;">
          Download a full export of all your data — food safety logs, fire safety checks,
          training records, contractor files and more — as a ZIP file from your account settings.
        </p>
        <a href="${opts.settingsUrl}"
           style="display:inline-block;background:#ea580c;color:white;text-decoration:none;
                  padding:12px 24px;border-radius:6px;font-weight:600;">
          Download your data
        </a>
      </div>
      <p style="color:#64748b;font-size:13px;">
        If you resubscribe before ${deletionStr} your data will be preserved and no deletion will occur.
      </p>
      <p>Best regards,<br><strong>ComplyTrack</strong></p>
    </div>`;

  const text = `
Your ComplyTrack subscription has ended

Hi ${opts.recipientName},

The subscription for ${opts.companyName} has been cancelled.

All compliance records, documents and logs will be permanently deleted on ${deletionStr} (${RETENTION_MONTHS} months from today).

Download your data before this date from your account settings:
${opts.settingsUrl}

If you resubscribe before ${deletionStr} your data will be preserved.

Best regards,
ComplyTrack
`.trim();

  return { subject, html, text };
}

// ── Early cancellation warning (webhook-triggered) ────────────────────────────

/**
 * Sends a best-effort warning email to all client_admin users for the client
 * whose Stripe subscription has just been cancelled or scheduled to cancel at
 * period end. Called from the Stripe webhook handler; wrapped in try/catch
 * by the caller so it never blocks the webhook response.
 *
 * The email explains when access ends and prompts the user to export their
 * data before that date.
 */
type SqlExecutor = (query: any) => Promise<{ rows?: unknown[] }>;

export interface CancellationWarningDependencies {
  /** Kept injectable so delivery behaviour can be regression-tested without Stripe or Postgres. */
  execute?: SqlExecutor;
  sendEmail?: typeof sendSystemEmail;
  getAppUrl?: () => string;
}

type CancellationCandidate = {
  customer: string;
  access_ends_at: string | number | null;
};

/**
 * Read the synced Stripe state immediately before delivery.  In particular, an
 * old `customer.subscription.deleted` event must not warn a customer that has
 * since renewed.  A scheduled cancellation remains eligible because its
 * otherwise-live subscription has cancel_at_period_end set.
 */
async function getCurrentCancellation(
  stripeCustomerId: string,
  execute: SqlExecutor,
): Promise<CancellationCandidate | null> {
  const result = await execute(sql`
    SELECT s.customer, COALESCE(s.cancel_at, s.current_period_end) AS access_ends_at
    FROM stripe.subscriptions s
    WHERE s.customer = ${stripeCustomerId}
      AND (s.status = 'canceled' OR s.cancel_at_period_end = true)
      AND NOT EXISTS (
        SELECT 1
        FROM stripe.subscriptions live
        WHERE live.customer = s.customer
          AND live.status IN ('active', 'trialing', 'past_due')
          AND COALESCE(live.cancel_at_period_end, false) = false
      )
    ORDER BY s.current_period_end DESC NULLS LAST
    LIMIT 1
  `);
  return ((result.rows ?? [])[0] as CancellationCandidate | undefined) ?? null;
}

export async function sendCancellationWarningEmail(opts: {
  stripeCustomerId: string;
  /** ISO date string or Unix timestamp when access ends. */
  accessEndsAt: string | number | null;
}, deps: CancellationWarningDependencies = {}): Promise<{ emailsSent: number }> {
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  const execute: SqlExecutor = deps.execute ?? ((query) => db.execute(query) as Promise<{ rows?: unknown[] }>);

  // Do not trust a delayed webhook's payload. processWebhook has already
  // updated the synced Stripe tables, which lets this check also close the
  // webhook/scheduler renewal race.
  const cancellation = await getCurrentCancellation(opts.stripeCustomerId, execute);
  if (!cancellation) return { emailsSent: 0 };

  // Resolve the client from the Stripe customer id.
  const clientRows = await execute(sql`
    SELECT id, name FROM clients WHERE stripe_customer_id = ${opts.stripeCustomerId} LIMIT 1
  `);
  const client = (clientRows.rows ?? [])[0] as { id: number; name: string } | undefined;
  if (!client) return { emailsSent: 0 };

  // Senior account recipients are represented by client_admin in the current
  // role model. Consultants are deliberately excluded: this is the client's
  // billing/access warning, not an operational reminder.
  const adminRows = await execute(sql`
    SELECT id, email, name FROM users
    WHERE client_id = ${client.id} AND active = true AND role = 'client_admin'
    LIMIT 10
  `);
  const admins = (adminRows.rows ?? []) as { id: number; email: string; name: string }[];
  if (admins.length === 0) return { emailsSent: 0 };

  // Resolve the access-end date from a Unix timestamp or ISO string.
  let accessEndsDate: Date | null = null;
  if (cancellation.access_ends_at) {
    const val = cancellation.access_ends_at;
    accessEndsDate = typeof val === "number"
      ? new Date(val * 1000)
      : new Date(val);
    if (isNaN(accessEndsDate.getTime())) accessEndsDate = null;
  }

  // A warning without a known future date is misleading and is not useful to
  // someone trying to export before lockout. It will be retried after Stripe
  // supplies a period end.
  if (!accessEndsDate || accessEndsDate.getTime() <= Date.now()) return { emailsSent: 0 };
  const accessEndsStr = accessEndsDate.toLocaleDateString(
    "en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/London" },
  );
  // A changed cutoff warrants a fresh notice; otherwise the same recipient is
  // sent at most once. This key is intentionally stable for a missing Stripe
  // date so webhook retries still dedupe.
  const cutoffKey = accessEndsDate.toISOString();

  const appUrl = deps.getAppUrl?.() ?? getPublicAppUrl();
  const settingsUrl = `${appUrl}/settings#data-export`;
  const billingUrl = `${appUrl}/billing`;
  const safeCompany = escapeHtml(client.name);
  const subject = "Your ComplyTrack access is ending — export your records";

  let sent = 0;
  for (const admin of admins) {
    // A delivery is deliberately never re-claimed while sending/handed_off.
    // Retrying an uncertain external side effect would be worse than requiring
    // intervention. Known provider rejections are returned to pending below.
    const leaseToken = randomUUID();
    const claim = await execute(sql`
      INSERT INTO cancellation_warning_deliveries
        (client_id, user_id, cutoff_key, claimed_at, state, lease_token, lease_expires_at)
      SELECT ${client.id}, ${admin.id}, ${cutoffKey}, now(), 'sending', ${leaseToken},
        now() + interval '15 minutes'
      WHERE EXISTS (
        SELECT 1
        FROM stripe.subscriptions s
        WHERE s.customer = ${opts.stripeCustomerId}
          AND (s.status = 'canceled' OR s.cancel_at_period_end = true)
          -- Do not send a stale date if a concurrent Stripe update moved the
          -- cutoff after the initial read; that update will claim its own key.
          AND COALESCE(s.cancel_at, s.current_period_end) = ${cancellation.access_ends_at}
          AND NOT EXISTS (
            SELECT 1 FROM stripe.subscriptions live
            WHERE live.customer = s.customer
              AND live.status IN ('active', 'trialing', 'past_due')
              AND COALESCE(live.cancel_at_period_end, false) = false
          )
      )
      ON CONFLICT (client_id, user_id, cutoff_key) DO UPDATE
        SET claimed_at = now(),
            state = 'sending',
            lease_token = ${leaseToken},
            lease_expires_at = now() + interval '15 minutes'
        WHERE cancellation_warning_deliveries.state = 'pending'
      RETURNING id, lease_token
    `).catch((err) => {
      logger.error({ err, clientId: client.id, userId: admin.id }, "Could not claim cancellation warning delivery");
      return { rows: [] };
    });
    const delivery = (claim.rows ?? [])[0] as { id: number; lease_token: string } | undefined;
    if (!delivery) continue;
    const safeName = escapeHtml(admin.name ?? admin.email);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1e293b;">Your ComplyTrack subscription is being cancelled</h2>
        <p>Hi ${safeName},</p>
        <p>This is to let you know that the ComplyTrack subscription for <strong>${safeCompany}</strong>
           has been cancelled.</p>
        <p>Your access will continue until <strong>${escapeHtml(accessEndsStr)}</strong>.
           After that date you will no longer be able to log in or view your compliance records.</p>
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="margin:0 0 12px;color:#92400e;font-weight:600;">⬇ Export your records before access ends</p>
          <p style="margin:0 0 16px;color:#78350f;font-size:14px;">
            Download a full export of all your data — food safety logs, fire safety checks,
            training records, contractor files and more — as a ZIP file from your account settings.
          </p>
          <a href="${settingsUrl}"
             style="display:inline-block;background:#ea580c;color:white;text-decoration:none;
                    padding:12px 24px;border-radius:6px;font-weight:600;">
            Go to Settings &amp; Export
          </a>
        </div>
        <p style="color:#64748b;font-size:14px;">
           Changed your mind? You can <a href="${billingUrl}" style="color:#2563eb;">reactivate your subscription</a>
           at any time and your data will be preserved.
        </p>
        <p>Best regards,<br><strong>ComplyTrack</strong></p>
      </div>`;

    const text = `
Your ComplyTrack subscription is being cancelled

Hi ${admin.name ?? admin.email},

The ComplyTrack subscription for ${client.name} has been cancelled.

Your access will continue until ${accessEndsStr}. After that you will no longer be able to log in.

Export your records before access ends by visiting your account settings:
${settingsUrl}

Reactivate your subscription: ${billingUrl}

Best regards,
ComplyTrack
`.trim();

    // This is the final authority check and the durable handoff transition.
    // It includes the renewal test in the same SQL statement as ownership, so
    // a webhook/scheduler worker cannot hand off a warning after a renewal
    // landed between its initial read and this point.
    const handoff = await execute(sql`
      UPDATE cancellation_warning_deliveries d
         SET state = 'handed_off', handoff_at = now(), lease_expires_at = NULL
       WHERE d.id = ${delivery.id}
         AND d.lease_token = ${delivery.lease_token}
         AND d.state = 'sending'
         AND EXISTS (
           SELECT 1 FROM stripe.subscriptions s
            WHERE s.customer = ${opts.stripeCustomerId}
              AND (s.status = 'canceled' OR s.cancel_at_period_end = true)
              AND COALESCE(s.cancel_at, s.current_period_end) = ${cancellation.access_ends_at}
              AND NOT EXISTS (
                SELECT 1 FROM stripe.subscriptions live
                 WHERE live.customer = s.customer
                   AND live.status IN ('active', 'trialing', 'past_due')
                   AND COALESCE(live.cancel_at_period_end, false) = false
              )
         )
      RETURNING id
    `).catch((err) => {
      logger.error({ err, clientId: client.id, userId: admin.id }, "Could not persist cancellation warning handoff");
      return { rows: [] };
    });
    if ((handoff.rows ?? []).length === 0) {
      // A renewal (or another state transition) won. Only this lease may
      // release its own pre-handoff state; never disturb another worker.
      await execute(sql`
        UPDATE cancellation_warning_deliveries
           SET state = 'pending', lease_token = NULL, lease_expires_at = NULL
         WHERE id = ${delivery.id} AND lease_token = ${delivery.lease_token}
           AND state = 'sending'
      `).catch(() => {});
      continue;
    }

    try {
      await sendEmail({
        to: admin.email,
        subject,
        html,
        text,
        // Provider-level idempotency protects the known-error retry path too.
        idempotencyKey: `cancellation-warning:${client.id}:${admin.id}:${cutoffKey}`,
      });
    } catch (err) {
      // This provider call explicitly rejected the message, so this same
      // handoff owner may make it pending for a later retry. Do not release an
      // accepted/unknown handoff, and do not permit a late lease to release a
      // newer attempt.
      await execute(sql`
        UPDATE cancellation_warning_deliveries
           SET state = 'pending', lease_token = NULL, lease_expires_at = NULL
         WHERE id = ${delivery.id} AND lease_token = ${delivery.lease_token}
           AND state = 'handed_off' AND sent_at IS NULL
      `).catch(() => {});
      logger.warn({ err, clientId: client.id, adminEmail: admin.email }, "Cancellation warning email failed for admin");
      continue;
    }

    try {
      await execute(sql`
        UPDATE cancellation_warning_deliveries
           SET state = 'sent', sent_at = now()
         WHERE id = ${delivery.id} AND lease_token = ${delivery.lease_token}
           AND state = 'handed_off'
      `);
      sent++;
    } catch (err) {
      // The provider accepted the message. Its durable handed_off state is
      // intentionally retained and is terminal/fail-closed; never release it.
      logger.error({ err, clientId: client.id, userId: admin.id },
        "Cancellation warning accepted but sent finalization failed");
    }
  }
  return { emailsSent: sent };
}

/**
 * Reconciles cancellation warnings missed while a Stripe webhook was down.
 * Stripe's synced subscription data is the billing source of truth; unlike
 * trial reminders this never uses trial dates or trial status.
 */
export async function runCancellationWarningJob(
  deps: CancellationWarningDependencies = {},
): Promise<{ emailsSent: number }> {
  const execute: SqlExecutor = deps.execute ?? ((query) => db.execute(query) as Promise<{ rows?: unknown[] }>);
  const candidates = await execute(sql`
    WITH current_subscriptions AS (
      SELECT DISTINCT ON (c.id) c.id, s.customer, s.status, s.cancel_at_period_end,
        COALESCE(s.cancel_at, s.current_period_end) AS access_ends_at
      FROM clients c
      JOIN stripe.subscriptions s ON s.customer = c.stripe_customer_id
      ORDER BY c.id, s.current_period_end DESC NULLS LAST
    )
    SELECT id, customer, access_ends_at
    FROM current_subscriptions
    WHERE (status = 'canceled' OR cancel_at_period_end = true)
      AND access_ends_at > now()
  `).catch((err) => {
    logger.warn({ err }, "Cancellation warning reconciliation unavailable");
    return { rows: [] };
  });

  let emailsSent = 0;
  for (const row of candidates.rows as Array<{ customer: string; access_ends_at: string | number | null }>) {
    try {
      const result = await sendCancellationWarningEmail({
        stripeCustomerId: String(row.customer),
        accessEndsAt: row.access_ends_at,
      }, deps);
      emailsSent += result.emailsSent;
    } catch (err) {
      // One tenant's bad delivery state must not prevent retries for the rest.
      logger.warn({ err, stripeCustomerId: row.customer }, "Cancellation warning reconciliation failed for client");
    }
  }
  return { emailsSent };
}

// ── Job 1: Cancellation detection ─────────────────────────────────────────────

/**
 * Finds clients whose Stripe subscription is fully cancelled but who haven't
 * been stamped with cancelled_at yet. Sets the retention clock and sends the
 * offboarding email (one-shot, deduped via offboarding_email_sent_at).
 */
export async function runCancellationDetectionJob(): Promise<{
  clientsDetected: number;
  emailsSent: number;
}> {
  let clientsDetected = 0;
  let emailsSent = 0;

  // Only consider clients that have a Stripe customer and no cancellation stamp.
  const candidates = await db
    .select()
    .from(clientsTable)
    .where(
      and(
        isNotNull(clientsTable.stripeCustomerId),
        isNull(clientsTable.cancelledAt),
        isNull(clientsTable.dataDeletedAt),
      ),
    );

  for (const client of candidates) {
    try {
      // If a live subscription exists the client is still active — skip.
      const live = await findLiveSubscription(client.stripeCustomerId!).catch(() => null);
      if (live) continue;

      // Skip pre-subscription accounts (no Stripe subscription on record at all).
      const subCheck = await db.execute(sql`
        SELECT 1 FROM stripe.subscriptions WHERE customer = ${client.stripeCustomerId} LIMIT 1
      `).catch(() => ({ rows: [] }));
      if ((subCheck.rows ?? []).length === 0) continue;

      const now = new Date();
      const deletionDate = addMonths(now, RETENTION_MONTHS);

      // Claim atomically — WHERE cancelled_at IS NULL prevents double-firing.
      const claimed = await db.execute(sql`
        UPDATE clients
           SET cancelled_at               = ${now},
               data_deletion_scheduled_at = ${deletionDate},
               updated_at                 = ${now}
         WHERE id = ${client.id}
           AND cancelled_at IS NULL
        RETURNING id
      `);
      if ((claimed.rows ?? []).length === 0) continue; // Another process claimed it.

      clientsDetected++;
      logger.info({ clientId: client.id, deletionDate }, "Client cancellation detected — retention clock started");

      // Send offboarding email once.
      if (client.offboardingEmailSentAt) continue;

      const recipients = await getClientRecipients(client.id);
      const settingsUrl = `${getPublicAppUrl()}/settings`;
      let sent = 0;

      for (const r of recipients) {
        try {
          const { subject, html, text } = buildOffboardingEmail({
            recipientName: r.name ?? r.email,
            companyName: client.name,
            deletionDate,
            settingsUrl,
          });
          await sendSystemEmail({ to: r.email, subject, html, text });
          sent++;
        } catch (err) {
          logger.error({ err, clientId: client.id }, "Offboarding email failed for recipient");
        }
      }

      if (sent > 0) {
        await db.execute(sql`
          UPDATE clients SET offboarding_email_sent_at = ${new Date()} WHERE id = ${client.id}
        `);
        emailsSent += sent;
        logger.info({ clientId: client.id, sent }, "Offboarding emails sent");
      }
    } catch (err) {
      logger.error({ err, clientId: client.id }, "Cancellation detection error for client");
    }
  }

  return { clientsDetected, emailsSent };
}

// ── Job 2: Hard data deletion ──────────────────────────────────────────────────

/**
 * Hard-deletes all compliance records for clients whose 12-month retention
 * window has passed. The client row itself is kept (with data_deleted_at set)
 * to preserve the audit trail. Users are anonymised rather than deleted.
 */
export async function runDataDeletionJob(): Promise<{ clientsDeleted: number }> {
  let clientsDeleted = 0;
  const now = new Date();

  const due = await db.execute(sql`
    SELECT c.id, c.name FROM clients c
    WHERE c.data_deleted_at IS NULL
      AND ((c.data_deletion_scheduled_at IS NOT NULL AND c.data_deletion_scheduled_at <= now())
        OR EXISTS (
          SELECT 1 FROM client_data_deletion_requests r
          WHERE r.client_id = c.id AND r.status = 'approved'
            AND r.earliest_deletion_at <= now()
        ))
  `);

  for (const client of due.rows as Array<{ id: number; name: string }>) {
    try {
      // Submission and direct client deletion use the same per-client lock.
      // Recheck both the 30-day window and legal holds after acquiring it,
      // then hold the lock until the deletion and completion marker finish.
      const deleted = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(106, ${client.id})`);
        const guard = await tx.execute(sql`
          SELECT c.id FROM clients c WHERE c.id = ${client.id}
            AND c.data_deleted_at IS NULL
            AND ((c.data_deletion_scheduled_at IS NOT NULL AND c.data_deletion_scheduled_at <= now())
              OR EXISTS (SELECT 1 FROM client_data_deletion_requests r
                WHERE r.client_id = c.id AND r.status = 'approved'
                  AND r.earliest_deletion_at <= now()))
            AND NOT EXISTS (SELECT 1 FROM client_data_deletion_requests r
              WHERE r.client_id = c.id
                AND (r.status = 'pending' OR (r.status = 'approved' AND r.earliest_deletion_at > now())))
            AND NOT EXISTS (SELECT 1 FROM privacy_retention_schedules h
              WHERE h.client_id = c.id AND h.active = true
                AND (h.legal_hold_active = true OR h.deletion_exception = true))
        `);
        if (guard.rows.length === 0) return false;
        logger.info({ clientId: client.id }, "Starting data deletion for client");
        await deleteAllClientData(client.id);
        await tx.execute(sql`
          UPDATE clients SET data_deleted_at = ${now}, updated_at = ${now}
          WHERE id = ${client.id}
        `);
        await tx.execute(sql`
          UPDATE client_data_deletion_requests SET status = 'completed'
          WHERE client_id = ${client.id} AND status = 'approved'
        `);
        return true;
      });
      if (!deleted) {
        logger.info({ clientId: client.id }, "Scheduled deletion deferred for review, retention window or legal hold");
        continue;
      }
      clientsDeleted++;
      logger.info({ clientId: client.id }, "Client data permanently deleted");

      // Notify system admin.
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const safeCompany = escapeHtml(client.name);
        await sendSystemEmail({
          to: adminEmail,
          subject: `ComplyTrack: data deleted for ${client.name} (id ${client.id})`,
          html: `<p>All compliance records for <strong>${safeCompany}</strong> (client id ${client.id}) have been permanently deleted as scheduled under the ${RETENTION_MONTHS}-month data retention policy.</p>`,
          text: `All compliance records for ${client.name} (client id ${client.id}) have been permanently deleted as scheduled under the ${RETENTION_MONTHS}-month data retention policy.`,
        }).catch((err) => logger.error({ err }, "Deletion confirmation email failed"));
      }
    } catch (err) {
      logger.error({ err, clientId: client.id }, "Data deletion failed for client — will retry tomorrow");
    }
  }

  return { clientsDeleted };
}

// ── deleteAllClientData ────────────────────────────────────────────────────────

/**
 * Deletes all compliance data for a client in FK-safe order (children before
 * parents). Each statement uses IF the table exists via .catch(() => {}) so a
 * missing table (schema drift) never aborts the whole deletion run.
 */
async function deleteAllClientData(cid: number): Promise<void> {
  // Remove the tenant's privacy records only after the scheduled-delete guard
  // above confirms there is no active legal hold or recorded exception.
  await db.execute(sql`DELETE FROM privacy_retention_verifications WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM privacy_rights_requests WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM privacy_breaches WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM privacy_retention_schedules WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM privacy_processors WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM privacy_processing_activities WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM privacy_programs WHERE client_id = ${cid}`).catch(() => {});

  // ─ Swim track (surveillance_checks refs sessions) ──────────────────────────
  await db.execute(sql`DELETE FROM swim_surveillance_checks WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM swim_incidents             WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM swim_sessions              WHERE client_id = ${cid}`).catch(() => {});

  // ─ Bike track (checks + hire records ref bikes) ───────────────────────────
  await db.execute(sql`DELETE FROM bike_checks       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM bike_hire_records WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM bikes             WHERE client_id = ${cid}`).catch(() => {});

  // ─ Hot tub track ──────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM hot_tub_checks WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM hot_tubs        WHERE client_id = ${cid}`).catch(() => {});

  // ─ PAT track (tests ref appliances) ──────────────────────────────────────
  await db.execute(sql`DELETE FROM pat_tests      WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pat_appliances WHERE client_id = ${cid}`).catch(() => {});

  // ─ Green track (pre-use checks ref machines) ──────────────────────────────
  await db.execute(sql`DELETE FROM green_pre_use_checks WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM green_machines        WHERE client_id = ${cid}`).catch(() => {});

  // ─ DocTrack (acknowledgements ref documents) ──────────────────────────────
  await db.execute(sql`DELETE FROM doc_acknowledgements WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM doc_track_documents  WHERE client_id = ${cid}`).catch(() => {});

  // ─ Contractors + certificates (certs ref contractors) ─────────────────────
  await db.execute(sql`
    DELETE FROM certificates
     WHERE contractor_id IN (SELECT id FROM contractors WHERE client_id = ${cid})
  `).catch(() => {});
  await db.execute(sql`DELETE FROM contractors WHERE client_id = ${cid}`).catch(() => {});

  // ─ FixTrack (action tokens + alert log cascade from issues) ───────────────
  await db.execute(sql`DELETE FROM fix_track_alert_log    WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM fix_track_action_tokens
                         WHERE issue_id IN (SELECT id FROM fix_track_issues WHERE client_id = ${cid})`).catch(() => {});
  await db.execute(sql`DELETE FROM fix_track_issues WHERE client_id = ${cid}`).catch(() => {});

  // ─ SafeTrack ──────────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM safe_incidents          WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_risk_assessments   WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_sops               WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_training_records   WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_inductions         WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_competency_signoffs WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM safe_handbook           WHERE client_id = ${cid}`).catch(() => {});

  // ─ TrainTrack ─────────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM train_track_records WHERE client_id = ${cid}`).catch(() => {});

  // ─ Food, fire, water, pool, pest, premises, tree, general incidents ───────
  await db.execute(sql`DELETE FROM food_safety_records   WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM fire_safety_checks    WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM legionella_checks     WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pool_checks           WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pest_visits           WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM pest_activity         WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM premises_inspections  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM tree_inspections      WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM incidents             WHERE client_id = ${cid}`).catch(() => {});

  // ─ Checklists and kitchen records ─────────────────────────────────────────
  await db.execute(sql`DELETE FROM daily_checklists        WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM daily_manager_signoffs  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_weekly_records  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_probe_checks    WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_cleaning_tasks  WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM kitchen_cleaning_logs   WHERE client_id = ${cid}`).catch(() => {});

  // ─ Staff roster ───────────────────────────────────────────────────────────
  await db.execute(sql`DELETE FROM staff_roster WHERE client_id = ${cid}`).catch(() => {});

  // ─ Photos, templates, reminders, maintenance ──────────────────────────────
  await db.execute(sql`DELETE FROM check_photos              WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM photo_requirements        WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM checklist_templates       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM check_reminder_log        WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM contractor_compliance_reminder_log WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM training_expiry_reminder_log       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM doc_ack_reminder_log               WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM maintenance_requests      WHERE client_id = ${cid}`).catch(() => {});

  // ─ Compliance items (refs contractors, sites, depts — all scoped) ─────────
  await db.execute(sql`DELETE FROM compliance_items WHERE client_id = ${cid}`).catch(() => {});

  // ─ App settings, categories ───────────────────────────────────────────────
  await db.execute(sql`DELETE FROM app_settings WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM categories   WHERE client_id = ${cid}`).catch(() => {});

  // ─ Users: anonymise to preserve audit trail rather than hard-delete ───────
  await db.execute(sql`
    UPDATE users SET
      active        = false,
      email         = 'deleted-' || id || '@deleted.invalid',
      password_hash = '',
      name          = 'Deleted User',
      updated_at    = NOW()
    WHERE client_id = ${cid}
  `).catch(() => {});

  // ─ Sites and departments (last, after all referencing tables cleared) ──────
  await db.execute(sql`DELETE FROM sites       WHERE client_id = ${cid}`).catch(() => {});
  await db.execute(sql`DELETE FROM departments WHERE client_id = ${cid}`).catch(() => {});
}
