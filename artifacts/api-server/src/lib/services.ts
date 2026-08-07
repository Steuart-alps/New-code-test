import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import type { RequestHandler } from "express";
import { findLiveSubscription, PER_SITE_CURRENCY } from "./billing";
import { getUncachableStripeClient, getStripeSync } from "./stripeClient";
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
  safetrack: { label: "SafeTrack", amountPence: 1000 },
  fixtrack: { label: "FixTrack", amountPence: 1000 },
  doctrack: { label: "DocTrack", amountPence: 1000 },
  traintrack: { label: "TrainTrack", amountPence: 1000 },
  hottubtrack: { label: "TubTrack", amountPence: 1000 },
  treetrack: { label: "TreeTrack", amountPence: 1000 },
  biketrack: { label: "BikeTrack", amountPence: 1000 },
  pooltrack:   { label: "PoolTrack",   amountPence: 1000 },
  greentrack:  { label: "GreenTrack",  amountPence: 1000 },
  swimtrack:     { label: "SwimTrack",     amountPence: 1000 },
  incidenttrack: { label: "IncidentTrack", amountPence: 1000 },
  pattrack:      { label: "PATtrack",      amountPence: 1000 },
  pesttrack:     { label: "PestTrack",     amountPence: 1000 },
  premisestrack: { label: "PremisesTrack", amountPence: 1000 },
  dailytrack_am: { label: "DailyTrack AM", amountPence: 1000 },
  dailytrack_pm: { label: "DailyTrack PM", amountPence: 1000 },
} as const;

export type ServiceKey = keyof typeof SERVICES;
export const ADDON_KEYS = ["firetrack", "kitchentrack", "legionellatrack", "safetrack", "fixtrack", "doctrack", "traintrack", "hottubtrack", "treetrack", "biketrack", "pooltrack", "greentrack", "swimtrack", "incidenttrack", "pattrack", "pesttrack", "premisestrack", "dailytrack_am", "dailytrack_pm"] as const satisfies readonly ServiceKey[];

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

/**
 * Route guard variant for routes that serve more than one billed branch (e.g.
 * the daily AM/PM checklists cover both kitchen and premises items). Passes
 * if the client is entitled to ANY of the given keys; individual handlers are
 * still responsible for checking the specific key that matches the record
 * being read/written (see requireAnyEntitlement below).
 */
export function requireAnyService(...keys: ServiceKey[]): RequestHandler {
  return async (req, res, next) => {
    try {
      const clientId = getClientId(req);
      if (!clientId) return res.status(400).json({ error: "No client context" });
      const services = await getEntitledServices(clientId);
      if (!keys.some((key) => isEntitled(services, key))) {
        return res.status(403).json({
          error: `None of the required services (${keys.map((k) => SERVICES[k].label).join(", ")}) are enabled for this account`,
          code: "SERVICE_NOT_ENABLED",
          service: keys[0],
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Non-middleware check for use inside a handler once req.currentUser/clientId is known. */
export async function requireAnyEntitlement(clientId: number, ...keys: ServiceKey[]): Promise<boolean> {
  const services = await getEntitledServices(clientId);
  return keys.some((key) => isEntitled(services, key));
}

export interface EnsurePricesResult {
  created: string[];
  existing: string[];
}

/**
 * Ensure every per-site service in the catalogue (all SERVICES plus the
 * capped bundle) has a live monthly GBP Stripe price tagged with its
 * `service_key` price metadata.
 *
 * Prices are resolved dynamically by that metadata (see getServicePrice), so a
 * module can't be activated from billing until its price exists. This helper
 * is idempotent: it only creates a product + recurring price for keys that are
 * currently missing one, then triggers a Stripe → DB backfill so the new rows
 * appear in the synced stripe.* tables the app reads from. Amounts follow the
 * existing convention (£10.00/site/month per add-on; £50.00 for the bundle),
 * matching the pricing page. No proration logic is touched.
 */
export async function ensureServicePrices(): Promise<EnsurePricesResult> {
  const stripe = await getUncachableStripeClient();

  // Which service_keys already have a live monthly price? Read from the synced
  // tables (the same source getServicePrice trusts) so we never create a
  // duplicate for a key that is already priced.
  const existingRows = await db.execute(sql`
    SELECT DISTINCT pr.metadata->>'service_key' AS service_key
    FROM stripe.prices pr
    JOIN stripe.products p ON p.id = pr.product
    WHERE p.active = true
      AND pr.active = true
      AND (pr.recurring->>'interval') = 'month'
      AND pr.metadata->>'service_key' IS NOT NULL
  `);
  const existing = new Set(
    (existingRows.rows as { service_key: string | null }[])
      .map((r) => r.service_key)
      .filter((k): k is string => !!k),
  );

  // Full catalogue: every SERVICES entry (core + add-ons) plus the bundle.
  const catalogue: { key: string; label: string; amountPence: number }[] = [
    ...Object.entries(SERVICES).map(([key, s]) => ({ key, label: s.label, amountPence: s.amountPence })),
    { key: BUNDLE_KEY, label: BUNDLE_LABEL, amountPence: SERVICE_CAP_PENCE },
  ];

  const created: string[] = [];
  for (const svc of catalogue) {
    if (existing.has(svc.key)) continue;
    // Create a dedicated product + monthly recurring price carrying the
    // service_key metadata the rest of the billing code keys off. Idempotency
    // keys guard against duplicate creation on retries.
    const product = await stripe.products.create(
      { name: svc.label, metadata: { service_key: svc.key } },
      { idempotencyKey: `svc-product-${svc.key}` },
    );
    await stripe.prices.create(
      {
        product: product.id,
        unit_amount: svc.amountPence,
        currency: PER_SITE_CURRENCY,
        recurring: { interval: "month" },
        metadata: { service_key: svc.key },
      },
      { idempotencyKey: `svc-price-${svc.key}` },
    );
    created.push(svc.key);
    logger.info({ serviceKey: svc.key, amountPence: svc.amountPence }, "Created Stripe price for service");
  }

  if (created.length > 0) {
    // Pull the new products/prices into the synced stripe.* tables the app
    // reads from, so getServicePrice() resolves them immediately.
    try {
      const sync = await getStripeSync();
      await sync.syncBackfill();
    } catch (err) {
      logger.error({ err }, "Stripe backfill after price creation failed; webhook will sync eventually");
    }
  }

  return { created, existing: Array.from(existing) };
}
