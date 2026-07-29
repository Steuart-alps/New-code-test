import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { findLiveSubscription } from "./billing";
import { getClientId } from "../middleware/requireAuth";
import { logger } from "./logger";

/**
 * Per-site service catalog. `core` is ComplyTrack itself (always included in a
 * subscription); the others are optional add-on branches. The bundle unlocks
 * everything (including future services) at a capped per-site price.
 */
export const SERVICES = {
  core: { label: "ComplyTrack", amountPence: 1000 },
  firetrack: { label: "FireTrack", amountPence: 1000 },
  kitchentrack: { label: "KitchenTrack", amountPence: 1000 },
  legionellatrack: { label: "LegionellaTrack", amountPence: 1000 },
} as const;

export type ServiceKey = keyof typeof SERVICES;
export const ADDON_KEYS = ["firetrack", "kitchentrack", "legionellatrack"] as const satisfies readonly ServiceKey[];

export const BUNDLE_KEY = "bundle";
export const BUNDLE_LABEL = "ComplyTrack Complete";
/** Per-site monthly cap: at or beyond this, every service is unlocked. */
export const SERVICE_CAP_PENCE = 5000;

export type Entitlements = "all" | ServiceKey[];

// Cached per-client entitlement decisions (same spirit as the trial-lock cache).
const TTL_MS = 5 * 60_000;
const cache = new Map<number, { services: Entitlements; expiresAt: number }>();

export function invalidateEntitlements(clientId: number): void {
  cache.delete(clientId);
}

/**
 * Which services a client can use right now.
 * - Trial still running → everything (user decision: trials get full access).
 * - Live subscription → derived from its items' price metadata `service_key`;
 *   a bundle item, or per-site items summing to >= the cap, unlocks everything.
 * - No live subscription → core only (the trial lock already 402s expired
 *   trials on all data routes; failing to "core" keeps this check independent).
 */
export async function getEntitledServices(clientId: number): Promise<Entitlements> {
  const [client] = await db
    .select({
      trialEndsAt: clientsTable.trialEndsAt,
      stripeCustomerId: clientsTable.stripeCustomerId,
    })
    .from(clientsTable)
    .where(eq(clientsTable.id, clientId))
    .limit(1);
  if (!client) return ["core"];

  if (!client.trialEndsAt || client.trialEndsAt.getTime() > Date.now()) {
    return "all";
  }

  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.services;

  let services: Entitlements = ["core"];
  if (client.stripeCustomerId) {
    try {
      const sub = await findLiveSubscription(client.stripeCustomerId);
      if (sub) {
        const keys = new Set<ServiceKey>(["core"]);
        let perSiteTotal = 0;
        let hasBundle = false;
        for (const item of sub.items.data) {
          const key = item.price?.metadata?.service_key;
          if (!key) continue;
          if (key === BUNDLE_KEY) hasBundle = true;
          else if (key in SERVICES) {
            keys.add(key as ServiceKey);
            perSiteTotal += item.price?.unit_amount ?? 0;
          }
        }
        services = hasBundle || perSiteTotal >= SERVICE_CAP_PENCE ? "all" : Array.from(keys);
      }
    } catch (err) {
      logger.error({ err, clientId }, "Entitlement lookup failed; falling back to cached/core");
      return cached?.services ?? ["core"];
    }
  }

  cache.set(clientId, { services, expiresAt: Date.now() + TTL_MS });
  return services;
}

export function isEntitled(services: Entitlements, key: ServiceKey): boolean {
  return services === "all" || services.includes(key);
}

/**
 * Route guard: 403 with code SERVICE_NOT_ENABLED when the client hasn't
 * subscribed to the branch. Mount AFTER requireAuth.
 */
export function requireService(key: ServiceKey): RequestHandler {
  return async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      if (!clientId) return res.status(400).json({ error: "No client context" });
      const services = await getEntitledServices(clientId);
      if (!isEntitled(services, key)) {
        return res.status(403).json({
          error: `${SERVICES[key].label} is not enabled for this account`,
          code: "SERVICE_NOT_ENABLED",
          service: key,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
