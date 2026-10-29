/**
 * Daily checklist teams: which department does a site's kitchen checklists
 * (kitchen_opening, kitchen_closing) and which does its premises checklists
 * (premises_opening, premises_closing), e.g. Kitchen and Clubhouse at a golf
 * club. Stored per site and area in daily_checklist_teams.
 *
 * A checklist given to a team:
 *  - is listed under that team on the dashboard's "Today by department"
 *    (lib/todayByDepartment.ts), not under "Whole site";
 *  - must be submitted on its own before the site's AM (or PM) counts as done
 *    (lib/dailyChecklistCompletion.ts), where otherwise any one checklist of
 *    the period covers the site;
 *  - is chased by its own reminder to the team's Managers
 *    (lib/trackReminders.ts).
 * A team only counts while its department can still work at the site (the
 * departments-under-sites rule); otherwise the checklist is treated as having
 * no team.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { DailyChecklistType } from "./dailyChecklistEntitlements";

export const DAILY_CHECKLIST_AREAS = ["kitchen", "premises"] as const;
export type DailyChecklistArea = (typeof DAILY_CHECKLIST_AREAS)[number];

export function areaOfChecklistType(type: DailyChecklistType): DailyChecklistArea {
  return type.startsWith("kitchen_") ? "kitchen" : "premises";
}

export interface DailyChecklistTeam {
  siteId: number;
  area: DailyChecklistArea;
  departmentId: number;
  departmentName: string;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

export const teamKey = (siteId: number, area: DailyChecklistArea) => `${siteId}:${area}`;

/**
 * The business's checklist teams, keyed by teamKey(siteId, area). Only teams
 * whose department can still work at the site are returned. `siteIds` limits
 * the result (an empty list returns nothing).
 */
export async function loadDailyChecklistTeams(
  clientId: number,
  siteIds?: number[],
): Promise<Map<string, DailyChecklistTeam>> {
  const teams = new Map<string, DailyChecklistTeam>();
  if (siteIds && siteIds.length === 0) return teams;
  const result = await db.execute(sql`
    SELECT t.site_id, t.area, t.department_id, d.name AS department_name
    FROM daily_checklist_teams t
    JOIN sites s ON s.id = t.site_id AND s.client_id = t.client_id
    JOIN departments d ON d.id = t.department_id AND d.client_id = t.client_id
    WHERE t.client_id = ${clientId}
      AND (d.site_id IS NULL OR d.site_id = t.site_id)
      AND (s.department_id IS NULL OR s.department_id = t.department_id)
      ${siteIds ? sql`AND t.site_id IN (${sql.join(siteIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
  `);
  for (const row of rowsOf<{ site_id: number; area: DailyChecklistArea; department_id: number; department_name: string }>(result)) {
    const team = {
      siteId: Number(row.site_id),
      area: row.area,
      departmentId: Number(row.department_id),
      departmentName: row.department_name,
    };
    teams.set(teamKey(team.siteId, team.area), team);
  }
  return teams;
}
