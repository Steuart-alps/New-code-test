/**
 * Expiring delivery leases for scheduled reminder emails.
 *
 * A permanent "already sent" marker written before dispatch loses the alert if
 * the worker dies before the provider accepts it (see
 * .agents/memory/restart-safe-notification-delivery.md). Instead a worker:
 *
 *   1. claims a lease on (job, delivery key) — refused while another worker
 *      holds an unexpired lease,
 *   2. re-checks its own permanent dedupe marker (another worker may have
 *      finished between the candidate read and the claim),
 *   3. sends with `idempotencyKey(claim)` as the provider key,
 *   4. on success writes its permanent marker and settles the claim in one
 *      transaction; on a confirmed send failure it settles the claim without a
 *      marker so a later run retries.
 *
 * A crash between (3) and (4) leaves the lease to expire; the next run reclaims
 * it and resends under the same provider key, so the provider deduplicates it
 * within its idempotency window. Settled claims are deleted, so the table only
 * holds in-flight or abandoned deliveries — except for jobs without their own
 * dedupe log, which keep the claim as their sent marker (markEmailDeliverySent).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

const DEFAULT_LEASE_MINUTES = 15;

type Executor = Pick<typeof db, "execute">;

export interface EmailDeliveryClaim {
  job: string;
  deliveryKey: string;
  leaseToken: string;
}

/** Claim a delivery lease, or null when another worker holds an unexpired one. */
export async function claimEmailDelivery(
  job: string,
  deliveryKey: string,
  options: { leaseMinutes?: number; executor?: Executor } = {},
): Promise<EmailDeliveryClaim | null> {
  const leaseToken = randomUUID();
  const minutes = options.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  const executor = options.executor ?? db;
  const result = await executor.execute(sql`
    INSERT INTO scheduled_email_claims (job, delivery_key, lease_token, lease_expires_at)
    VALUES (${job}, ${deliveryKey}, ${leaseToken}, now() + make_interval(mins => ${minutes}))
    ON CONFLICT (job, delivery_key) DO UPDATE
      SET lease_token = EXCLUDED.lease_token,
          lease_expires_at = EXCLUDED.lease_expires_at
      WHERE scheduled_email_claims.sent_at IS NULL
        AND (scheduled_email_claims.lease_expires_at IS NULL
          OR scheduled_email_claims.lease_expires_at <= now())
    RETURNING lease_token
  `);
  const row = (result.rows ?? [])[0] as { lease_token?: string } | undefined;
  return row?.lease_token === leaseToken ? { job, deliveryKey, leaseToken } : null;
}

/**
 * Settle this worker's claim: after a successful send (inside the transaction
 * that writes the permanent marker) or after a confirmed send failure. Never
 * touches a claim another worker has since taken over.
 */
export async function settleEmailDelivery(claim: EmailDeliveryClaim, executor: Executor = db): Promise<void> {
  await executor.execute(sql`
    DELETE FROM scheduled_email_claims
    WHERE job = ${claim.job} AND delivery_key = ${claim.deliveryKey} AND lease_token = ${claim.leaseToken}
  `);
}

/**
 * For jobs without their own dedupe log: keep this claim as the permanent
 * "sent" marker for its delivery key (a later claim of the key is refused).
 */
export async function markEmailDeliverySent(claim: EmailDeliveryClaim, executor: Executor = db): Promise<void> {
  await executor.execute(sql`
    UPDATE scheduled_email_claims
    SET sent_at = now(), lease_token = NULL, lease_expires_at = NULL
    WHERE job = ${claim.job} AND delivery_key = ${claim.deliveryKey} AND lease_token = ${claim.leaseToken}
  `);
}

/** Drop permanent "sent" markers of a job older than `days` (bounded table growth). */
export async function pruneSentEmailDeliveries(job: string, days: number): Promise<void> {
  await db.execute(sql`
    DELETE FROM scheduled_email_claims
    WHERE job = ${job} AND sent_at IS NOT NULL AND sent_at < now() - make_interval(days => ${days})
  `);
}

/** Stable provider idempotency key for a claimed delivery (optionally per recipient). */
export function emailDeliveryIdempotencyKey(claim: EmailDeliveryClaim, recipient?: string | number): string {
  const base = `${claim.job}:${claim.deliveryKey}`;
  return recipient === undefined ? base : `${base}:${recipient}`;
}
