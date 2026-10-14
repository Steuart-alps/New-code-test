/**
 * Keep a client's local subscription fields in step with the synced Stripe
 * subscription (stripe.subscriptions, updated by processWebhook).
 *
 * clients.subscription_status / stripe_subscription_id drive Settings' plan
 * status and keep trial reminders away from paying customers. A live
 * subscription also stops any data-retention countdown started by a previous
 * cancellation or lapsed trial.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { invalidateTrialLock } from "./trialLock";
import { invalidateEntitlements } from "./services";
import { logger } from "./logger";

const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface ClientSubscriptionState {
  clientId: number;
  status: string | null;
  live: boolean;
  retentionCleared: boolean;
}

export async function syncClientSubscriptionState(customerId: string): Promise<ClientSubscriptionState | null> {
  const result = await db.execute(sql`
    SELECT c.id AS client_id, s.id AS subscription_id, s.status
    FROM clients c
    LEFT JOIN LATERAL (
      SELECT id, status FROM stripe.subscriptions
      WHERE customer = c.stripe_customer_id
      ORDER BY (status IN ('active', 'trialing', 'past_due')) DESC, current_period_end DESC NULLS LAST
      LIMIT 1
    ) s ON true
    WHERE c.stripe_customer_id = ${customerId}
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as { client_id: number; subscription_id: string | null; status: string | null } | undefined;
  if (!row) return null;
  const clientId = Number(row.client_id);
  if (!row.subscription_id) return { clientId, status: null, live: false, retentionCleared: false };
  const live = LIVE_STATUSES.has(String(row.status));

  await db.execute(sql`
    UPDATE clients
       SET subscription_status = ${row.status},
           stripe_subscription_id = ${row.subscription_id},
           updated_at = now()
     WHERE id = ${clientId}
       AND (subscription_status IS DISTINCT FROM ${row.status}
         OR stripe_subscription_id IS DISTINCT FROM ${row.subscription_id})
  `);
  let retentionCleared = false;
  if (live) {
    const cleared = await db.execute(sql`
      UPDATE clients
         SET cancelled_at = NULL, data_deletion_scheduled_at = NULL,
             offboarding_email_sent_at = NULL, updated_at = now()
       WHERE id = ${clientId} AND data_deleted_at IS NULL
         AND (cancelled_at IS NOT NULL OR data_deletion_scheduled_at IS NOT NULL)
      RETURNING id
    `);
    retentionCleared = (cleared.rows ?? []).length > 0;
    if (retentionCleared) logger.info({ clientId }, "Live subscription found — retention clock cleared");
  }
  invalidateTrialLock(clientId);
  invalidateEntitlements(clientId);
  return { clientId, status: row.status, live, retentionCleared };
}
