/**
 * One source for the storage add-on's price, so the estimate shown in
 * Settings and the recurring Stripe price that is actually charged cannot
 * drift apart unnoticed.
 *
 * The estimate is the storage provider's USD rate plus the ALPS margin. The
 * add-on is billed from the Stripe price in STORAGE_ADDON_PRICE_ID (per GiB,
 * monthly, normally GBP). This module turns the provider rate into the price
 * Stripe should carry, compares it with the configured price, and reports any
 * difference. Rules, all explicit:
 *
 * - Currency: the provider rate is in USD. A non-USD Stripe price needs
 *   STORAGE_USD_EXCHANGE_RATE (units of that currency per 1 USD). There is no
 *   default and no live exchange-rate lookup: a guessed rate would be exactly
 *   the silent drift this check exists to catch.
 * - Rounding: Stripe charges whole minor units (pence), so the expected price
 *   is the exact figure rounded UP, and never below 1. ALPS never sells below
 *   provider cost plus margin because of rounding.
 * - Tolerance: the configured price may sit within
 *   STORAGE_PRICE_TOLERANCE_PERCENT (default 5) of the exact figure, measured
 *   after the same rounding up. Anything outside is drift.
 * - Minimum charge: the first month is collected up front as one invoice, and
 *   Stripe will not charge a card below its minimum (GBP 0.30, USD/EUR 0.50).
 *   Purchases must be at least enough GiB to reach it.
 *
 * Drift or a configuration the check cannot evaluate pauses new storage
 * purchases (existing subscriptions are never changed) and alerts operators.
 */
import { logger } from "./logger";

export const DEFAULT_PROVIDER_STORAGE_USD_PER_GIB_MONTH = 0.015;
export const DEFAULT_ALPS_STORAGE_MARKUP_PERCENT = 20;
export const DEFAULT_STORAGE_PRICE_TOLERANCE_PERCENT = 5;

/**
 * Stripe's minimum amount per charge, in minor units
 * (https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts).
 * Only two-decimal currencies are listed; any other currency is reported as
 * unsupported rather than guessed.
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
  | "tolerance_invalid"
  | "currency_unsupported"
  | "exchange_rate_missing"
  | "exchange_rate_invalid"
  | "price_inactive"
  | "price_not_monthly"
  | "price_not_whole_minor_units"
  | "price_below_expected"
  | "price_above_expected";

export interface StoragePriceCheck {
  /** ok: purchases allowed. drift: the price is outside the allowed range. misconfigured: the check cannot be evaluated. */
  status: "ok" | "drift" | "misconfigured";
  issues: StoragePriceIssue[];
  priceId: string;
  currency: string;
  /** Per-GiB monthly price configured in Stripe, minor units. */
  configuredUnitAmount: number | null;
  /** Provider rate × (1 + margin) × exchange rate, minor units, before rounding. */
  exactUnitAmount: number | null;
  /** exactUnitAmount rounded up to a whole minor unit (at least 1). */
  expectedUnitAmount: number | null;
  allowedUnitAmount: { min: number; max: number } | null;
  providerUsdPerGibMonth: number | null;
  markupPercent: number | null;
  usdExchangeRate: number | null;
  tolerancePercent: number | null;
  stripeMinimumChargeMinorUnits: number | null;
  /** Smallest purchase whose first-month charge reaches Stripe's minimum. */
  minimumPurchaseGib: number | null;
  /** One operator-facing sentence. */
  message: string;
}

/** Round up to a whole minor unit, ignoring floating-point noise (2.4000000001 stays 3, 2.0000000001 stays 2). */
function roundUpMinorUnits(value: number): number {
  return Math.max(1, Math.ceil(Number(value.toFixed(6))));
}

/** Smallest whole GiB whose charge at `unitAmount` reaches Stripe's minimum for `currency`. */
export function minimumStoragePurchaseGib(unitAmount: number, currency: string): number | null {
  const minimum = STRIPE_MINIMUM_CHARGE_MINOR_UNITS[currency.toLowerCase()];
  if (!minimum || !Number.isSafeInteger(unitAmount) || unitAmount < 1) return null;
  return Math.max(1, Math.ceil(minimum / unitAmount));
}

function money(minorUnits: number | null, currency: string): string {
  if (minorUnits === null) return "unknown";
  return `${(minorUnits / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/** Pure comparison of a Stripe storage price with the provider-rate calculation. */
export function evaluateStorageAddonPrice(price: StoragePriceInput, env: Env = process.env): StoragePriceCheck {
  const currency = String(price.currency ?? "").toLowerCase();
  const configured = Number.isSafeInteger(price.unit_amount) ? Number(price.unit_amount) : null;
  const issues: StoragePriceIssue[] = [];

  if (!price.active) issues.push("price_inactive");
  if (price.type !== "recurring" || price.recurring?.interval !== "month") issues.push("price_not_monthly");
  if (configured === null || configured < 1) issues.push("price_not_whole_minor_units");

  const rates = readStorageRateConfig(env);
  if (!rates) issues.push("rate_config_invalid");

  const rawTolerance = env.STORAGE_PRICE_TOLERANCE_PERCENT?.trim();
  const tolerancePercent = rawTolerance ? Number(rawTolerance) : DEFAULT_STORAGE_PRICE_TOLERANCE_PERCENT;
  const toleranceValid = Number.isFinite(tolerancePercent) && tolerancePercent >= 0 && tolerancePercent < 100;
  if (!toleranceValid) issues.push("tolerance_invalid");

  const stripeMinimum = STRIPE_MINIMUM_CHARGE_MINOR_UNITS[currency] ?? null;
  if (stripeMinimum === null) issues.push("currency_unsupported");

  let usdExchangeRate: number | null = null;
  if (currency === "usd") {
    usdExchangeRate = 1;
  } else {
    const rawFx = env.STORAGE_USD_EXCHANGE_RATE?.trim();
    if (!rawFx) issues.push("exchange_rate_missing");
    else if (!Number.isFinite(Number(rawFx)) || Number(rawFx) <= 0) issues.push("exchange_rate_invalid");
    else usdExchangeRate = Number(rawFx);
  }

  let exact: number | null = null;
  let expected: number | null = null;
  let allowed: StoragePriceCheck["allowedUnitAmount"] = null;
  if (rates && usdExchangeRate !== null) {
    exact = rates.providerUsdPerGibMonth * (1 + rates.markupPercent / 100) * usdExchangeRate * 100;
    expected = roundUpMinorUnits(exact);
    if (toleranceValid) {
      allowed = {
        min: roundUpMinorUnits(exact * (1 - tolerancePercent / 100)),
        max: roundUpMinorUnits(exact * (1 + tolerancePercent / 100)),
      };
    }
  }

  const misconfigured = issues.length > 0;
  if (!misconfigured && allowed && configured !== null) {
    if (configured < allowed.min) issues.push("price_below_expected");
    if (configured > allowed.max) issues.push("price_above_expected");
  }
  const status: StoragePriceCheck["status"] = misconfigured ? "misconfigured" : issues.length ? "drift" : "ok";

  let message: string;
  if (status === "ok") {
    message = `Storage add-on price ${money(configured, currency)} per GiB-month matches the provider rate plus margin (expected ${money(expected, currency)}).`;
  } else if (status === "drift") {
    message = `Storage add-on price ${money(configured, currency)} per GiB-month no longer matches the provider rate plus margin: expected ${money(expected, currency)} (allowed ${money(allowed!.min, currency)} to ${money(allowed!.max, currency)}). Create a new Stripe price at ${money(expected, currency)} and point STORAGE_ADDON_PRICE_ID at it, or correct the rate settings.`;
  } else {
    message = `Storage add-on price check cannot be evaluated: ${issues.join(", ")}.`;
  }

  return {
    status,
    issues,
    priceId: price.id,
    currency,
    configuredUnitAmount: configured,
    exactUnitAmount: exact === null ? null : Number(exact.toFixed(6)),
    expectedUnitAmount: expected,
    allowedUnitAmount: allowed,
    providerUsdPerGibMonth: rates?.providerUsdPerGibMonth ?? null,
    markupPercent: rates?.markupPercent ?? null,
    usdExchangeRate,
    tolerancePercent: toleranceValid ? tolerancePercent : null,
    stripeMinimumChargeMinorUnits: stripeMinimum,
    minimumPurchaseGib: configured === null ? null : minimumStoragePurchaseGib(configured, currency),
    message,
  };
}

export type StoragePriceCheckResult =
  | StoragePriceCheck
  /** STORAGE_ADDON_PRICE_ID is unset: the add-on is simply not offered. */
  | { status: "not_configured"; message: string }
  /** Stripe could not be read; nothing is known about the price. */
  | { status: "unavailable"; message: string };

export type StoragePriceRetriever = (priceId: string) => Promise<StoragePriceInput>;

const DEFAULT_CACHE_MS = 10 * 60 * 1000;
let cached: { at: number; priceId: string; result: StoragePriceCheckResult } | null = null;
let lastLoggedFingerprint: string | null = null;

export function storagePriceFingerprint(result: StoragePriceCheckResult): string {
  if (result.status !== "ok" && result.status !== "drift" && result.status !== "misconfigured") return result.status;
  return [result.status, result.priceId, result.issues.join("+"), result.configuredUnitAmount, result.expectedUnitAmount].join(":");
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
  maxAgeMs?: number;
  env?: Env;
  now?: number;
} = {}): Promise<StoragePriceCheckResult> {
  const env = options.env ?? process.env;
  const priceId = env.STORAGE_ADDON_PRICE_ID?.trim();
  if (!priceId) return { status: "not_configured", message: "STORAGE_ADDON_PRICE_ID is not set; the storage add-on is not offered." };
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
