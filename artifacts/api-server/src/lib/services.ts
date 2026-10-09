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
  hottubtrack: { label: "HotTubTrack", amountPence: 1000 },
  treetrack: { label: "TreeTrack", amountPence: 1000 },
  biketrack: { label: "BikeTrack", amountPence: 1000 },
  aquatrack:   { label: "AquaTrack",   amountPence: 1000 },
  pooltrack:   { label: "PoolTrack",   amountPence: 1000 },   // legacy — superseded by aquatrack
  greentrack:  { label: "GreenTrack",  amountPence: 1000 },
  swimtrack:     { label: "SwimTrack",     amountPence: 1000 }, // legacy — superseded by aquatrack
  incidenttrack: { label: "IncidentTrack", amountPence: 1000 },
  pattrack:      { label: "PATtrack",      amountPence: 1000 },
  pesttrack:     { label: "PestTrack",     amountPence: 1000 },
  premisestrack: { label: "PremisesTrack", amountPence: 1000 },
  roomtrack: { label: "RoomTrack", amountPence: 1000 },
  dailytrack_am: { label: "DailyTrack AM", amountPence: 1000 },
  dailytrack_pm: { label: "DailyTrack PM", amountPence: 1000 },
} as const;

export type ServiceKey = keyof typeof SERVICES;
export const ADDON_KEYS = ["firetrack", "kitchentrack", "legionellatrack", "safetrack", "fixtrack", "doctrack", "traintrack", "hottubtrack", "treetrack", "biketrack", "aquatrack", "pooltrack", "greentrack", "swimtrack", "incidenttrack", "pattrack", "pesttrack", "premisestrack", "roomtrack", "dailytrack_am", "dailytrack_pm"] as const satisfies readonly ServiceKey[];

export const BUNDLE_KEY = "bundle";
export const BUNDLE_LABEL = "ComplyTrack Complete";
/** Per-site monthly cap: at or beyond this, every service is unlocked. */
export const SERVICE_CAP_PENCE = 5000;

export const SERVICE_PRICE_CATALOGUE = [
  ...Object.entries(SERVICES).map(([key, service]) => ({
    key,
    label: service.label,
    amountPence: service.amountPence,
  })),
  { key: BUNDLE_KEY, label: BUNDLE_LABEL, amountPence: SERVICE_CAP_PENCE },
] as const;

export interface ServicePricePreflight {
  /** All catalogue service keys which require a Stripe monthly price. */
  required: string[];
  /** Required keys with exactly one active, synced monthly Stripe price. */
  configured: string[];
  /** Required keys which cannot safely be selected in checkout or add-on activation. */
  missing: string[];
  /** Required keys with more than one selectable active monthly price. */
  duplicates: string[];
  issues: { key: string; label: string; reason: "missing" | "duplicate" }[];
  ready: boolean;
}

/**
 * Turn price-catalogue checks into a safe, non-secret readiness status. A
 * failed read or repair is not treated as healthy merely because the process
 * itself can continue serving diagnostic/admin endpoints.
 */
export function getServicePriceReadinessBlocker(input: {
  catalogueReadFailed: boolean;
  repairFailed: boolean;
  finalPreflight: ServicePricePreflight | null;
}): string | null {
  if (input.catalogueReadFailed) {
    return "Stripe service-price catalogue could not be read";
  }
  if (input.repairFailed) {
    return "Stripe service-price catalogue repair failed";
  }
  if (input.finalPreflight?.duplicates.length) {
    return "Required Stripe service prices are duplicated";
  }
  if (!input.finalPreflight || !input.finalPreflight.ready) {
    return "Required Stripe service prices are missing";
  }
  return null;
}

/**
 * Pure portion of the price launch check. Keeping this separate makes the
 * catalogue contract testable without a Stripe account or a database.
 */
export function evaluateServicePricePreflight(
  configuredServiceKeys: Iterable<string>,
): ServicePricePreflight {
  const counts = new Map<string, number>();
  for (const key of configuredServiceKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const required = SERVICE_PRICE_CATALOGUE.map((service) => service.key);
  const configured = required.filter((key) => counts.get(key) === 1);
  const missing = required.filter((key) => !counts.has(key));
  const duplicates = required.filter((key) => (counts.get(key) ?? 0) > 1);
  const issues = SERVICE_PRICE_CATALOGUE.flatMap((service) => {
    const count = counts.get(service.key) ?? 0;
    return count === 1 ? [] : [{
      key: service.key,
      label: service.label,
      reason: count === 0 ? "missing" as const : "duplicate" as const,
    }];
  });
  return { required, configured, missing, duplicates, issues, ready: issues.length === 0 };
}

/**
 * Client-facing purchase availability for add-ons, derived from the same
 * read-only price preflight that activation enforces. Only add-on keys are
 * reported, and only as "unavailable" — operator detail (missing vs
 * duplicate) stays on the consultant-only preflight. A failed catalogue read
 * is reported as `checked: false` so the UI can explain the gap instead of
 * offering an Add action that activation would reject.
 */
export interface AddonPurchaseAvailability {
  checked: boolean;
  unavailable: string[];
}

export function addonPurchaseAvailability(
  preflight: Pick<ServicePricePreflight, "missing" | "duplicates"> | null,
): AddonPurchaseAvailability {
  if (!preflight) return { checked: false, unavailable: [] };
  const blocked = new Set([...preflight.missing, ...preflight.duplicates]);
  return {
    checked: true,
    unavailable: ADDON_KEYS.filter((key) => blocked.has(key)),
  };
}

async function listLiveMonthlyPriceServiceKeys(): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT pr.metadata->>'service_key' AS service_key
    FROM stripe.prices pr
    JOIN stripe.products p ON p.id = pr.product
    WHERE p.active = true
      AND pr.active = true
      AND (pr.recurring->>'interval') = 'month'
      AND COALESCE(pr.recurring->>'interval_count', '1') = '1'
      AND pr.currency = ${PER_SITE_CURRENCY}
      AND pr.metadata->>'service_key' IS NOT NULL
  `);
  return (rows.rows as { service_key: string | null }[])
    .map((row) => row.service_key)
    .filter((key): key is string => Boolean(key));
}

/**
 * Read-only launch preflight for the Stripe-synced price catalogue. It never
 * calls Stripe and never changes subscriptions or entitlements. Callers get
 * every missing required price in one response, rather than discovering gaps
 * one client activation at a time.
 */
export async function getServicePricePreflight(): Promise<ServicePricePreflight> {
  return evaluateServicePricePreflight(await listLiveMonthlyPriceServiceKeys());
}

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
        // safetrack is merged into doctrack — either key grants doctrack access.
        if (keys.has("safetrack")) keys.add("doctrack");
        // aquatrack supersedes pooltrack + swimtrack. Legacy subscribers keep access;
        // new aquatrack subscribers get both legacy routes unlocked automatically.
        if (keys.has("pooltrack") || keys.has("swimtrack")) keys.add("aquatrack");
        if (keys.has("aquatrack")) { keys.add("pooltrack"); keys.add("swimtrack"); }
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
  const existing = new Set(await listLiveMonthlyPriceServiceKeys());

  // Full catalogue: every SERVICES entry (core + add-ons) plus the bundle.
  const catalogue: readonly { key: string; label: string; amountPence: number }[] =
    SERVICE_PRICE_CATALOGUE;

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
