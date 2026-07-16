import { db } from "@workspace/db";
import { clientsTable, sitesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";

export const PER_SITE_UNIT_AMOUNT = 1000; // £10.00 in pence
export const PER_SITE_CURRENCY = "gbp";

/** Number of sites (buildings) belonging to a client. */
export async function countClientSites(clientId: number): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sitesTable)
    .where(eq(sitesTable.clientId, clientId));
  return rows[0]?.count ?? 0;
}

/** Subscription quantity is the site count, but never below 1 (Stripe requires >= 1). */
export function quantityForSiteCount(siteCount: number): number {
  return Math.max(siteCount, 1);
}

export interface PerSitePrice {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
}

/**
 * Resolve the active per-site monthly price from the Stripe-synced tables.
 * After the per-site migration there is a single active recurring product, so we
 * take the cheapest active monthly price on an active product.
 */
export async function getPerSitePrice(): Promise<PerSitePrice | null> {
  try {
    const rows = await db.execute(sql`
      SELECT pr.id AS price_id, pr.unit_amount, pr.currency, pr.recurring
      FROM stripe.prices pr
      JOIN stripe.products p ON p.id = pr.product
      WHERE p.active = true
        AND pr.active = true
        AND (pr.recurring->>'interval') = 'month'
      ORDER BY pr.unit_amount ASC
      LIMIT 1
    `);
    const r = rows.rows[0] as any;
    if (!r) return null;
    return {
      priceId: r.price_id,
      unitAmount: Number(r.unit_amount),
      currency: r.currency,
      interval: r.recurring?.interval ?? "month",
    };
  } catch (err) {
    logger.error({ err }, "Failed to resolve per-site price");
    return null;
  }
}

/**
 * Find a client's current "live" subscription (active, trialing or past_due) by
 * looking it up dynamically against the Stripe API by customer id. Returns null
 * when the customer has no such subscription. We enforce one subscription per
 * client, so the first match is the canonical one.
 */
export async function findLiveSubscription(customerId: string) {
  const stripe = await getUncachableStripeClient();
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  return (
    subs.data.find((s) =>
      ["active", "trialing", "past_due"].includes(s.status),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Per-client serialization of quantity syncs.
//
// Two site changes landing at nearly the same moment could otherwise interleave
// their read-count → update-Stripe steps and apply updates out of order,
// briefly leaving the billed quantity out of step with the real site count.
// Each client's syncs run one at a time; because every run re-reads the site
// count and current subscription state at its start, the last run in the chain
// always converges Stripe to the true count. A pending flag coalesces bursts:
// if a sync is already queued (not yet started) for a client, additional
// requests piggyback on it instead of queueing more redundant Stripe calls.
// ---------------------------------------------------------------------------
const syncChains = new Map<number, Promise<void>>();
const syncPending = new Set<number>();

/**
 * Bring a client's Stripe subscription quantity in line with their current site
 * count (with proration). Best-effort: logs and returns on any problem so the
 * triggering site create/delete still succeeds. Concurrent calls for the same
 * client are serialized (and coalesced) so updates can't land out of order.
 */
export function syncClientSubscriptionQuantity(clientId: number): Promise<void> {
  // Already queued but not started: that run will read the latest state.
  if (syncPending.has(clientId)) {
    return syncChains.get(clientId) ?? Promise.resolve();
  }
  syncPending.add(clientId);

  const prev = syncChains.get(clientId) ?? Promise.resolve();
  const run = prev.then(() => {
    // Now starting: later callers must queue a fresh run to observe their changes.
    syncPending.delete(clientId);
    return doSyncClientSubscriptionQuantity(clientId);
  });
  // Never propagate rejections into the chain (doSync catches internally anyway).
  const chained = run.catch(() => {});
  syncChains.set(clientId, chained);
  chained.finally(() => {
    // Drop the map entry once the chain is fully drained to avoid unbounded growth.
    if (syncChains.get(clientId) === chained) {
      syncChains.delete(clientId);
    }
  });
  return run;
}

// Namespace for advisory lock keys so we don't collide with other lock users.
const BILLING_SYNC_LOCK_NS = 0x42494c4c; // "BILL"

async function doSyncClientSubscriptionQuantity(clientId: number): Promise<void> {
  try {
    // Cross-instance serialization: the in-process queue above only covers a
    // single server process. A Postgres transaction-scoped advisory lock keyed
    // by client id guarantees that even with multiple API instances, only one
    // sync per client runs at a time; each waits its turn and then re-reads
    // the latest site count, so the final Stripe quantity matches reality.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BILLING_SYNC_LOCK_NS}, ${clientId})`,
      );
      await syncWithStripe(clientId);
    });
  } catch (err) {
    logger.error({ err, clientId }, "Failed to sync subscription quantity");
  }
}

async function syncWithStripe(clientId: number): Promise<void> {
  try {
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId))
      .limit(1);
    if (!client?.stripeCustomerId) return; // not a paying customer yet

    const active = await findLiveSubscription(client.stripeCustomerId);
    if (!active) return;

    // Only ever resize the per-site line item. If the subscription has no item on
    // the per-site price (e.g. a legacy tiered subscription), do nothing — we must
    // never apply per-site quantity logic to a non-per-site plan.
    const perSite = await getPerSitePrice();
    if (!perSite) return;
    const item = active.items.data.find((i) => i.price?.id === perSite.priceId);
    if (!item) {
      logger.info(
        { clientId, subscriptionId: active.id },
        "No per-site line item on subscription; skipping quantity sync",
      );
      return;
    }

    const desired = quantityForSiteCount(await countClientSites(clientId));
    if (item.quantity === desired) return;

    const stripe = await getUncachableStripeClient();
    await stripe.subscriptions.update(active.id, {
      items: [{ id: item.id, quantity: desired }],
      proration_behavior: "create_prorations",
    });
    logger.info(
      { clientId, subscriptionId: active.id, quantity: desired },
      "Updated subscription quantity to match site count",
    );
  } catch (err) {
    logger.error({ err, clientId }, "Failed to sync subscription quantity");
  }
}
