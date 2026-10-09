/**
 * Durable delivery of the security alert sent after an administrator resets a
 * user's two-factor authentication.
 *
 * The reset and the queued alert commit in one transaction, so a provider
 * outage or a process restart cannot silently drop the alert, and an email
 * failure never undoes or repeats the reset. The route makes one immediate
 * attempt; a recovery job retries anything still pending with backoff.
 *
 * Delivery follows the restart-safe pattern used for other outboxes:
 * - a worker takes an expiring lease ("sending" + claim token) before calling
 *   the provider, so concurrent workers cannot both send, and an abandoned
 *   lease is reclaimed after it expires;
 * - every attempt for one alert uses the same provider idempotency key, so a
 *   retry after an uncertain outcome (accepted, then timed out) is deduplicated
 *   by the provider instead of delivering twice;
 * - an alert unconfirmed beyond the provider's idempotency window is expired
 *   (and logged) rather than replayed without dedupe.
 *
 * Privacy: the outbox stores only the user id, a random delivery key and the
 * reset time. The message is rendered at send time from the user's record and
 * contains no authenticator secret, recovery code, hash or token. The provider
 * key includes a digest of the rendered content, so if the recipient's name or
 * address changes between attempts the provider is never handed a reused key
 * with a different payload (which Resend rejects).
 */

import { createHash, randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { usersTable, twoFactorResetNotificationsTable as alertsTable } from "@workspace/db/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { logger } from "./logger";
import { buildTwoFactorResetEmail, sendSystemEmail } from "./email";

/** An abandoned worker's lease may be reclaimed after this. */
export const TWO_FACTOR_RESET_ALERT_LEASE_MINUTES = 10;
/**
 * The route makes the first attempt; recovery waits this long before taking a
 * fresh alert so it does not race the request that queued it.
 */
export const TWO_FACTOR_RESET_ALERT_GRACE_MINUTES = 2;
/** Resend remembers idempotency keys for 24 hours; replay only inside that. */
const PROVIDER_IDEMPOTENCY_WINDOW_HOURS = 23;
/** Retry backoff after a failed attempt, in minutes, by attempt number. */
const RETRY_BACKOFF_MINUTES = [1, 2, 5, 10, 15, 30];

export type TwoFactorResetAlertSender = typeof sendSystemEmail;

export interface TwoFactorResetResult {
  user: { id: number; email: string; name: string };
  /** Queued alert id, or null when the reset changed nothing (a retried request). */
  alertId: number | null;
}

/**
 * Clear the user's two-factor enrolment and, only if anything was actually
 * cleared, queue the security alert in the same transaction. A repeated
 * request for an already-reset account therefore queues no second alert.
 */
export async function resetTwoFactorWithAlert(userId: number): Promise<TwoFactorResetResult | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        totpEnabled: usersTable.totpEnabled,
        hasSecret: sql<boolean>`${usersTable.totpSecret} IS NOT NULL`,
        hasRecoveryHash: sql<boolean>`${usersTable.totpRecoveryHash} IS NOT NULL`,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .for("update");
    if (!before) return null;
    const hadTwoFactor = before.totpEnabled || before.hasSecret || before.hasRecoveryHash;

    const resetAt = new Date();
    const [user] = await tx.update(usersTable)
      .set({ totpSecret: null, totpEnabled: false, totpRecoveryHash: null, updatedAt: resetAt })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name });
    if (!user) return null;
    if (!hadTwoFactor) return { user, alertId: null };

    // At most one open alert per user: a second reset while one is still
    // undelivered is covered by that alert rather than queuing another.
    const [alert] = await tx.insert(alertsTable)
      .values({
        userId: user.id,
        deliveryKey: `two-factor-reset-${randomUUID()}`,
        resetAt,
        status: "pending",
        nextAttemptAt: sql`now() + (${TWO_FACTOR_RESET_ALERT_GRACE_MINUTES} * interval '1 minute')`,
      })
      .onConflictDoNothing()
      .returning({ id: alertsTable.id });
    return { user, alertId: alert?.id ?? null };
  });
}

/** Provider idempotency key: stable per alert and rendered content. */
export function twoFactorResetProviderKey(deliveryKey: string, message: { to: string; subject: string; text: string; html: string }): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([message.to, message.subject, message.text, message.html]))
    .digest("hex")
    .slice(0, 24);
  return `${deliveryKey}-${digest}`;
}

function clock(offsetSeconds: number): SQL {
  return offsetSeconds ? sql`(now() + (${offsetSeconds} * interval '1 second'))` : sql`now()`;
}

export type TwoFactorResetDeliveryOutcome = "sent" | "skipped" | "expired";

/**
 * Lease one alert and hand it to the provider. "skipped" means another worker
 * holds it or it is already finished. A send failure releases the lease with
 * backoff and rethrows; the alert stays queued for recovery.
 */
export async function deliverTwoFactorResetAlert(
  alertId: number,
  deps: { sendEmail?: TwoFactorResetAlertSender; clockOffsetSeconds?: number; requireDue?: boolean } = {},
): Promise<TwoFactorResetDeliveryOutcome> {
  const send = deps.sendEmail ?? sendSystemEmail;
  const now = clock(deps.clockOffsetSeconds ?? 0);
  const claimToken = randomUUID();
  const dueCondition = deps.requireDue ? sql`AND next_attempt_at <= ${now}` : sql``;

  const leased = await db.execute(sql`
    UPDATE two_factor_reset_notifications
    SET status = 'sending', claim_token = ${claimToken}, attempts = attempts + 1, updated_at = ${now}
    WHERE id = ${alertId}
      AND (
        (status = 'pending' ${dueCondition})
        OR (status = 'sending' AND updated_at < ${now} - (${TWO_FACTOR_RESET_ALERT_LEASE_MINUTES} * interval '1 minute'))
      )
    RETURNING id, user_id, delivery_key, reset_at, attempts,
      created_at < ${now} - (${PROVIDER_IDEMPOTENCY_WINDOW_HOURS} * interval '1 hour') AS expired
  `);
  const row = (leased.rows ?? [])[0] as
    | { id: number; user_id: number; delivery_key: string; attempts: number; expired: boolean }
    | undefined;
  if (!row) return "skipped";

  if (row.expired) {
    await db.update(alertsTable)
      .set({ status: "expired", claimToken: null, updatedAt: sql`${now}` })
      .where(and(eq(alertsTable.id, row.id), eq(alertsTable.claimToken, claimToken)));
    logger.error({ alertId: row.id, userId: row.user_id },
      "Two-factor reset security notification stayed undelivered beyond the provider idempotency window");
    return "expired";
  }

  // Render at send time from the user's record and the stored reset time.
  // Read reset_at through Drizzle so it maps exactly like users.updated_at.
  const [details] = await db
    .select({ email: usersTable.email, name: usersTable.name, resetAt: alertsTable.resetAt })
    .from(alertsTable)
    .innerJoin(usersTable, eq(usersTable.id, alertsTable.userId))
    .where(eq(alertsTable.id, row.id));
  if (!details) return "skipped"; // user deleted: the row cascades away
  const message = buildTwoFactorResetEmail({ to: details.email, name: details.name, resetAt: details.resetAt });

  try {
    await send({ ...message, idempotencyKey: twoFactorResetProviderKey(row.delivery_key, message) });
  } catch (err) {
    const backoff = RETRY_BACKOFF_MINUTES[Math.min(row.attempts, RETRY_BACKOFF_MINUTES.length) - 1];
    await db.update(alertsTable)
      .set({
        status: "pending",
        claimToken: null,
        updatedAt: sql`${now}`,
        nextAttemptAt: sql`${now} + (${backoff} * interval '1 minute')`,
      })
      .where(and(eq(alertsTable.id, row.id), eq(alertsTable.claimToken, claimToken)));
    throw err;
  }

  await db.update(alertsTable)
    .set({ status: "sent", claimToken: null, sentAt: sql`${now}`, updatedAt: sql`${now}` })
    .where(and(eq(alertsTable.id, row.id), eq(alertsTable.claimToken, claimToken)));
  return "sent";
}

export interface TwoFactorResetRecoveryResult {
  examined: number;
  sent: number;
  failed: number;
  expired: number;
}

/**
 * Deliver queued alerts that are due, plus any whose worker abandoned its
 * lease (e.g. the process restarted mid-send). Bounded per run.
 */
export async function runTwoFactorResetAlertRecovery(
  deps: { sendEmail?: TwoFactorResetAlertSender } = {},
  options: {
    limit?: number;
    /** Restrict to these users (tests scope to their own fixtures). */
    userIds?: number[];
    /** Test clock: evaluate due/lease times this many seconds ahead. */
    clockOffsetSeconds?: number;
  } = {},
): Promise<TwoFactorResetRecoveryResult> {
  const result: TwoFactorResetRecoveryResult = { examined: 0, sent: 0, failed: 0, expired: 0 };
  if (options.userIds && !options.userIds.length) return result;
  const clockOffsetSeconds = options.clockOffsetSeconds ?? 0;
  const now = clock(clockOffsetSeconds);
  const due = await db
    .select({ id: alertsTable.id, userId: alertsTable.userId })
    .from(alertsTable)
    .where(and(
      sql`(
        (${alertsTable.status} = 'pending' AND ${alertsTable.nextAttemptAt} <= ${now})
        OR (${alertsTable.status} = 'sending'
          AND ${alertsTable.updatedAt} < ${now} - (${TWO_FACTOR_RESET_ALERT_LEASE_MINUTES} * interval '1 minute'))
      )`,
      options.userIds ? inArray(alertsTable.userId, options.userIds) : undefined,
    ))
    .orderBy(alertsTable.nextAttemptAt)
    .limit(options.limit ?? 50);

  for (const alert of due) {
    result.examined++;
    try {
      const outcome = await deliverTwoFactorResetAlert(alert.id, {
        sendEmail: deps.sendEmail,
        clockOffsetSeconds,
        requireDue: true,
      });
      if (outcome === "sent") result.sent++;
      else if (outcome === "expired") result.expired++;
    } catch (err) {
      result.failed++;
      logger.warn({ err, alertId: alert.id, userId: alert.userId },
        "Two-factor reset security notification retry failed; will retry with backoff");
    }
  }
  return result;
}
