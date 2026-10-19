import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Paid storage capacity on a client's Stripe subscription.
//
// Extra storage is a per-GiB monthly subscription item (STORAGE_ADDON_PRICE_ID,
// or any price with service_key=storage metadata). Buying adds quantity and
// collects the first month at once; reducing lowers the quantity with no
// proration, so Stripe bills the lower amount from the next renewal. The GiB
// the customer already paid for stay theirs until the period ends: each
// reduction is recorded in storage_capacity_reductions and counted back in
// until its effective_at. This file must not import ./billing (test bundles
// replace that module for routes/storage.ts).

export const GIB = 1024 ** 3;
const DEFAULT_STORAGE_INCLUDED_GIB_BY_SERVICE: Record<string, number> = {
  core: 1,
  bundle: 1,
};

type SubscriptionItemLike = {
  quantity?: number | null;
  price?: { id?: string | null; metadata?: Record<string, string> | null } | null;
};

/** Whether a subscription item is the extra-storage add-on (one unit per GiB). */
export function isStorageSubscriptionItem(item: SubscriptionItemLike): boolean {
  const storagePriceId = process.env.STORAGE_ADDON_PRICE_ID?.trim();
  return item.price?.metadata?.service_key === "storage"
    || (Boolean(storagePriceId) && item.price?.id === storagePriceId);
}

/** GiB of extra storage the subscription renews with (Stripe quantity). */
export function renewingStorageGib(items: SubscriptionItemLike[]): number {
  return items
    .filter(isStorageSubscriptionItem)
    .reduce((sum, item) => sum + Math.max(0, Number(item.quantity ?? 0) || 0), 0);
}

/**
 * Storage included with the plan itself (STORAGE_INCLUDED_GIB_BY_SERVICE, the
 * largest allowance among the subscribed services). Null when the setting is
 * invalid or no subscribed service has an allowance, so callers never guess.
 */
export function planIncludedStorageGib(items: SubscriptionItemLike[]): number | null {
  const rawAllowances = process.env.STORAGE_INCLUDED_GIB_BY_SERVICE;
  let allowanceMap: Record<string, unknown>;
  try {
    allowanceMap = rawAllowances ? JSON.parse(rawAllowances) : DEFAULT_STORAGE_INCLUDED_GIB_BY_SERVICE;
  } catch {
    return null;
  }
  if (!allowanceMap || typeof allowanceMap !== "object" || Array.isArray(allowanceMap)) return null;
  const configuredValues = Object.values(allowanceMap);
  if (!configuredValues.length || configuredValues.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / GIB)) return null;
  const allowances = items
    .filter((item) => !isStorageSubscriptionItem(item))
    .map((item) => String(item.price?.metadata?.service_key ?? ""))
    .map((key) => Number(allowanceMap[key]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return allowances.length ? Math.max(...allowances) : null;
}

/** Whole GiB of extra storage the retained files need on top of the plan. */
export function minimumPaidStorageGib(usedBytes: number, planIncludedGib: number): number {
  return Math.max(0, Math.ceil((usedBytes - planIncludedGib * GIB) / GIB));
}

export type ScheduledStorageReduction = {
  id: number;
  fromGib: number;
  toGib: number;
  effectiveAt: string;
  requestedAt: string;
  requestedBy: number | null;
};

/** Reductions on this subscription whose paid period has not ended yet. */
export async function listScheduledStorageReductions(
  clientId: number,
  subscriptionId: string | undefined,
): Promise<ScheduledStorageReduction[]> {
  if (!subscriptionId) return [];
  const result = await db.execute(sql`
    SELECT id, from_gib, to_gib, effective_at, requested_at, requested_by
      FROM storage_capacity_reductions
     WHERE client_id = ${clientId}
       AND subscription_id = ${subscriptionId}
       AND effective_at > now()
     ORDER BY requested_at, id
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    fromGib: Number(row.from_gib),
    toGib: Number(row.to_gib),
    effectiveAt: new Date(row.effective_at as string).toISOString(),
    requestedAt: new Date(row.requested_at as string).toISOString(),
    requestedBy: row.requested_by == null ? null : Number(row.requested_by),
  }));
}

/** GiB removed from the renewal but still paid for in the current period. */
export function stillPaidReducedGib(reductions: ScheduledStorageReduction[]): number {
  return reductions.reduce((sum, row) => sum + (row.fromGib - row.toGib), 0);
}
