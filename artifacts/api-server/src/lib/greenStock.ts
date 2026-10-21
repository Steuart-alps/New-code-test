import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * GreenTrack stock: products (pesticides, fertiliser, top dressing, seed...)
 * whose stock on hand is worked out from their history rather than stored.
 * Deliveries add, write-offs and application records take off, and a stock
 * count sets the figure to what was counted. Entries run in date order; on the
 * same day, in the order they were saved, so a count logged after the day's
 * spraying already includes it.
 */

export const GREEN_PRODUCT_CATEGORIES = ["pesticide", "fertiliser", "top_dressing", "seed", "wetting_agent", "other"] as const;
export const GREEN_PRODUCT_UNITS = ["L", "kg", "t", "bag", "unit"] as const;
export const GREEN_STOCK_MOVEMENT_KINDS = ["delivery", "count", "write_off"] as const;
export const GREEN_APPLICATION_METHODS = ["spray", "granular", "top_dressing", "other"] as const;
export const GREEN_APPLICATION_AREAS = [
  "greens", "tees", "fairways", "approaches", "surrounds", "bunkers", "rough", "practice", "other",
] as const;
/** The most anyone could hold or apply of one product, in its own unit. */
export const GREEN_MAX_QUANTITY = 10_000_000;

export type GreenLedgerKind = (typeof GREEN_STOCK_MOVEMENT_KINDS)[number] | "application";

export interface GreenLedgerEntry {
  key: string;
  kind: GreenLedgerKind;
  productId: number;
  date: string;
  /** Signed change to stock; for a count, the difference it made. */
  change: number;
  /** Stock after this entry. */
  balance: number;
  countedQuantity: number | null;
  movementId: number | null;
  applicationId: number | null;
  detail: string | null;
  recordedBy: string | null;
}

interface RawEntry {
  kind: GreenLedgerKind;
  product_id: number;
  day: string;
  created_at: string;
  id: number;
  quantity: number;
  counted_quantity: number | null;
  detail: string | null;
  recorded_by: string | null;
}

/** Rounds away floating-point noise (quantities are kept to 3 decimal places). */
export function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Parses a quantity: a number from 0 to GREEN_MAX_QUANTITY rounded to 3
 * decimal places. undefined stays undefined, null or "" is null.
 */
export function parseQuantity(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > GREEN_MAX_QUANTITY) return "invalid";
  return roundQuantity(number);
}

/**
 * Every stock entry for the business (or one product), oldest first, with the
 * running balance. A product's last balance is its stock on hand.
 */
export async function greenStockLedger(clientId: number, productId?: number): Promise<GreenLedgerEntry[]> {
  const product = productId == null ? sql`` : sql`AND product_id = ${productId}`;
  const raw = (await db.execute(sql`
    SELECT kind, product_id, to_char(movement_date, 'YYYY-MM-DD') AS day, created_at, id, quantity, counted_quantity,
           NULLIF(concat_ws(', ', supplier, CASE WHEN batch_number IS NOT NULL THEN 'batch ' || batch_number END, reference, notes), '') AS detail,
           recorded_by
      FROM green_stock_movements
     WHERE client_id = ${clientId} ${product}
    UNION ALL
    SELECT 'application', ap.product_id, to_char(a.application_date, 'YYYY-MM-DD'), a.created_at, a.id, -ap.quantity_used, NULL,
           NULLIF(concat_ws(', ', (SELECT string_agg(initcap(area), ', ') FROM jsonb_array_elements_text(a.areas) AS area), a.area_details, a.reason), ''),
           a.operator_name
      FROM green_application_products ap
      JOIN green_applications a ON a.id = ap.application_id AND a.client_id = ap.client_id
     WHERE ap.client_id = ${clientId} ${productId == null ? sql`` : sql`AND ap.product_id = ${productId}`}
  `)).rows as unknown as RawEntry[];

  raw.sort((a, b) =>
    a.day.localeCompare(b.day)
    || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    || (a.kind === "application" ? 1 : 0) - (b.kind === "application" ? 1 : 0)
    || a.id - b.id);

  const balances = new Map<number, number>();
  return raw.map((entry) => {
    const before = balances.get(entry.product_id) ?? 0;
    const counted = entry.counted_quantity == null ? null : Number(entry.counted_quantity);
    const balance = roundQuantity(entry.kind === "count" ? counted ?? before : before + Number(entry.quantity));
    balances.set(entry.product_id, balance);
    return {
      key: `${entry.kind}-${entry.id}`,
      kind: entry.kind,
      productId: entry.product_id,
      date: entry.day,
      change: roundQuantity(balance - before),
      balance,
      countedQuantity: counted,
      movementId: entry.kind === "application" ? null : entry.id,
      applicationId: entry.kind === "application" ? entry.id : null,
      detail: entry.detail,
      recordedBy: entry.recorded_by,
    };
  });
}

/** Stock on hand for each product that has any history. */
export function stockOnHand(ledger: GreenLedgerEntry[]): Map<number, number> {
  const stock = new Map<number, number>();
  for (const entry of ledger) stock.set(entry.productId, entry.balance);
  return stock;
}

/** How many active products are at or below their re-order level. */
export async function greenLowStockCount(clientId: number): Promise<number> {
  const products = (await db.execute(sql`
    SELECT id, reorder_level FROM green_products
     WHERE client_id = ${clientId} AND active AND reorder_level IS NOT NULL
  `)).rows as { id: number; reorder_level: number }[];
  if (!products.length) return 0;
  const stock = stockOnHand(await greenStockLedger(clientId));
  return products.filter((p) => (stock.get(p.id) ?? 0) <= Number(p.reorder_level)).length;
}
