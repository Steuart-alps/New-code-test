import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

/**
 * Daily checklists are stored in two places:
 *  - daily_checklists (web DailyTrack AM/PM, KitchenTrack): checklist_type is
 *    kitchen_opening / premises_opening (AM) or kitchen_closing /
 *    premises_closing (PM);
 *  - daily_checklist_submissions (mobile app): type is 'am' or 'pm'.
 *
 * A site's AM (or PM) period counts as done for a day when any submitted
 * checklist of that period exists in either store. Callers must count
 * DISTINCT check_date per site/period, which also absorbs duplicate rows.
 */
export const DAILY_CHECKLIST_PERIOD_SQL = sql.raw(`CASE
  WHEN checklist_type IN ('kitchen_opening', 'premises_opening', 'am') THEN 'am'
  WHEN checklist_type IN ('kitchen_closing', 'premises_closing', 'pm') THEN 'pm'
END`);

/**
 * A subquery (use as `FROM ${submittedDailyChecklists(...)} alias`) listing
 * every submitted daily checklist of one tenant in an inclusive date range,
 * from both stores. Columns: site_id (nullable), check_date ('YYYY-MM-DD'
 * text), period ('am' | 'pm'), author_id (nullable user id), submitted_at,
 * submitter_department_id and submitter_department_source (the author's
 * department when the row was created; see submitterDepartmentMigration.ts).
 * Only client_id is applied here; callers join sites and apply their own
 * site/department scope.
 */
export function submittedDailyChecklists(clientId: number, from: string, to: string): SQL {
  return sql`(
    SELECT site_id, check_date::text AS check_date,
           ${DAILY_CHECKLIST_PERIOD_SQL} AS period,
           created_by AS author_id, submitted_at,
           submitter_department_id, submitter_department_source
    FROM daily_checklists
    WHERE client_id = ${clientId}
      AND check_date BETWEEN ${from} AND ${to}
      AND submitted_at IS NOT NULL
      AND checklist_type IN ('kitchen_opening', 'premises_opening', 'kitchen_closing', 'premises_closing', 'am', 'pm')
    UNION ALL
    SELECT site_id, checklist_date AS check_date, type AS period, submitted_by_id AS author_id, submitted_at,
           submitter_department_id, submitter_department_source
    FROM daily_checklist_submissions
    WHERE client_id = ${clientId}
      AND checklist_date BETWEEN ${from} AND ${to}
      AND submitted_at IS NOT NULL
      AND type IN ('am', 'pm')
  )`;
}

/**
 * Per-site AM/PM completion for one day across both stores, e.g. for the
 * dashboard's "today" tiles. Sites outside `siteIds` are ignored; a site with
 * nothing submitted is absent from the map.
 */
export async function getDailyChecklistCompletionBySite(
  clientId: number,
  date: string,
  siteIds: number[],
): Promise<Map<number, { am: boolean; pm: boolean }>> {
  const result = new Map<number, { am: boolean; pm: boolean }>();
  if (siteIds.length === 0) return result;
  const rows = await db.execute(sql`
    SELECT site_id,
           BOOL_OR(period = 'am') AS am_submitted,
           BOOL_OR(period = 'pm') AS pm_submitted
    FROM ${submittedDailyChecklists(clientId, date, date)} checklists
    WHERE site_id IN (${sql.join(siteIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY site_id
  `);
  for (const row of rows.rows as Array<{ site_id: number; am_submitted: unknown; pm_submitted: unknown }>) {
    result.set(Number(row.site_id), {
      am: row.am_submitted === true || row.am_submitted === "true",
      pm: row.pm_submitted === true || row.pm_submitted === "true",
    });
  }
  return result;
}
