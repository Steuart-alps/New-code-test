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

/**
 * Bring a client's Stripe subscription quantity in line with their current site
 * count (with proration). Best-effort: logs and returns on any problem so the
 * triggering site create/delete still succeeds. Looks the subscription up
 * dynamically by customer id rather than relying on a stored subscription id.
 */
export async function syncClientSubscriptionQuantity(clientId: number): Promise<void> {
  try {
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId))
      .limit(1);
    if (!client?.stripeCustomerId) return; // not a paying customer yet

    const active = await findLiveSubscription(client.stripeCustomerId);
    if (!active) return;

    // Target the per-site line item specifically (falling back to the first item
    // for safety) so we never resize the wrong item on the subscription.
    const perSite = await getPerSitePrice();
    const item =
      active.items.data.find((i) => i.price?.id === perSite?.priceId) ??
      active.items.data[0];
    if (!item) return;

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
