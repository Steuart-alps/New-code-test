import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { findLiveSubscription } from "./billing";
import { logger } from "./logger";

// How long a computed lock decision is trusted before re-checking Stripe.
// Locked decisions expire quickly so that subscribing via checkout restores
// access almost immediately; unlocked (subscribed) decisions are cached longer
// to keep Stripe API traffic low on the hot path.
const LOCKED_TTL_MS = 15_000;
const UNLOCKED_TTL_MS = 5 * 60_000;

interface CacheEntry {
  locked: boolean;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

/** Drop any cached lock decision so the next check hits Stripe fresh. */
export function invalidateTrialLock(clientId: number): void {
  cache.delete(clientId);
}

/**
 * A client is billing-locked when their free trial has ended
 * (clients.trial_ends_at in the past) and they have no live Stripe
 * subscription (active, trialing or past_due — looked up dynamically, the
 * same definition used everywhere in billing).
 *
 * Fails open: if Stripe cannot be reached we do NOT lock the client, so a
 * Stripe outage can never lock out paying customers.
 */
export async function isClientBillingLocked(clientId: number): Promise<boolean> {
  const [client] = await db
    .select({
      trialEndsAt: clientsTable.trialEndsAt,
      stripeCustomerId: clientsTable.stripeCustomerId,
    })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .limit(1);
  if (!client) return false;

  // Trial still running (or no trial end recorded): never locked.
  if (!client.trialEndsAt || client.trialEndsAt.getTime() > Date.now()) {
    return false;
  }

  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.locked;
  }

  let locked: boolean;
  if (!client.stripeCustomerId) {
    // Never even created a Stripe customer — no subscription possible.
    locked = true;
  } else {
    try {
      const live = await findLiveSubscription(client.stripeCustomerId);
      locked = !live;
    } catch (err) {
      logger.error({ err, clientId }, "Trial lock: Stripe lookup failed; failing open");
      return cached?.locked ?? false;
    }
  }

  cache.set(clientId, {
    locked,
    expiresAt: Date.now() + (locked ? LOCKED_TTL_MS : UNLOCKED_TTL_MS),
  });
  return locked;
}
