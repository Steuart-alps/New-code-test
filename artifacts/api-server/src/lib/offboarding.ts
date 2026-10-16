/**
 * Offboarding and data-retention jobs.
 *
 * Two jobs run daily:
 *
 * 1. runCancellationDetectionJob — finds clients whose Stripe subscription has
 *    been cancelled, or whose free trial ended without a subscription, stamps
 *    cancelled_at + data_deletion_scheduled_at (12 months later), and sends a
 *    one-shot offboarding email. It also clears both stamps for any client
 *    that has a live subscription again.
 *
 * 2. runDataDeletionJob — finds clients whose 12-month retention window has
 *    passed and hard-deletes all their compliance records and stored files,
 *    then stamps data_deleted_at. The client row itself is retained for audit
 *    purposes.
 */
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { and, isNull, isNotNull, inArray, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl, escapeHtml } from "./email";
import { findLiveSubscription } from "./billing";
import { claimEmailDelivery, emailDeliveryIdempotencyKey, markEmailDeliverySent, settleEmailDelivery } from "./emailDeliveryClaims";
import { randomUUID } from "crypto";

/**
 * When a synced subscription's access ends, in Unix seconds (the stripe.*
 * columns are integers, so compare with `extract(epoch from now())`, never
 * `now()`). Stripe API versions from 2025-03-31.basil no longer put
 * current_period_end on the subscription, so a subscription cancelled outright
 * (no cancel_at) falls back to ended_at. Expects the subscription aliased `s`.
 */
export const SUBSCRIPTION_ACCESS_ENDS_AT = sql.raw("COALESCE(s.cancel_at, s.current_period_end, s.ended_at)");

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

/**
 * Who hears about the business's billing: its client admins plus the
 * consultants who own or manage it (a self-signup owner is a consultant).
 */
function billingRecipientsQuery(clientId: number) {
  return sql`
    SELECT u.id, u.email, u.name FROM users u
    WHERE u.active = true
      AND u.role IN ('client_admin', 'consultant')
      AND (u.client_id = ${clientId}
        OR (u.role = 'consultant' AND EXISTS (
          SELECT 1 FROM consultant_clients cc WHERE cc.user_id = u.id AND cc.client_id = ${clientId})))
    ORDER BY u.id
    LIMIT 20
  `;
}

function formatUkDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/London",
  });
}

// ── Offboarding email ──────────────────────────────────────────────────────────

function buildOffboardingEmail(opts: {
  recipientName: string;
  companyName: string;
  deletionDate: Date;
  settingsUrl: string;
  /** A paid subscription was cancelled, or a free trial ended without one. */
  reason: "cancelled" | "trial_ended";
}) {
  const deletionStr = formatUkDate(opts.deletionDate);
  const safeName    = escapeHtml(opts.recipientName);
  const safeCompany = escapeHtml(opts.companyName);
  const subject = `Your ComplyTrack data will be deleted on ${deletionStr}`;
  const heading = opts.reason === "trial_ended"
    ? "Your ComplyTrack free trial has ended"
    : "Your ComplyTrack subscription has ended";
  const endedLine = opts.reason === "trial_ended"
    ? "The free trial for COMPANY has ended without a subscription."
    : "The subscription for COMPANY has been cancelled.";
  const resubscribe = opts.reason === "trial_ended" ? "subscribe" : "resubscribe";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">${heading}</h2>
      <p>Hi ${safeName},</p>
      <p>${endedLine.replace("COMPANY", `<strong>${safeCompany}</strong>`)}</p>
      <p>In line with our data retention policy, all compliance records, documents and logs
         associated with this account will be <strong>permanently deleted on ${deletionStr}</strong>
         — ${RETENTION_MONTHS} months after it ended.</p>
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
        If you ${resubscribe} before ${deletionStr} your data will be preserved and no deletion will occur.
      </p>
      <p>Best regards,<br><strong>ComplyTrack</strong></p>
    </div>`;

  const text = `
${heading}

Hi ${opts.recipientName},

${endedLine.replace("COMPANY", opts.companyName)}

All compliance records, documents and logs will be permanently deleted on ${deletionStr} (${RETENTION_MONTHS} months after it ended).

Download your data before this date from your account settings:
${opts.settingsUrl}

If you ${resubscribe} before ${deletionStr} your data will be preserved.

Best regards,
ComplyTrack
`.trim();

  return { subject, html, text };
}

// ── Early cancellation warning (webhook-triggered) ────────────────────────────

/**
 * Sends a best-effort warning email to the business's client admins and the
 * consultants who own or manage it when its Stripe subscription has just been
 * cancelled or scheduled to cancel at period end. Called from the Stripe
 * webhook handler; wrapped in try/catch by the caller so it never blocks the
 * webhook response.
 *
 * The email explains when access ends and prompts the user to export their
 * data before that date. When access has already ended (a cancellation after
 * failed payments), it says so instead.
 */
type SqlExecutor = (query: any) => Promise<{ rows?: unknown[] }>;

export interface CancellationWarningDependencies {
  /** Kept injectable so delivery behaviour can be regression-tested without Stripe or Postgres. */
  execute?: SqlExecutor;
  sendEmail?: typeof sendSystemEmail;
  getAppUrl?: () => string;
  now?: () => number;
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
    SELECT s.customer, ${SUBSCRIPTION_ACCESS_ENDS_AT} AS access_ends_at
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
    ORDER BY ${SUBSCRIPTION_ACCESS_ENDS_AT} DESC NULLS LAST, s.created DESC
    LIMIT 1
  `);
  return ((result.rows ?? [])[0] as CancellationCandidate | undefined) ?? null;
}

function parseStripeDate(value: string | number | null): Date | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

export async function sendCancellationWarningEmail(opts: {
  stripeCustomerId: string;
  /** ISO date string or Unix timestamp when access ends. */
  accessEndsAt: string | number | null;
}, deps: CancellationWarningDependencies = {}): Promise<{ emailsSent: number }> {
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  const execute: SqlExecutor = deps.execute ?? ((query) => db.execute(query) as Promise<{ rows?: unknown[] }>);
  const now = deps.now?.() ?? Date.now();

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

  // Client admins plus the consultants who own or manage the business: a
  // self-signup owner is a consultant and must hear that access is ending.
  const recipientRows = await execute(billingRecipientsQuery(client.id));
  const recipients = (recipientRows.rows ?? []) as { id: number; email: string; name: string }[];
  if (recipients.length === 0) return { emailsSent: 0 };

  // A notice without a known date is misleading; it will be retried after
  // Stripe supplies a period end.
  const accessEndsDate = parseStripeDate(cancellation.access_ends_at);
  if (!accessEndsDate) return { emailsSent: 0 };
  // Access already over (e.g. Stripe cancelled after failed payments): send a
  // "subscription ended" notice rather than suppressing the only message.
  const alreadyEnded = accessEndsDate.getTime() <= now;
  const accessEndsStr = formatUkDate(accessEndsDate);
  // A changed cutoff warrants a fresh notice; otherwise the same recipient is
  // sent at most once. An ended notice has its own key, so a warning that went
  // out before the cutoff is still followed by one ended notice at most.
  const cutoffKey = alreadyEnded ? `ended:${accessEndsDate.toISOString()}` : accessEndsDate.toISOString();

  const appUrl = deps.getAppUrl?.() ?? getPublicAppUrl();
  const settingsUrl = `${appUrl}/settings#data-export`;
  const billingUrl = `${appUrl}/settings#billing`;
  const safeCompany = escapeHtml(client.name);
  const subject = alreadyEnded
    ? "Your ComplyTrack subscription has ended — export your records"
    : "Your ComplyTrack access is ending — export your records";

  let sent = 0;
  for (const recipient of recipients) {
    // A delivery is deliberately never re-claimed while sending/handed_off.
    // Retrying an uncertain external side effect would be worse than requiring
    // intervention. Known provider rejections are returned to pending below.
    const leaseToken = randomUUID();
    const claim = await execute(sql`
      INSERT INTO cancellation_warning_deliveries
        (client_id, user_id, cutoff_key, claimed_at, state, lease_token, lease_expires_at)
      SELECT ${client.id}, ${recipient.id}, ${cutoffKey}, now(), 'sending', ${leaseToken},
        now() + interval '15 minutes'
      WHERE EXISTS (
        SELECT 1
        FROM stripe.subscriptions s
        WHERE s.customer = ${opts.stripeCustomerId}
          AND (s.status = 'canceled' OR s.cancel_at_period_end = true)
          -- Do not send a stale date if a concurrent Stripe update moved the
          -- cutoff after the initial read; that update will claim its own key.
          AND ${SUBSCRIPTION_ACCESS_ENDS_AT} = ${cancellation.access_ends_at}
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
      logger.error({ err, clientId: client.id, userId: recipient.id }, "Could not claim cancellation warning delivery");
      return { rows: [] };
    });
    const delivery = (claim.rows ?? [])[0] as { id: number; lease_token: string } | undefined;
    if (!delivery) continue;
    const safeName = escapeHtml(recipient.name ?? recipient.email);
    const html = alreadyEnded ? `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1e293b;">Your ComplyTrack subscription has ended</h2>
        <p>Hi ${safeName},</p>
        <p>The ComplyTrack subscription for <strong>${safeCompany}</strong> ended on
           <strong>${escapeHtml(accessEndsStr)}</strong>, so the account no longer has access to its compliance records.</p>
        <p>Your records are kept for ${RETENTION_MONTHS} months. You can
           <a href="${billingUrl}" style="color:#2563eb;">reactivate your subscription</a> at any time to restore access,
           and export your records from your account settings.</p>
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:20px;margin:20px 0;">
          <a href="${settingsUrl}"
             style="display:inline-block;background:#ea580c;color:white;text-decoration:none;
                    padding:12px 24px;border-radius:6px;font-weight:600;">
            Go to Settings &amp; Export
          </a>
        </div>
        <p>Best regards,<br><strong>ComplyTrack</strong></p>
      </div>` : `
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

    const text = alreadyEnded ? `
Your ComplyTrack subscription has ended

Hi ${recipient.name ?? recipient.email},

The ComplyTrack subscription for ${client.name} ended on ${accessEndsStr}, so the account no longer has access to its compliance records.

Your records are kept for ${RETENTION_MONTHS} months. Reactivate your subscription to restore access: ${billingUrl}

Export your records from your account settings:
${settingsUrl}

Best regards,
ComplyTrack
`.trim() : `
Your ComplyTrack subscription is being cancelled

Hi ${recipient.name ?? recipient.email},

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
              AND ${SUBSCRIPTION_ACCESS_ENDS_AT} = ${cancellation.access_ends_at}
              AND NOT EXISTS (
                SELECT 1 FROM stripe.subscriptions live
                 WHERE live.customer = s.customer
                   AND live.status IN ('active', 'trialing', 'past_due')
                   AND COALESCE(live.cancel_at_period_end, false) = false
              )
         )
      RETURNING id
    `).catch((err) => {
      logger.error({ err, clientId: client.id, userId: recipient.id }, "Could not persist cancellation warning handoff");
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
        to: recipient.email,
        subject,
        html,
        text,
        // Provider-level idempotency protects the known-error retry path too.
        idempotencyKey: `cancellation-warning:${client.id}:${recipient.id}:${cutoffKey}`,
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
      logger.warn({ err, clientId: client.id, recipientEmail: recipient.email }, "Cancellation warning email failed for recipient");
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
      logger.error({ err, clientId: client.id, userId: recipient.id },
        "Cancellation warning accepted but sent finalization failed");
    }
  }
  return { emailsSent: sent };
}

/**
 * Reconciles cancellation warnings missed while a Stripe webhook was down.
 * Stripe's synced subscription data is the billing source of truth; unlike
 * trial reminders this never uses trial dates or trial status. Subscriptions
 * that ended within the last week still get their (once-only) ended notice.
 */
export async function runCancellationWarningJob(
  deps: CancellationWarningDependencies = {},
): Promise<{ emailsSent: number }> {
  const execute: SqlExecutor = deps.execute ?? ((query) => db.execute(query) as Promise<{ rows?: unknown[] }>);
  const candidates = await execute(sql`
    WITH current_subscriptions AS (
      SELECT DISTINCT ON (c.id) c.id, s.customer, s.status, s.cancel_at_period_end,
        ${SUBSCRIPTION_ACCESS_ENDS_AT} AS access_ends_at
      FROM clients c
      JOIN stripe.subscriptions s ON s.customer = c.stripe_customer_id
      ORDER BY c.id, s.created DESC NULLS LAST
    )
    SELECT id, customer, access_ends_at
    FROM current_subscriptions
    WHERE (status = 'canceled' OR cancel_at_period_end = true)
      AND (access_ends_at > extract(epoch from now())
        OR (status = 'canceled' AND access_ends_at > extract(epoch from now() - interval '7 days')))
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

// ── Failed payment notice (webhook-triggered) ──────────────────────────────────

/**
 * One email per failed invoice to the business's billing recipients, so a
 * declined renewal is noticed before Stripe's retries run out and the
 * subscription is cancelled. Deduped per invoice across webhook retries.
 */
export async function sendPaymentFailedEmail(opts: {
  stripeCustomerId: string;
  invoiceId: string;
  amountDue: number | null;
  currency: string | null;
  hostedInvoiceUrl: string | null;
}, deps: { sendEmail?: typeof sendSystemEmail; getAppUrl?: () => string } = {}): Promise<{ emailsSent: number }> {
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  const clientRows = await db.execute(sql`
    SELECT id, name FROM clients WHERE stripe_customer_id = ${opts.stripeCustomerId} LIMIT 1
  `);
  const client = (clientRows.rows ?? [])[0] as { id: number; name: string } | undefined;
  if (!client) return { emailsSent: 0 };
  const claim = await claimEmailDelivery("payment-failed", `${client.id}:${opts.invoiceId}`);
  if (!claim) return { emailsSent: 0 };
  let sent = 0;
  try {
    const recipients = (await db.execute(billingRecipientsQuery(client.id))).rows as { id: number; email: string; name: string }[];
    const appUrl = deps.getAppUrl?.() ?? getPublicAppUrl();
    const billingUrl = `${appUrl}/settings#billing`;
    const amount = opts.amountDue !== null && opts.currency
      ? new Intl.NumberFormat("en-GB", { style: "currency", currency: opts.currency.toUpperCase() }).format(opts.amountDue / 100)
      : null;
    const subject = "Action needed: your ComplyTrack payment failed";
    const payLink = opts.hostedInvoiceUrl && /^https:\/\//.test(opts.hostedInvoiceUrl) ? opts.hostedInvoiceUrl : billingUrl;
    for (const recipient of recipients) {
      const safeName = escapeHtml(recipient.name ?? recipient.email);
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">We couldn't take your ComplyTrack payment</h2>
          <p>Hi ${safeName},</p>
          <p>A payment${amount ? ` of <strong>${escapeHtml(amount)}</strong>` : ""} for the ComplyTrack subscription for
             <strong>${escapeHtml(client.name)}</strong> failed. Stripe will retry it automatically, but if it keeps failing
             the subscription will be cancelled and access will end.</p>
          <p><a href="${escapeHtml(payLink)}" style="display:inline-block;background:#4f46e5;color:white;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Update payment details</a></p>
          <p style="color:#64748b;font-size:13px;">You can also manage your payment method from Settings → Billing: ${escapeHtml(billingUrl)}</p>
          <p>Best regards,<br><strong>ComplyTrack</strong></p>
        </div>`;
      const text = `We couldn't take your ComplyTrack payment

Hi ${recipient.name ?? recipient.email},

A payment${amount ? ` of ${amount}` : ""} for the ComplyTrack subscription for ${client.name} failed. Stripe will retry it automatically, but if it keeps failing the subscription will be cancelled and access will end.

Update your payment details: ${payLink}
Or manage billing in Settings: ${billingUrl}

Best regards,
ComplyTrack`;
      try {
        await sendEmail({
          to: recipient.email, subject, html, text,
          idempotencyKey: emailDeliveryIdempotencyKey(claim, recipient.id),
        });
        sent++;
      } catch (err) {
        logger.warn({ err, clientId: client.id, userId: recipient.id }, "Payment failed email could not be sent");
      }
    }
  } finally {
    if (sent > 0) await markEmailDeliverySent(claim).catch(() => {});
    else await settleEmailDelivery(claim).catch(() => {});
  }
  return { emailsSent: sent };
}

// ── Job 1: Cancellation detection ─────────────────────────────────────────────

type LiveSubscriptionLookup = (customerId: string) => Promise<unknown | null>;

export interface CancellationDetectionDependencies {
  findLiveSubscription?: LiveSubscriptionLookup;
  sendEmail?: typeof sendSystemEmail;
  /** Synced Stripe subscription history for a customer (any rows / a canceled one). */
  getSubscriptionHistory?: (customerId: string) => Promise<{ any: boolean; canceled: boolean }>;
  /** Optional fixture scope for tests; omitted by the production scheduler. */
  clientIds?: readonly number[];
}

async function getSubscriptionHistory(customerId: string): Promise<{ any: boolean; canceled: boolean }> {
  const rows = await db.execute(sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled
    FROM stripe.subscriptions WHERE customer = ${customerId}
  `);
  const row = (rows.rows[0] ?? {}) as { total?: number; canceled?: number };
  return { any: Number(row.total ?? 0) > 0, canceled: Number(row.canceled ?? 0) > 0 };
}

/** Clear the retention clock when a client has a live subscription again. */
export async function clearRetentionSchedule(clientId: number): Promise<boolean> {
  const cleared = await db.execute(sql`
    UPDATE clients
       SET cancelled_at = NULL,
           data_deletion_scheduled_at = NULL,
           offboarding_email_sent_at = NULL,
           updated_at = now()
     WHERE id = ${clientId}
       AND data_deleted_at IS NULL
       AND (cancelled_at IS NOT NULL OR data_deletion_scheduled_at IS NOT NULL)
    RETURNING id
  `);
  const changed = (cleared.rows ?? []).length > 0;
  if (changed) logger.info({ clientId }, "Live subscription found — retention clock cleared");
  return changed;
}

/**
 * Finds clients whose Stripe subscription is fully cancelled, or whose free
 * trial ended without ever subscribing, and who haven't been stamped with
 * cancelled_at yet. Sets the retention clock and sends the offboarding email
 * (one-shot, deduped via offboarding_email_sent_at). A Stripe lookup error
 * skips that client (fail closed): nobody is scheduled for deletion on a
 * guess. Clients with a live subscription have any old stamps cleared.
 */
export async function runCancellationDetectionJob(deps: CancellationDetectionDependencies = {}): Promise<{
  clientsDetected: number;
  trialsLapsed: number;
  clientsReactivated: number;
  emailsSent: number;
  skipped: number;
}> {
  const findLive = deps.findLiveSubscription ?? findLiveSubscription;
  const history = deps.getSubscriptionHistory ?? getSubscriptionHistory;
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  const scope = deps.clientIds === undefined ? undefined : inArray(clientsTable.id, [...deps.clientIds]);
  let clientsDetected = 0;
  let trialsLapsed = 0;
  let clientsReactivated = 0;
  let emailsSent = 0;
  let skipped = 0;
  const now = new Date();

  // Not yet deleted: either unstamped, or stamped and possibly resubscribed.
  const candidates = deps.clientIds?.length === 0 ? [] : await db
    .select()
    .from(clientsTable)
    .where(and(scope, isNull(clientsTable.dataDeletedAt)));

  for (const client of candidates) {
    try {
      const customerId = client.stripeCustomerId;
      // Only self-service trials lapse into the retention clock; a locally
      // managed account (e.g. status "active" without Stripe) never does.
      const onTrial = client.subscriptionStatus === null || client.subscriptionStatus === "trial" || client.subscriptionStatus === "trialing";
      const trialLapsed = onTrial && client.trialEndsAt !== null && client.trialEndsAt.getTime() <= now.getTime();
      if (!customerId && !trialLapsed) continue;
      // Nothing to decide for an unstamped client that has neither a Stripe
      // customer nor a lapsed trial; stamped clients are always re-checked.
      let live: unknown | null = null;
      if (customerId) {
        try {
          live = await findLive(customerId);
        } catch (err) {
          skipped++;
          logger.warn({ err, clientId: client.id }, "Cancellation detection: Stripe lookup failed; client skipped");
          continue;
        }
      }
      if (live) {
        if (await clearRetentionSchedule(client.id)) clientsReactivated++;
        continue;
      }
      if (client.cancelledAt) continue; // already counting down

      let reason: "cancelled" | "trial_ended";
      let endedAt: Date;
      if (customerId) {
        let subs: { any: boolean; canceled: boolean };
        try {
          subs = await history(customerId);
        } catch (err) {
          skipped++;
          logger.warn({ err, clientId: client.id }, "Cancellation detection: subscription history unavailable; client skipped");
          continue;
        }
        if (subs.canceled) {
          reason = "cancelled";
          endedAt = now;
        } else if (!subs.any && trialLapsed) {
          reason = "trial_ended";
          endedAt = client.trialEndsAt!;
        } else {
          // e.g. an incomplete first checkout: not an ended paid subscription.
          continue;
        }
      } else {
        reason = "trial_ended";
        endedAt = client.trialEndsAt!;
      }

      const deletionDate = addMonths(endedAt, RETENTION_MONTHS);
      // Claim atomically — WHERE cancelled_at IS NULL prevents double-firing.
      const claimed = await db.execute(sql`
        UPDATE clients
           SET cancelled_at               = ${endedAt},
               data_deletion_scheduled_at = ${deletionDate},
               updated_at                 = ${now}
         WHERE id = ${client.id}
           AND cancelled_at IS NULL
           AND data_deleted_at IS NULL
        RETURNING id
      `);
      if ((claimed.rows ?? []).length === 0) continue; // Another process claimed it.

      if (reason === "trial_ended") trialsLapsed++;
      else clientsDetected++;
      logger.info({ clientId: client.id, deletionDate, reason }, "Retention clock started");

      // Send offboarding email once.
      if (client.offboardingEmailSentAt) continue;

      const recipients = await getClientRecipients(client.id);
      const settingsUrl = `${getPublicAppUrl()}/settings#data-export`;
      let sent = 0;

      for (const r of recipients) {
        try {
          const { subject, html, text } = buildOffboardingEmail({
            recipientName: r.name ?? r.email,
            companyName: client.name,
            deletionDate,
            settingsUrl,
            reason,
          });
          await sendEmail({
            to: r.email, subject, html, text,
            idempotencyKey: `offboarding:${client.id}:${deletionDate.toISOString()}:${r.id}`,
          });
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
      skipped++;
      logger.error({ err, clientId: client.id }, "Cancellation detection error for client");
    }
  }

  return { clientsDetected, trialsLapsed, clientsReactivated, emailsSent, skipped };
}

// ── Job 2: Hard data deletion ──────────────────────────────────────────────────

type TxExecutor = Pick<typeof db, "execute">;

/**
 * Deletes a client's stored files inside the deletion transaction (see
 * clientStorageErasure.ts). objectsSkipped counts referenced files left in
 * place because their ACL does not mark them as this tenant's private object
 * (unmarked, another tenant's, or a retained RIDDOR receipt).
 */
export type ClientStorageEraser = (clientId: number, executor: TxExecutor) => Promise<{ objectsDeleted: number; objectsSkipped?: number }>;

/**
 * Thrown by an eraser that fails part-way. Provider deletes cannot be rolled
 * back with the transaction, so the failed outcome records how many files had
 * already gone.
 */
export class ClientStorageErasureError extends Error {
  constructor(message: string, readonly objectsDeleted: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClientStorageErasureError";
  }
}

/** The fixed minimum wait between an account erasure request and its execution. */
export const ACCOUNT_ERASURE_MIN_WAIT_DAYS = 30;

/**
 * An account erasure request (aliased `r`) that may be executed now: approved
 * by a recorded reviewer other than the requester, past its earliest deletion
 * date, and at least 30 days after it was made. Checked again at execution
 * time so a back-dated earliest date or a self-approval written outside the
 * review route still cannot run.
 */
const APPROVED_ERASURE_READY_SQL = `(
  r.status = 'approved'
  AND r.reviewed_by IS NOT NULL AND r.reviewed_at IS NOT NULL
  AND r.reviewed_by IS DISTINCT FROM r.requested_by
  AND r.earliest_deletion_at <= now()
  AND r.requested_at + interval '${ACCOUNT_ERASURE_MIN_WAIT_DAYS} days' <= now()
)`;
export const APPROVED_ERASURE_REQUEST_READY = sql.raw(APPROVED_ERASURE_READY_SQL);

/** An open request (aliased `r`) that blocks every deletion path until it is ready. */
export const ERASURE_REQUEST_BLOCKING = sql.raw(
  `(r.status = 'pending' OR (r.status = 'approved' AND NOT ${APPROVED_ERASURE_READY_SQL}))`,
);

/**
 * How many stored files a client still has to erase (ledger rows plus
 * attachment references). HSE receipts stay with the retained RIDDOR events
 * (see RETAINED_CLIENT_TABLES), so they are not counted.
 */
export async function countClientStoredObjects(clientId: number, executor: TxExecutor = db): Promise<number> {
  const result = await executor.execute(sql`
    SELECT (SELECT COUNT(*) FROM storage_usage_objects WHERE client_id = ${clientId} AND present
      AND object_path NOT IN (SELECT receipt_object_path FROM incident_riddor_events
        WHERE client_id = ${clientId} AND receipt_object_path IS NOT NULL))::int AS ledger
  `);
  const ledger = Number((result.rows[0] as { ledger?: number } | undefined)?.ledger ?? 0);
  const { listTenantAttachmentObjectPaths } = await import("./attachmentReferences");
  const { listRetainedRiddorReceiptPaths } = await import("./riddorReceipts");
  const retained = new Set(await listRetainedRiddorReceiptPaths(executor, clientId));
  return ledger + (await listTenantAttachmentObjectPaths(executor, clientId)).filter((path) => !retained.has(path)).length;
}

/**
 * Without an eraser (tests, tools) deletion proceeds only when the client has
 * no stored files; otherwise it fails closed rather than orphan them.
 */
const refuseStoredFiles: ClientStorageEraser = async (clientId, executor) => {
  if (await countClientStoredObjects(clientId, executor) === 0) return { objectsDeleted: 0 };
  throw new Error("This client still has stored files and no storage eraser was supplied");
};

export interface DataDeletionDependencies {
  /** Deletes the client's stored files; the scheduler passes eraseClientStorageObjects. */
  eraseStorage?: ClientStorageEraser;
  findLiveSubscription?: LiveSubscriptionLookup;
  sendEmail?: typeof sendSystemEmail;
  /** Optional fixture scope for tests; omitted by the production scheduler. */
  clientIds?: readonly number[];
}

/**
 * Hard-deletes all compliance records and stored files for clients whose
 * 12-month retention window has passed (or whose approved erasure request is
 * due). The client row itself is kept (with data_deleted_at set) to preserve
 * the audit trail. Users are anonymised rather than deleted.
 *
 * Each client is deleted in one transaction under the per-client erasure lock;
 * any error rolls that client back untouched (no data_deleted_at), and the run
 * then fails — alerting via ADMIN_EMAIL, the job monitor and Sentry — so the
 * client is retried the next day.
 *
 * Every attempt that passes the guard leaves one append-only row in
 * client_data_deletion_outcomes: "completed" in the deletion transaction
 * itself, or "failed" (with any files already removed) after the rollback.
 */
export async function runDataDeletionJob(deps: DataDeletionDependencies = {}): Promise<{ clientsDeleted: number }> {
  const eraseStorage = deps.eraseStorage ?? refuseStoredFiles;
  const findLive = deps.findLiveSubscription ?? findLiveSubscription;
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  let clientsDeleted = 0;
  const failed: Array<{ id: number; name: string }> = [];
  const now = new Date();
  if (deps.clientIds?.length === 0) return { clientsDeleted };
  const scope = deps.clientIds === undefined ? sql`` : sql`AND c.id IN (${sql.join(deps.clientIds.map((id) => sql`${id}`), sql`, `)})`;

  const due = await db.execute(sql`
    SELECT c.id, c.name, c.stripe_customer_id,
      (c.data_deletion_scheduled_at IS NOT NULL AND c.data_deletion_scheduled_at <= now()) AS retention_due,
      EXISTS (
        SELECT 1 FROM client_data_deletion_requests r
        WHERE r.client_id = c.id AND ${APPROVED_ERASURE_REQUEST_READY}
      ) AS request_due
    FROM clients c
    WHERE c.data_deleted_at IS NULL
      AND ((c.data_deletion_scheduled_at IS NOT NULL AND c.data_deletion_scheduled_at <= now())
        OR EXISTS (
          SELECT 1 FROM client_data_deletion_requests r
          WHERE r.client_id = c.id AND ${APPROVED_ERASURE_REQUEST_READY}
        ))
      ${scope}
  `);

  for (const client of due.rows as Array<{ id: number; name: string; stripe_customer_id: string | null; retention_due: boolean; request_due: boolean }>) {
    // Set once the guard passes; `as` keeps TypeScript from narrowing it to null.
    let attempt = null as DeletionAttempt | null;
    try {
      // A retention-only deletion is never run against a paying customer: if
      // they resubscribed, the clock is cleared instead. A Stripe error leaves
      // the client for tomorrow (fail closed).
      if (client.retention_due && !client.request_due && client.stripe_customer_id) {
        const live = await findLive(client.stripe_customer_id);
        if (live) {
          await clearRetentionSchedule(client.id);
          continue;
        }
      }
      // Submission, review and direct client deletion use the same per-client
      // lock. Recheck approval, the 30-day wait and legal holds after
      // acquiring it, then hold it until the deletion and outcome commit.
      const deleted = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(106, ${client.id})`);
        const guard = await tx.execute(sql`
          SELECT c.id, clock_timestamp() AS started_at,
            (SELECT r.id FROM client_data_deletion_requests r
              WHERE r.client_id = c.id AND ${APPROVED_ERASURE_REQUEST_READY}
              ORDER BY r.id LIMIT 1) AS request_id,
            (SELECT r.reviewed_by FROM client_data_deletion_requests r
              WHERE r.client_id = c.id AND ${APPROVED_ERASURE_REQUEST_READY}
              ORDER BY r.id LIMIT 1) AS reviewed_by
          FROM clients c WHERE c.id = ${client.id}
            AND c.data_deleted_at IS NULL
            AND ((c.data_deletion_scheduled_at IS NOT NULL AND c.data_deletion_scheduled_at <= now())
              OR EXISTS (SELECT 1 FROM client_data_deletion_requests r
                WHERE r.client_id = c.id AND ${APPROVED_ERASURE_REQUEST_READY}))
            AND NOT EXISTS (SELECT 1 FROM client_data_deletion_requests r
              WHERE r.client_id = c.id AND ${ERASURE_REQUEST_BLOCKING})
            AND NOT EXISTS (SELECT 1 FROM privacy_retention_schedules h
              WHERE h.client_id = c.id AND h.active = true
                AND (h.legal_hold_active = true OR h.deletion_exception = true))
        `);
        const ready = guard.rows[0] as { started_at: string | Date; request_id: number | null; reviewed_by: number | null } | undefined;
        if (!ready) return false;
        attempt = {
          startedAt: new Date(ready.started_at),
          requestId: ready.request_id === null ? null : Number(ready.request_id),
          reviewedBy: ready.reviewed_by === null ? null : Number(ready.reviewed_by),
          reason: ready.request_id === null ? "retention_schedule" : "approved_request",
        };
        logger.info({ clientId: client.id, reason: attempt.reason }, "Starting data deletion for client");
        // Files first: their references are read from rows deleted below.
        const storage = await eraseStorage(client.id, tx);
        const rows = await deleteAllClientData(client.id, tx);
        await tx.execute(sql`
          UPDATE clients SET data_deleted_at = ${now}, updated_at = ${now}
          WHERE id = ${client.id}
        `);
        await tx.execute(sql`
          UPDATE client_data_deletion_requests SET status = 'completed'
          WHERE client_id = ${client.id} AND status = 'approved'
        `);
        await recordDeletionOutcome(tx, client.id, attempt, {
          outcome: "completed",
          rowsDeleted: rows.rowsDeleted,
          objectsDeleted: storage.objectsDeleted,
          objectsSkipped: storage.objectsSkipped ?? 0,
        });
        logger.info({ clientId: client.id, rowsDeleted: rows.rowsDeleted, objectsDeleted: storage.objectsDeleted, objectsSkipped: storage.objectsSkipped ?? 0 }, "Client data deletion committed");
        return true;
      });
      if (!deleted) {
        logger.info({ clientId: client.id }, "Scheduled deletion deferred for review, retention window or legal hold");
        continue;
      }
      clientsDeleted++;
      logger.info({ clientId: client.id }, "Client data permanently deleted");

      // Notify system admin.
      const adminEmail = process.env.ADMIN_EMAIL?.trim();
      if (adminEmail) {
        const safeCompany = escapeHtml(client.name);
        const basis = attempt?.reason === "approved_request"
          ? "following its reviewed and approved account deletion request"
          : `as scheduled under the ${RETENTION_MONTHS}-month data retention policy`;
        await sendEmail({
          to: adminEmail,
          subject: `ComplyTrack: data deleted for ${client.name} (id ${client.id})`,
          html: `<p>All compliance records and stored files for <strong>${safeCompany}</strong> (client id ${client.id}) have been permanently deleted ${basis}.</p>`,
          text: `All compliance records and stored files for ${client.name} (client id ${client.id}) have been permanently deleted ${basis}.`,
        }).catch((err) => logger.error({ err }, "Deletion confirmation email failed"));
      } else {
        logger.error({ clientId: client.id }, "ADMIN_EMAIL not configured — data-deletion confirmation email was not sent");
      }
    } catch (err) {
      failed.push({ id: client.id, name: client.name });
      logger.error({ err, clientId: client.id }, "Data deletion failed for client — records were rolled back; will retry tomorrow");
      if (attempt) {
        await recordDeletionOutcome(db, client.id, attempt, {
          outcome: "failed",
          rowsDeleted: 0,
          objectsDeleted: err instanceof ClientStorageErasureError ? err.objectsDeleted : 0,
          objectsSkipped: 0,
          error: err instanceof Error ? err.message : String(err),
        }).catch((recordErr) => logger.error({ err: recordErr, clientId: client.id }, "Could not record the failed deletion outcome"));
      }
    }
  }

  if (failed.length > 0) {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    if (adminEmail) {
      const list = failed.map((c) => `${c.name} (id ${c.id})`);
      await sendEmail({
        to: adminEmail,
        subject: `ComplyTrack: scheduled data deletion failed for ${failed.length} client${failed.length === 1 ? "" : "s"}`,
        html: `<p>Scheduled data deletion failed and was rolled back for:</p><ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul><p>No records were deleted for these clients; stored files removed before the failure are listed in client_data_deletion_outcomes. The job retries daily; check the logs for the cause.</p>`,
        text: `Scheduled data deletion failed and was rolled back for:\n${list.map((item) => `- ${item}`).join("\n")}\n\nNo records were deleted for these clients; stored files removed before the failure are listed in client_data_deletion_outcomes. The job retries daily; check the logs for the cause.`,
      }).catch((err) => logger.error({ err }, "Deletion failure alert email failed"));
    }
    throw new Error(`Data deletion failed for ${failed.length} client(s): ${failed.map((c) => c.id).join(", ")}`);
  }
  return { clientsDeleted };
}

type DeletionAttempt = {
  startedAt: Date;
  requestId: number | null;
  reviewedBy: number | null;
  reason: "approved_request" | "retention_schedule";
};

/** Appends the durable outcome of one deletion attempt (the table is insert-only). */
async function recordDeletionOutcome(
  executor: TxExecutor,
  clientId: number,
  attempt: DeletionAttempt,
  result: { outcome: "completed" | "failed"; rowsDeleted: number; objectsDeleted: number; objectsSkipped: number; error?: string },
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO client_data_deletion_outcomes
      (client_id, request_id, reason, approved_by, outcome, started_at, finished_at,
       rows_deleted, objects_deleted, objects_skipped, error)
    VALUES (${clientId}, ${attempt.requestId}, ${attempt.reason}, ${attempt.reviewedBy}, ${result.outcome},
      ${attempt.startedAt}, clock_timestamp(), ${result.rowsDeleted}, ${result.objectsDeleted}, ${result.objectsSkipped},
      ${result.error ? result.error.slice(0, 1000) : null})
  `);
}

// ── deleteAllClientData ────────────────────────────────────────────────────────

/**
 * Tables holding client_id that are deliberately not emptied:
 * - audit_log, audit_events: append-only inspection evidence. Source deletes
 *   append redacted diffs; purging this history needs a separately authorised
 *   evidence-retention decision.
 * - incident_riddor_events: append-only RIDDOR decision/submission history
 *   (RIDDOR reg. 12 requires records for at least 3 years). The incidents it
 *   references are kept with it (RESTRICT foreign key); every other incident
 *   is deleted. HSE receipt files bound to its events are kept too.
 * - client_data_deletion_requests, client_data_deletion_outcomes: the record
 *   that this erasure was requested, reviewed and carried out (append-only).
 * - users: anonymised in place below (audit rows reference them).
 */
export const RETAINED_CLIENT_TABLES: ReadonlySet<string> = new Set([
  "audit_log", "audit_events", "incident_riddor_events", "client_data_deletion_requests",
  "client_data_deletion_outcomes", "users",
]);

async function listClientScopedTables(tx: TxExecutor): Promise<string[]> {
  const result = await tx.execute(sql`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'client_id' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  `);
  return (result.rows as Array<{ table_name: string }>).map((row) => row.table_name);
}

/** Order tables so rows that reference another table's rows are deleted first. */
async function orderChildrenFirst(tx: TxExecutor, tables: string[]): Promise<string[]> {
  const fks = await tx.execute(sql`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public' AND con.conrelid <> con.confrelid
  `);
  const set = new Set(tables);
  // parent -> children that reference it
  const children = new Map<string, Set<string>>();
  for (const { child, parent } of fks.rows as Array<{ child: string; parent: string }>) {
    if (!set.has(child) || !set.has(parent)) continue;
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent)!.add(child);
  }
  const ordered: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (table: string) => {
    if (state.get(table)) return; // done, or a cycle (resolved by retries)
    state.set(table, "visiting");
    for (const child of children.get(table) ?? []) visit(child);
    state.set(table, "done");
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
}

function deleteClientRows(table: string, cid: number) {
  if (table === "incidents") {
    // Incidents with RIDDOR history stay with that statutory record.
    return sql`DELETE FROM incidents WHERE client_id = ${cid}
      AND NOT EXISTS (SELECT 1 FROM incident_riddor_events e WHERE e.incident_id = incidents.id)`;
  }
  return sql`DELETE FROM ${sql.identifier(table)} WHERE client_id = ${cid}`;
}

/**
 * Deletes every row belonging to a client from every table with a client_id
 * column (discovered from information_schema, so new tables are covered
 * automatically), plus rows keyed by its users' ids, then anonymises those
 * users. Runs inside the caller's transaction (or its own); any failure
 * throws and rolls the whole deletion back. Afterwards it verifies that no
 * client row remains outside RETAINED_CLIENT_TABLES.
 */
export async function deleteAllClientData(
  cid: number,
  executor?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<{ rowsDeleted: number }> {
  if (!executor) return db.transaction((tx) => deleteAllClientData(cid, tx));
  const tx = executor;
  const tables = (await listClientScopedTables(tx)).filter((table) => !RETAINED_CLIENT_TABLES.has(table));
  const ordered = await orderChildrenFirst(tx, tables);

  // The client's own users are anonymised (audit rows reference them). A
  // consultant who still manages another business keeps their account; only
  // their link to this one is removed with consultant_clients below.
  const userRows = await tx.execute(sql`
    SELECT u.id FROM users u
    WHERE u.client_id = ${cid}
      AND NOT EXISTS (
        SELECT 1 FROM consultant_clients cc JOIN clients other ON other.id = cc.client_id
        WHERE cc.user_id = u.id AND cc.client_id <> ${cid} AND other.data_deleted_at IS NULL)
  `);
  const userIds = (userRows.rows as Array<{ id: number }>).map((row) => Number(row.id));

  let rowsDeleted = 0;
  if (userIds.length > 0) {
    // Credentials and devices of those users held in tables without a
    // client_id (passkeys, recovery codes, mobile sessions, reset tokens...).
    const userKeyed = await tx.execute(sql`
      SELECT child.relname AS table_name, a.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND con.confrelid = 'users'::regclass AND n.nspname = 'public'
        AND cardinality(con.conkey) = 1
        AND NOT EXISTS (SELECT 1 FROM pg_attribute ca
          WHERE ca.attrelid = con.conrelid AND ca.attname = 'client_id' AND NOT ca.attisdropped)
    `);
    const idList = sql.join(userIds.map((id) => sql`${id}`), sql`, `);
    for (const { table_name, column_name } of userKeyed.rows as Array<{ table_name: string; column_name: string }>) {
      const result = await tx.execute(sql`
        DELETE FROM ${sql.identifier(table_name)} WHERE ${sql.identifier(column_name)} IN (${idList})
      `);
      rowsDeleted += result.rowCount ?? 0;
    }
    // Signed-in web sessions of those users.
    const sessions = await tx.execute(sql`
      DELETE FROM sessions WHERE (sess->>'userId') IN (${sql.join(userIds.map((id) => sql`${String(id)}`), sql`, `)})
    `);
    rowsDeleted += sessions.rowCount ?? 0;
  }

  // Children first; a statement blocked by a reference or an append-only
  // guard (cleared once its parent goes) is retried in a later pass. A pass
  // that makes no progress fails the deletion.
  let pending = ordered;
  while (pending.length > 0) {
    const blocked: string[] = [];
    let lastError: unknown = null;
    for (const table of pending) {
      try {
        const result = await tx.transaction((savepoint) => savepoint.execute(deleteClientRows(table, cid)));
        rowsDeleted += result.rowCount ?? 0;
      } catch (err) {
        blocked.push(table);
        lastError = err;
      }
    }
    if (blocked.length === pending.length) {
      throw new Error(`Client data deletion is blocked on: ${blocked.join(", ")}`, { cause: lastError });
    }
    pending = blocked;
  }

  // ─ Users: anonymise to preserve audit trail rather than hard-delete ───────
  if (userIds.length > 0) {
    await tx.execute(sql`
      UPDATE users SET
        active        = false,
        email         = 'deleted-' || id || '@deleted.invalid',
        password_hash = '',
        name          = 'Deleted User',
        totp_secret   = NULL,
        totp_enabled  = false,
        totp_recovery_hash = NULL,
        updated_at    = NOW()
      WHERE id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
    `);
    // The verification columns always exist (runtime migrations). No .catch:
    // a swallowed error would leave this transaction aborted.
    await tx.execute(sql`
      UPDATE users SET email_verification_token = NULL, email_verification_expires_at = NULL
      WHERE id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})
    `);
  }

  // Fail closed if anything is left behind (e.g. a new table whose rows a
  // trigger re-creates). RIDDOR-reported incidents are the one exception.
  const leftovers: string[] = [];
  for (const table of tables) {
    const remaining = await tx.execute(table === "incidents"
      ? sql`SELECT count(*)::int AS n FROM incidents WHERE client_id = ${cid}
          AND NOT EXISTS (SELECT 1 FROM incident_riddor_events e WHERE e.incident_id = incidents.id)`
      : sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE client_id = ${cid}`);
    if (Number((remaining.rows[0] as { n: number }).n) > 0) leftovers.push(table);
  }
  if (leftovers.length > 0) throw new Error(`Client data deletion left rows in: ${leftovers.join(", ")}`);
  return { rowsDeleted };
}
