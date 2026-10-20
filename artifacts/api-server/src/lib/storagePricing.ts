/**
 * The storage add-on's price, and the check that it still covers ALPS's costs.
 *
 * Extra storage is sold at a fixed £1 per 10 GiB per month (Steuart,
 * 2026-10-19), in 10 GiB steps. In Stripe it is one monthly GBP price of 10p
 * per GiB tagged service_key=storage, which the app creates itself at start-up
 * (ensureStoragePrice in services.ts); STORAGE_ADDON_PRICE_ID can name another
 * price instead. The check, all explicit:
 *
 * - Price: the Stripe price must be active, monthly, GBP and exactly
 *   STORAGE_UNIT_AMOUNT_PENCE per GiB, so customers pay what the app shows.
 * - Cost: the storage provider's USD rate per GiB-month
 *   (STORAGE_PROVIDER_USD_PER_GIB_MONTH) plus the ALPS margin
 *   (STORAGE_ALPS_MARKUP_PERCENT), converted at STORAGE_USD_EXCHANGE_RATE
 *   (pounds per 1 USD) and rounded up to whole pence, must not exceed the
 *   price. Without an exchange rate the check assumes 1 USD = £1, which
 *   overstates the cost in pounds, so it can only pause sales too early.
 * - Stripe's minimum charge (30p) is always met: one 10 GiB step is £1.
 *
 * A wrong price, or costs rising above it, pauses new storage purchases
 * (existing subscriptions are never changed) and alerts operators.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/** Storage is sold in steps of this many GiB. */
export const STORAGE_PACK_GIB = 10;
/** Price of one step, in pence per month (£1 per 10 GiB). */
export const STORAGE_PACK_PRICE_PENCE = 100;
/** The Stripe price is per GiB: 10p, so a 10 GiB step costs £1. */
export const STORAGE_UNIT_AMOUNT_PENCE = STORAGE_PACK_PRICE_PENCE / STORAGE_PACK_GIB;
export const STORAGE_PRICE_CURRENCY = "gbp";
/** Google Cloud Storage Standard, the dearest European single region or multi-region rate. */
export const DEFAULT_PROVIDER_STORAGE_USD_PER_GIB_MONTH = 0.026;
export const DEFAULT_ALPS_STORAGE_MARKUP_PERCENT = 20;
/** Used only when STORAGE_USD_EXCHANGE_RATE is unset: overstates the cost in pounds. */
export const FALLBACK_USD_EXCHANGE_RATE = 1;

/**
 * Stripe's minimum amount per charge, in minor units
 * (https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts).
 */
export const STRIPE_MINIMUM_CHARGE_MINOR_UNITS: Readonly<Record<string, number>> = {
  gbp: 30,
  usd: 50,
  eur: 50,
};

export interface StorageRateConfig {
  providerUsdPerGibMonth: number;
  markupPercent: number;
}

type Env = Record<string, string | undefined>;

/** Provider rate and margin, or null when either setting is invalid. */
export function readStorageRateConfig(env: Env = process.env): StorageRateConfig | null {
  const rawRate = env.STORAGE_PROVIDER_USD_PER_GIB_MONTH?.trim();
  const providerUsdPerGibMonth = rawRate ? Number(rawRate) : DEFAULT_PROVIDER_STORAGE_USD_PER_GIB_MONTH;
  const rawMarkup = env.STORAGE_ALPS_MARKUP_PERCENT?.trim();
  const markupPercent = rawMarkup ? Number(rawMarkup) : DEFAULT_ALPS_STORAGE_MARKUP_PERCENT;
  if (!Number.isFinite(providerUsdPerGibMonth) || providerUsdPerGibMonth < 0) return null;
  if (!Number.isFinite(markupPercent) || markupPercent < 0) return null;
  return { providerUsdPerGibMonth, markupPercent };
}

/** The parts of a Stripe price the check reads. */
export interface StoragePriceInput {
  id: string;
  active: boolean;
  type: string;
  currency: string;
  unit_amount: number | null;
  recurring?: { interval?: string | null } | null;
}

export type StoragePriceIssue =
  | "rate_config_invalid"
  | "currency_unsupported"
  | "exchange_rate_invalid"
  | "price_inactive"
  | "price_not_monthly"
  | "price_not_storage_rate"
  | "price_below_cost";

export interface StoragePriceCheck {
  /** ok: purchases allowed. drift: costs now exceed the price. misconfigured: the price is not the storage price. */
  status: "ok" | "drift" | "misconfigured";
  issues: StoragePriceIssue[];
  priceId: string;
  currency: string;
  /** Per-GiB monthly price configured in Stripe, minor units. */
  configuredUnitAmount: number | null;
  /** The per-GiB price the app sells at (STORAGE_UNIT_AMOUNT_PENCE). */
  expectedUnitAmount: number;
  /** Provider rate × (1 + margin) × exchange rate, pence per GiB, before rounding. */
  exactUnitAmount: number | null;
  /** exactUnitAmount rounded up to a whole penny: the least the price may be. */
  costUnitAmount: number | null;
  providerUsdPerGibMonth: number | null;
  markupPercent: number | null;
  usdExchangeRate: number | null;
  /** True when STORAGE_USD_EXCHANGE_RATE is unset and the cautious fallback was used. */
  exchangeRateAssumed: boolean;
  stripeMinimumChargeMinorUnits: number | null;
  /** Purchases and reductions move in steps of this many GiB. */
  packGib: number;
  /** Smallest purchase: one step. */
  minimumPurchaseGib: number;
  /** One operator-facing sentence. */
  message: string;
}

/** Round up to a whole minor unit, ignoring floating-point noise (2.4000000001 stays 3, 2.0000000001 stays 2). */
function roundUpMinorUnits(value: number): number {
  return Math.max(1, Math.ceil(Number(value.toFixed(6))));
}

/** Whether a GiB amount is a whole number of storage steps. */
export function isWholeStoragePacks(gib: number): boolean {
  return Number.isSafeInteger(gib) && gib >= 0 && gib % STORAGE_PACK_GIB === 0;
}

/** Round a GiB amount up to whole storage steps. */
export function roundUpToStoragePacks(gib: number): number {
  return Math.ceil(Math.max(0, gib) / STORAGE_PACK_GIB) * STORAGE_PACK_GIB;
}

function money(minorUnits: number | null): string {
  if (minorUnits === null) return "unknown";
  return `£${(minorUnits / 100).toFixed(2)}`;
}

/** Pure check of a Stripe price against the fixed storage price and the provider's cost. */
export function evaluateStorageAddonPrice(price: StoragePriceInput, env: Env = process.env): StoragePriceCheck {
  const currency = String(price.currency ?? "").toLowerCase();
  const configured = Number.isSafeInteger(price.unit_amount) ? Number(price.unit_amount) : null;
  const issues: StoragePriceIssue[] = [];

  if (!price.active) issues.push("price_inactive");
  if (price.type !== "recurring" || price.recurring?.interval !== "month") issues.push("price_not_monthly");
  if (currency !== STORAGE_PRICE_CURRENCY) issues.push("currency_unsupported");
  else if (configured !== STORAGE_UNIT_AMOUNT_PENCE) issues.push("price_not_storage_rate");

  const rates = readStorageRateConfig(env);
  if (!rates) issues.push("rate_config_invalid");

  const rawFx = env.STORAGE_USD_EXCHANGE_RATE?.trim();
  let usdExchangeRate: number | null = FALLBACK_USD_EXCHANGE_RATE;
  if (rawFx) {
    usdExchangeRate = Number(rawFx);
    if (!Number.isFinite(usdExchangeRate) || usdExchangeRate <= 0) {
      issues.push("exchange_rate_invalid");
      usdExchangeRate = null;
    }
  }

  let exact: number | null = null;
  let cost: number | null = null;
  if (rates && usdExchangeRate !== null) {
    exact = rates.providerUsdPerGibMonth * (1 + rates.markupPercent / 100) * usdExchangeRate * 100;
    cost = roundUpMinorUnits(exact);
  }

  const misconfigured = issues.length > 0;
  if (!misconfigured && cost !== null && cost > STORAGE_UNIT_AMOUNT_PENCE) issues.push("price_below_cost");
  const status: StoragePriceCheck["status"] = misconfigured ? "misconfigured" : issues.length ? "drift" : "ok";

  let message: string;
  if (status === "ok") {
    message = `Storage add-on price ${money(configured)} per GiB-month (£1 per 10 GiB) covers the provider rate plus margin (${money(cost)}).`;
  } else if (status === "drift") {
    message = `Storage add-on price ${money(configured)} per GiB-month no longer covers the provider rate plus margin (${money(cost)}). Raise STORAGE_PACK_PRICE_PENCE in the code, or correct the rate settings.`;
  } else {
    message = `Storage add-on price ${price.id} is not the £1 per 10 GiB storage price: ${issues.join(", ")}.`;
  }

  return {
    status,
    issues,
    priceId: price.id,
    currency,
    configuredUnitAmount: configured,
    expectedUnitAmount: STORAGE_UNIT_AMOUNT_PENCE,
    exactUnitAmount: exact === null ? null : Number(exact.toFixed(6)),
    costUnitAmount: cost,
    providerUsdPerGibMonth: rates?.providerUsdPerGibMonth ?? null,
    markupPercent: rates?.markupPercent ?? null,
    usdExchangeRate,
    exchangeRateAssumed: !rawFx,
    stripeMinimumChargeMinorUnits: STRIPE_MINIMUM_CHARGE_MINOR_UNITS[currency] ?? null,
    packGib: STORAGE_PACK_GIB,
    minimumPurchaseGib: STORAGE_PACK_GIB,
    message,
  };
}

/**
 * The Stripe price storage is sold at: STORAGE_ADDON_PRICE_ID when set, else
 * the live monthly GBP price tagged service_key=storage that the app created.
 */
export async function findStoragePriceId(env: Env = process.env): Promise<string | null> {
  const configured = env.STORAGE_ADDON_PRICE_ID?.trim();
  if (configured) return configured;
  const rows = await db.execute(sql`
    SELECT pr.id
      FROM stripe.prices pr
      JOIN stripe.products p ON p.id = pr.product
     WHERE p.active = true
       AND pr.active = true
       AND (pr.recurring->>'interval') = 'month'
       AND COALESCE(pr.recurring->>'interval_count', '1') = '1'
       AND pr.currency = ${STORAGE_PRICE_CURRENCY}
       AND pr.unit_amount = ${STORAGE_UNIT_AMOUNT_PENCE}
       AND pr.metadata->>'service_key' = 'storage'
     ORDER BY pr.created DESC
     LIMIT 1
  `);
  const row = (rows.rows ?? [])[0] as { id?: string } | undefined;
  return row?.id ?? null;
}

export type StoragePriceCheckResult =
  | StoragePriceCheck
  /** No storage price exists (or is configured): the add-on is simply not offered. */
  | { status: "not_configured"; message: string }
  /** Stripe could not be read; nothing is known about the price. */
  | { status: "unavailable"; message: string };

export type StoragePriceRetriever = (priceId: string) => Promise<StoragePriceInput>;

const DEFAULT_CACHE_MS = 10 * 60 * 1000;
let cached: { at: number; priceId: string; result: StoragePriceCheckResult } | null = null;
let lastLoggedFingerprint: string | null = null;

export function storagePriceFingerprint(result: StoragePriceCheckResult): string {
  if (result.status !== "ok" && result.status !== "drift" && result.status !== "misconfigured") return result.status;
  return [result.status, result.priceId, result.issues.join("+"), result.configuredUnitAmount, result.costUnitAmount].join(":");
}

/**
 * Record a check made elsewhere (the purchase route evaluates the price it
 * has just retrieved) and log a problem once per distinct finding per process.
 */
export function rememberStoragePriceCheck(result: StoragePriceCheckResult, now = Date.now()): void {
  if ("priceId" in result) cached = { at: now, priceId: result.priceId, result };
  const fingerprint = storagePriceFingerprint(result);
  if ((result.status === "drift" || result.status === "misconfigured") && fingerprint !== lastLoggedFingerprint) {
    logger.error({ storagePriceCheck: result }, "Storage add-on price drift: new storage purchases are paused");
  }
  if (result.status !== "unavailable") lastLoggedFingerprint = fingerprint;
}

/**
 * Check the configured Stripe storage price, reusing a recent result for up
 * to `maxAgeMs` (default 10 minutes) so page loads do not each call Stripe.
 */
export async function checkStorageAddonPrice(options: {
  retrievePrice?: StoragePriceRetriever;
  findPriceId?: (env: Env) => Promise<string | null>;
  maxAgeMs?: number;
  env?: Env;
  now?: number;
} = {}): Promise<StoragePriceCheckResult> {
  const env = options.env ?? process.env;
  let priceId: string | null;
  try {
    priceId = await (options.findPriceId ?? findStoragePriceId)(env);
  } catch (err) {
    logger.warn({ err }, "Storage add-on price check could not look up the storage price");
    return { status: "unavailable", message: "The storage price could not be looked up." };
  }
  if (!priceId) return { status: "not_configured", message: "No storage price exists yet; the storage add-on is not offered." };
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CACHE_MS;
  if (cached && cached.priceId === priceId && now - cached.at < maxAgeMs) return cached.result;

  const retrievePrice = options.retrievePrice ?? (async (id: string) => {
    const { getUncachableStripeClient } = await import("./stripeClient");
    const stripe = await getUncachableStripeClient();
    return await stripe.prices.retrieve(id) as unknown as StoragePriceInput;
  });
  let price: StoragePriceInput;
  try {
    price = await retrievePrice(priceId);
  } catch (err) {
    logger.warn({ err, priceId }, "Storage add-on price check could not read the Stripe price");
    return { status: "unavailable", message: "The Stripe storage price could not be read." };
  }
  const result = evaluateStorageAddonPrice(price, env);
  rememberStoragePriceCheck(result, now);
  return result;
}

/** Test hook: forget the cached result and the logged finding. */
export function resetStoragePriceCheckCache(): void {
  cached = null;
  lastLoggedFingerprint = null;
}
