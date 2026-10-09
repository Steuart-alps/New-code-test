// Read-side aggregation for first-party analytics, shared by the API's
// token-protected summary route and the `analytics:report` CLI so both return
// identical numbers. Pure: it takes a pg-style queryable and never opens a
// connection itself (importing it does not require DATABASE_URL).

export interface AnalyticsQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface AnalyticsSummaryQuery {
  /** Inclusive first UTC day, YYYY-MM-DD. */
  from: string;
  /** Inclusive last UTC day, YYYY-MM-DD. */
  to: string;
  event: string | null;
  groupBy: string | null;
}

export interface AnalyticsSummaryRow {
  date: string;
  event: string;
  /** Dimension value when grouped; omitted otherwise. */
  value?: string;
  count: number;
}

export interface AnalyticsSummary {
  from: string;
  to: string;
  timezone: "UTC";
  event: string | null;
  groupBy: string | null;
  total: number;
  /** Counts over the whole range per event (and per dimension value when grouped). */
  totals: Omit<AnalyticsSummaryRow, "date">[];
  /** Daily counts per event (and per dimension value when grouped); empty days are omitted. */
  daily: AnalyticsSummaryRow[];
}

export const ANALYTICS_MAX_RANGE_DAYS = 400;
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses a real calendar date in YYYY-MM-DD form to UTC midnight, or null. */
export function parseAnalyticsDay(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return time;
}

/**
 * Validates summary parameters. Error messages are fixed strings: they never
 * echo the supplied values back.
 */
export function validateAnalyticsSummaryQuery(input: {
  from?: unknown; to?: unknown; event?: unknown; groupBy?: unknown;
}): { ok: true; query: AnalyticsSummaryQuery } | { ok: false; error: string } {
  const from = parseAnalyticsDay(input.from);
  const to = parseAnalyticsDay(input.to);
  if (from === null || to === null) return { ok: false, error: "from and to must be dates in YYYY-MM-DD form" };
  if (to < from) return { ok: false, error: "to must not be before from" };
  if ((to - from) / DAY_MS + 1 > ANALYTICS_MAX_RANGE_DAYS) {
    return { ok: false, error: `The date range may cover at most ${ANALYTICS_MAX_RANGE_DAYS} days` };
  }
  const optionalName = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null || value === "") return null;
    return typeof value === "string" && NAME_PATTERN.test(value) ? value : undefined;
  };
  const event = optionalName(input.event);
  if (event === undefined) return { ok: false, error: "event must be a lower-case event name" };
  const groupBy = optionalName(input.groupBy);
  if (groupBy === undefined) return { ok: false, error: "groupBy must be a lower-case dimension name" };
  return {
    ok: true,
    query: { from: input.from as string, to: input.to as string, event, groupBy },
  };
}

/**
 * Daily counts per event, optionally narrowed to one event and split by one
 * dimension. With groupBy, only events that carry that dimension are counted.
 * Days are UTC calendar days.
 */
export async function queryAnalyticsSummary(
  db: AnalyticsQueryable,
  query: AnalyticsSummaryQuery,
): Promise<AnalyticsSummary> {
  const result = await db.query(
    `SELECT to_char(("occurred_at" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS "date",
            "event_name" AS "event",
            CASE WHEN $4::text IS NULL THEN NULL ELSE "dimensions" ->> $4::text END AS "value",
            count(*)::int AS "count"
       FROM "analytics_events"
      WHERE "occurred_at" >= ($1::date::timestamp AT TIME ZONE 'UTC')
        AND "occurred_at" < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND ($3::text IS NULL OR "event_name" = $3::text)
        AND ($4::text IS NULL OR "dimensions" ? $4::text)
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`,
    [query.from, query.to, query.event, query.groupBy],
  );
  const daily: AnalyticsSummaryRow[] = result.rows.map((row) => ({
    date: String(row.date),
    event: String(row.event),
    ...(query.groupBy ? { value: String(row.value) } : {}),
    count: Number(row.count),
  }));
  const totalsByKey = new Map<string, Omit<AnalyticsSummaryRow, "date">>();
  for (const row of daily) {
    const key = `${row.event}\u0000${row.value ?? ""}`;
    const existing = totalsByKey.get(key);
    if (existing) existing.count += row.count;
    else totalsByKey.set(key, { event: row.event, ...(query.groupBy ? { value: row.value } : {}), count: row.count });
  }
  const totals = [...totalsByKey.values()].sort((a, b) =>
    a.event.localeCompare(b.event) || (a.value ?? "").localeCompare(b.value ?? ""));
  return {
    from: query.from,
    to: query.to,
    timezone: "UTC",
    event: query.event,
    groupBy: query.groupBy,
    total: daily.reduce((sum, row) => sum + row.count, 0),
    totals,
    daily,
  };
}

/** Plain-text rendering used by the CLI. */
export function formatAnalyticsSummary(summary: AnalyticsSummary): string {
  const lines: string[] = [];
  const scope = [
    `${summary.from} to ${summary.to} (UTC)`,
    summary.event ? `event=${summary.event}` : "all events",
    summary.groupBy ? `grouped by ${summary.groupBy}` : null,
  ].filter(Boolean).join(", ");
  lines.push(`Analytics summary: ${scope}`);
  lines.push(`Total events: ${summary.total}`);
  if (summary.total === 0) return lines.join("\n");
  const label = (row: { event: string; value?: string }) =>
    summary.groupBy ? `${row.event} [${summary.groupBy}=${row.value}]` : row.event;
  lines.push("", "Totals:");
  for (const row of summary.totals) lines.push(`  ${String(row.count).padStart(7)}  ${label(row)}`);
  lines.push("", "Daily:");
  for (const row of summary.daily) lines.push(`  ${row.date}  ${String(row.count).padStart(7)}  ${label(row)}`);
  return lines.join("\n");
}
