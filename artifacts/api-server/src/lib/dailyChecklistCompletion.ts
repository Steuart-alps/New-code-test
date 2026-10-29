import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { DAILY_CHECKLIST_TYPES, canAccessDailyChecklistType, type DailyChecklistType } from "./dailyChecklistEntitlements";
import { areaOfChecklistType, loadDailyChecklistTeams, teamKey, type DailyChecklistTeam } from "./dailyChecklistTeams";
import { getEntitledServices } from "./services";

/**
 * Daily checklists are stored in two places:
 *  - daily_checklists (web DailyTrack AM/PM, KitchenTrack): checklist_type is
 *    kitchen_opening / premises_opening (AM) or kitchen_closing /
 *    premises_closing (PM);
 *  - daily_checklist_submissions (mobile app): type is 'am' or 'pm'.
 *
 * A site's AM (or PM) period counts as done for a day when any submitted
 * checklist of that period exists in either store and, where a checklist of
 * it is given to a team, that one too (getDailyChecklistDayBySite). Callers
 * of submittedDailyChecklists must count DISTINCT check_date per site/period,
 * which also absorbs duplicate rows.
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

export interface SiteChecklistDay {
  am: boolean;
  pm: boolean;
  /** Checklists given to a team (lib/dailyChecklistTeams.ts) and not yet submitted. */
  teamOutstanding: Array<{ type: DailyChecklistType; team: DailyChecklistTeam }>;
}

/**
 * Per-site AM/PM completion for one day across both stores. A period is done
 * when any checklist of it has been submitted and every checklist of it that
 * is given to a team (and the business can open) has been submitted too; a
 * phone-app submission stands for every checklist of its period. Every site
 * in `siteIds` gets an entry; sites outside it are ignored.
 */
export async function getDailyChecklistDayBySite(
  clientId: number,
  date: string,
  siteIds: number[],
): Promise<Map<number, SiteChecklistDay>> {
  const result = new Map<number, SiteChecklistDay>();
  if (siteIds.length === 0) return result;
  const siteIn = sql.join(siteIds.map((id) => sql`${id}`), sql`, `);
  const [rows, teams] = await Promise.all([
    db.execute(sql`
      SELECT DISTINCT site_id, checklist_type AS kind
      FROM daily_checklists
      WHERE client_id = ${clientId} AND check_date = ${date} AND submitted_at IS NOT NULL
        AND site_id IN (${siteIn})
        AND checklist_type IN ('kitchen_opening', 'premises_opening', 'kitchen_closing', 'premises_closing', 'am', 'pm')
      UNION
      SELECT DISTINCT site_id, type AS kind
      FROM daily_checklist_submissions
      WHERE client_id = ${clientId} AND checklist_date = ${date} AND submitted_at IS NOT NULL
        AND site_id IN (${siteIn}) AND type IN ('am', 'pm')
    `),
    loadDailyChecklistTeams(clientId, siteIds),
  ]);
  const services = teams.size > 0 ? await getEntitledServices(clientId) : null;
  const submitted = new Map<number, Set<string>>();
  for (const row of (rows.rows as Array<{ site_id: number; kind: string }>)) {
    const kinds = submitted.get(Number(row.site_id)) ?? new Set<string>();
    kinds.add(row.kind);
    submitted.set(Number(row.site_id), kinds);
  }
  for (const siteId of siteIds) {
    const kinds = submitted.get(siteId) ?? new Set<string>();
    const day: SiteChecklistDay = { am: false, pm: false, teamOutstanding: [] };
    for (const period of ["am", "pm"] as const) {
      const types = DAILY_CHECKLIST_TYPES[period];
      const any = kinds.has(period) || types.some((type) => kinds.has(type));
      let teamMissing = false;
      for (const type of types) {
        const team = teams.get(teamKey(siteId, areaOfChecklistType(type)));
        if (!team || !services || !canAccessDailyChecklistType(services, period, type)) continue;
        if (kinds.has(type) || kinds.has(period)) continue;
        day.teamOutstanding.push({ type, team });
        teamMissing = true;
      }
      day[period] = any && !teamMissing;
    }
    result.set(siteId, day);
  }
  return result;
}

/**
 * Per-site AM/PM completion for one day (see getDailyChecklistDayBySite), e.g.
 * for the dashboard's "today" tiles. Sites outside `siteIds` are ignored; a
 * site with nothing submitted is absent from the map.
 */
export async function getDailyChecklistCompletionBySite(
  clientId: number,
  date: string,
  siteIds: number[],
): Promise<Map<number, { am: boolean; pm: boolean }>> {
  const result = new Map<number, { am: boolean; pm: boolean }>();
  for (const [siteId, day] of await getDailyChecklistDayBySite(clientId, date, siteIds)) {
    if (day.am || day.pm) result.set(siteId, { am: day.am, pm: day.pm });
  }
  return result;
}
