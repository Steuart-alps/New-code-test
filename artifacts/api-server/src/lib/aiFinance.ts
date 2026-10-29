import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { AI_SERVICE_KEY } from "./aiAddonItem";
import { aiUsdToGbp } from "./aiAllowance";
import { addMonthsUtc, replayAiCredit, type AiCreditLot } from "./aiCredit";
import { logger } from "./logger";

/**
 * What ALPS took for AI against what Claude cost, for the Business dashboard
 * (Steuart, 2026-10-27). All amounts are in pence, before VAT.
 *
 * - Add-on income: paid Stripe invoices, read from the synced stripe.invoices
 *   table. The first month is its own invoice (metadata addon_service=ai);
 *   renewals are the AI price's line on the subscription invoice, less any
 *   discount on that line.
 * - Top-ups: paid ai_top_ups rows. A free business's top-ups are invoiced by
 *   ALPS outside Stripe, so they are shown separately.
 * - Cost: what each request to Claude actually cost (settled ai_usage rows),
 *   converted from dollars at AI_USD_TO_GBP. Requests still running are left out.
 *
 * - Lapsed: paid-for AI use (the add-on's monthly allowance and paid top-ups)
 *   still unused 12 months after the end of its month, which comes back to
 *   ALPS (Steuart, 2026-10-27). It counts in the month it lapsed, from the
 *   same oldest-first replay that enforces the allowance (lib/aiCredit.ts),
 *   and is already part of the margin. A trial's or a free business's own
 *   allowance was never paid for, so its lapse is not counted.
 *
 * A free business (no trial end) pays nothing for its allowance, so it shows
 * its cost against no add-on income.
 */

type SqlExecutor = (query: any) => Promise<{ rows?: unknown[] }>;

export interface AiFinanceAmounts {
  /** The £15 add-on, paid through Stripe. */
  addonPence: number;
  /** Top-ups paid through Stripe. */
  topUpPence: number;
  /** Top-ups a free business agreed to, invoiced by ALPS. */
  invoicedTopUpPence: number;
  incomePence: number;
  /** What Claude charged for the requests, in pence. */
  costPence: number;
  marginPence: number;
  /** Requests to Claude. */
  requests: number;
  /** Paid-for AI use that lapsed unused, back to ALPS (already in the margin). */
  lapsedPence: number;
}

export interface AiFinanceMonth extends AiFinanceAmounts {
  /** YYYY-MM, UTC. */
  month: string;
}

export interface AiFinanceBusiness extends AiFinanceAmounts {
  clientId: number | null;
  businessName: string;
  /** Free business (no trial end): ALPS pays for its allowance. */
  free: boolean;
}

export interface AiFinance {
  months: AiFinanceMonth[];
  businesses: AiFinanceBusiness[];
  totals: AiFinanceAmounts;
  /** Dollars to pounds used for the cost. */
  usdToGbp: number;
  /** False when the Stripe invoices could not be read, so add-on income is missing. */
  addonIncomeAvailable: boolean;
}

export interface AiFinanceDependencies {
  execute?: SqlExecutor;
  /** AI_ADDON_PRICE_ID, when the add-on's price is named by hand. */
  aiPriceId?: string | null;
  usdToGbp?: number;
  now?: Date;
}

/** How far back the allowance ledger is read; older rows are pruned at start-up (lib/aiAllowance.ts). */
const AI_LEDGER_MONTHS = 25;

const empty = (): AiFinanceAmounts => ({
  addonPence: 0, topUpPence: 0, invoicedTopUpPence: 0, incomePence: 0, costPence: 0, marginPence: 0, requests: 0, lapsedPence: 0,
});

const monthOf = (value: Date | string) => new Date(value).toISOString().slice(0, 7);

/** Every UTC month the range touches, oldest first ([from, to)). */
function monthsBetween(from: Date, to: Date): string[] {
  const months: string[] = [];
  const last = new Date(to.getTime() - 1);
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  while (year < last.getUTCFullYear() || (year === last.getUTCFullYear() && month <= last.getUTCMonth())) {
    months.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    month += 1;
    if (month === 12) { month = 0; year += 1; }
  }
  return months;
}

export async function getAiFinance(range: { from: Date; to: Date }, deps: AiFinanceDependencies = {}): Promise<AiFinance> {
  const execute: SqlExecutor = deps.execute ?? ((query) => db.execute(query));
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();
  const usdToGbp = deps.usdToGbp ?? aiUsdToGbp();
  const aiPriceId = (deps.aiPriceId === undefined ? process.env.AI_ADDON_PRICE_ID : deps.aiPriceId)?.trim() ?? "";

  const clients = new Map<number, { name: string; free: boolean }>();
  const clientRows = ((await execute(sql`
    SELECT id, name, trial_ends_at IS NULL AS free FROM clients
  `)).rows ?? []) as Array<{ id: number; name: string; free: boolean }>;
  for (const row of clientRows) clients.set(Number(row.id), { name: row.name, free: Boolean(row.free) });

  type Entry = { clientId: number | null; name: string | null; at: Date | string; field: "addonPence" | "topUpPence" | "invoicedTopUpPence" | "costPence" | "lapsedPence"; pence: number; requests?: number };
  const entries: Entry[] = [];

  let addonIncomeAvailable = true;
  try {
    const addonRows = ((await execute(sql`
      WITH ai_prices AS (
        SELECT id FROM stripe.prices WHERE metadata->>'service_key' = ${AI_SERVICE_KEY}
        UNION SELECT ${aiPriceId}::text WHERE ${aiPriceId}::text <> ''
      ),
      paid AS (
        SELECT inv._raw_data AS raw,
               to_timestamp(coalesce((inv._raw_data->'status_transitions'->>'paid_at')::bigint,
                                     (inv._raw_data->>'created')::bigint)) AS paid_at
          FROM stripe.invoices inv
         WHERE inv._raw_data->>'status' = 'paid'
           AND coalesce(inv._raw_data->>'currency', 'gbp') = 'gbp'
      ),
      in_range AS (
        SELECT * FROM paid WHERE paid_at >= ${fromIso}::timestamptz AND paid_at < ${toIso}::timestamptz
      ),
      first_months AS (
        SELECT raw, paid_at,
               coalesce((raw->>'total_excluding_tax')::bigint, (raw->>'subtotal')::bigint, 0) AS pence
          FROM in_range
         WHERE raw->'metadata'->>'addon_service' = ${AI_SERVICE_KEY}
      ),
      renewals AS (
        SELECT r.raw, r.paid_at,
               coalesce((line->>'amount')::bigint, 0)
                 - coalesce((SELECT sum((d->>'amount')::bigint) FROM jsonb_array_elements(coalesce(line->'discount_amounts', '[]'::jsonb)) d), 0) AS pence
          FROM in_range r
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.raw->'lines'->'data', '[]'::jsonb)) line
         WHERE coalesce(r.raw->'metadata'->>'addon_service', '') <> ${AI_SERVICE_KEY}
           AND coalesce(line->'pricing'->'price_details'->>'price', line->'price'->>'id', line->>'price') IN (SELECT id FROM ai_prices)
      )
      SELECT c.id AS client_id, x.raw->>'customer_name' AS customer_name, x.paid_at, x.pence
        FROM (SELECT * FROM first_months UNION ALL SELECT * FROM renewals) x
        LEFT JOIN clients c ON c.stripe_customer_id = x.raw->>'customer'
    `)).rows ?? []) as Array<{ client_id: number | null; customer_name: string | null; paid_at: Date | string; pence: number | string }>;
    for (const row of addonRows) {
      entries.push({ clientId: row.client_id == null ? null : Number(row.client_id), name: row.customer_name, at: row.paid_at, field: "addonPence", pence: Number(row.pence) || 0 });
    }
  } catch (err) {
    // No synced Stripe tables (billing not set up): show cost and top-ups without the add-on.
    addonIncomeAvailable = false;
    logger.warn({ err }, "Business dashboard could not read paid Stripe invoices for AI income");
  }

  const topUpRows = ((await execute(sql`
    SELECT t.client_id, coalesce(t.settled_at, t.created_at) AS at, t.amount_pence, c.trial_ends_at IS NULL AS free
      FROM ai_top_ups t JOIN clients c ON c.id = t.client_id
     WHERE t.status = 'paid'
       AND coalesce(t.settled_at, t.created_at) >= ${fromIso}::timestamptz
       AND coalesce(t.settled_at, t.created_at) < ${toIso}::timestamptz
  `)).rows ?? []) as Array<{ client_id: number; at: Date | string; amount_pence: number; free: boolean }>;
  for (const row of topUpRows) {
    entries.push({ clientId: Number(row.client_id), name: null, at: row.at, field: row.free ? "invoicedTopUpPence" : "topUpPence", pence: Number(row.amount_pence) || 0 });
  }

  const costRows = ((await execute(sql`
    SELECT client_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
           sum(cost_usd_micros)::bigint AS micros, count(*)::int AS requests
      FROM ai_usage
     WHERE status <> 'pending'
       AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
     GROUP BY 1, 2
  `)).rows ?? []) as Array<{ client_id: number; month: string; micros: number | string; requests: number }>;
  for (const row of costRows) {
    entries.push({
      clientId: Number(row.client_id),
      name: null,
      at: `${row.month}-01T00:00:00Z`,
      field: "costPence",
      pence: (Number(row.micros) * usdToGbp) / 10_000,
      requests: Number(row.requests) || 0,
    });
  }

  entries.push(...await lapsedEntries(execute, range, deps.now ?? new Date(), usdToGbp));

  const months = new Map(monthsBetween(range.from, range.to).map((month) => [month, empty()]));
  const businesses = new Map<string, AiFinanceBusiness>();
  const totals = empty();
  for (const entry of entries) {
    const month = months.get(monthOf(entry.at)) ?? empty();
    months.set(monthOf(entry.at), month);
    const key = entry.clientId == null ? `name:${entry.name ?? ""}` : `id:${entry.clientId}`;
    let business = businesses.get(key);
    if (!business) {
      const client = entry.clientId == null ? undefined : clients.get(entry.clientId);
      business = {
        ...empty(),
        clientId: client ? entry.clientId : null,
        businessName: client?.name ?? entry.name ?? "A deleted business",
        free: client?.free ?? false,
      };
      businesses.set(key, business);
    }
    for (const amounts of [month, business, totals]) {
      amounts[entry.field] += entry.pence;
      amounts.requests += entry.requests ?? 0;
    }
  }

  const finish = <T extends AiFinanceAmounts>(amounts: T): T => {
    amounts.incomePence = amounts.addonPence + amounts.topUpPence + amounts.invoicedTopUpPence;
    amounts.marginPence = Math.round(amounts.incomePence - amounts.costPence);
    amounts.costPence = Math.round(amounts.costPence);
    amounts.lapsedPence = Math.round(amounts.lapsedPence);
    return amounts;
  };

  return {
    months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, amounts]) => finish({ month, ...amounts })),
    businesses: [...businesses.values()].map(finish)
      .sort((a, b) => b.costPence - a.costPence || b.incomePence - a.incomePence || a.businessName.localeCompare(b.businessName)),
    totals: finish(totals),
    usdToGbp,
    addonIncomeAvailable,
  };
}

/**
 * Paid-for allowance that lapsed in the range (and by now), per business:
 * each business with such a lot has its ledger replayed as the allowance
 * check does, and what a paid lot still held when it lapsed is counted.
 */
async function lapsedEntries(
  execute: SqlExecutor,
  range: { from: Date; to: Date },
  now: Date,
  usdToGbp: number,
): Promise<Array<{ clientId: number; name: null; at: Date; field: "lapsedPence"; pence: number }>> {
  const until = new Date(Math.min(range.to.getTime(), now.getTime()));
  if (until <= range.from) return [];
  const ledgerFrom = addMonthsUtc(now, -AI_LEDGER_MONTHS).toISOString();
  const fromIso = range.from.toISOString();
  const untilIso = until.toISOString();
  const lotRows = ((await execute(sql`
    WITH lots AS (
      SELECT client_id, starts_at, expires_at, allowance_pence, period_key LIKE 'addon:%' AS paid
        FROM ai_allowance_grants
      UNION ALL
      SELECT client_id, created_at, coalesce(expires_at, created_at + interval '13 months'), allowance_pence, status = 'paid'
        FROM ai_top_ups WHERE status IN ('paid', 'unknown')
    )
    SELECT * FROM lots
     WHERE expires_at > ${ledgerFrom}::timestamptz
       AND client_id IN (
         SELECT client_id FROM lots
          WHERE paid AND allowance_pence > 0
            AND expires_at >= ${fromIso}::timestamptz AND expires_at < ${untilIso}::timestamptz
       )
  `)).rows ?? []) as Array<{ client_id: number; starts_at: Date | string; expires_at: Date | string; allowance_pence: number; paid: boolean }>;
  if (lotRows.length === 0) return [];
  const clientIds = [...new Set(lotRows.map((row) => Number(row.client_id)))];
  const useRows = ((await execute(sql`
    SELECT client_id, created_at, cost_usd_micros FROM ai_usage
     WHERE created_at >= ${ledgerFrom}::timestamptz
       AND client_id IN (${sql.join(clientIds.map((id) => sql`${id}`), sql`, `)})
  `)).rows ?? []) as Array<{ client_id: number; created_at: Date | string; cost_usd_micros: number | string }>;

  const entries: Array<{ clientId: number; name: null; at: Date; field: "lapsedPence"; pence: number }> = [];
  for (const clientId of clientIds) {
    const lots: Array<AiCreditLot & { paid: boolean }> = lotRows.filter((row) => Number(row.client_id) === clientId).map((row) => ({
      startsAt: new Date(row.starts_at),
      expiresAt: new Date(row.expires_at),
      pence: Number(row.allowance_pence),
      paid: Boolean(row.paid),
    }));
    const uses = useRows.filter((row) => Number(row.client_id) === clientId).map((row) => ({
      at: new Date(row.created_at),
      pence: (Number(row.cost_usd_micros) * usdToGbp) / 10_000,
    }));
    for (const lot of replayAiCredit(lots, uses, now).lapsed as Array<AiCreditLot & { paid: boolean; remainingPence: number }>) {
      if (!lot.paid || lot.expiresAt < range.from || lot.expiresAt >= until) continue;
      entries.push({ clientId, name: null, at: lot.expiresAt, field: "lapsedPence", pence: lot.remainingPence });
    }
  }
  return entries;
}
