/**
 * GreenTrack daily checks for the greenkeeping team:
 *  - the greenkeeping shed opening and closing checklists (security and fire),
 *    stored in daily_checklists as greenkeeping_opening / greenkeeping_closing
 *    with per-site templates like the kitchen and premises checklists. They
 *    are counted on their own: they never make a site's DailyTrack AM or PM
 *    count as done (lib/dailyChecklistCompletion.ts lists only those types);
 *  - each machine's pre-start (pre-use) check for the day, or a mark that the
 *    machine is not in use that day (green_machine_not_in_use).
 *
 * The team: a site's shed checks belong to one department (its greenkeepers).
 * It is the department chosen on GreenTrack's Daily checks tab
 * (daily_checklist_teams, area 'greenkeeping'), else the only department at
 * that site with "green" in its name (an exact "Greenkeeping" wins when several
 * match; a business-wide department counts only when the business has one
 * site), like the Kitchen team on "Today by department". The team's Managers are reminded, and the checks are
 * listed under the team on "Today by department".
 *
 * A site is expected to do shed checks when it has a team, or when a shed
 * checklist was submitted there in the last 30 days, so a business with
 * GreenTrack is never chased at sites with no greenkeeping.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { addCalendarDays } from "./accountClock";

export const GREENKEEPING_CHECKLIST_TYPES = ["greenkeeping_opening", "greenkeeping_closing"] as const;
export type GreenkeepingChecklistType = (typeof GREENKEEPING_CHECKLIST_TYPES)[number];

export const GREENKEEPING_CHECKLIST_NAMES: Record<GreenkeepingChecklistType, string> = {
  greenkeeping_opening: "Greenkeeping shed opening checks",
  greenkeeping_closing: "Greenkeeping shed closing checks",
};

export const GREENKEEPING_AREA = "greenkeeping";
/** A site uses shed checks when one was submitted there in this many days. */
const IN_USE_DAYS = 30;

/** Where the dashboard and reminders send people to do a site's daily checks. */
export function greenDailyChecksPath(siteId: number | null): string {
  return `/green-track?tab=daily${siteId != null ? `&siteId=${siteId}` : ""}`;
}

export function isGreenkeepingChecklistType(value: unknown): value is GreenkeepingChecklistType {
  return typeof value === "string" && (GREENKEEPING_CHECKLIST_TYPES as readonly string[]).includes(value);
}

export interface GreenkeepingTeam {
  siteId: number;
  departmentId: number;
  departmentName: string;
  /** True when someone chose it; false when it was matched by its name. */
  chosen: boolean;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);
const inList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/**
 * The departments that can work at each site (the departments-under-sites
 * rule: the site is shared or theirs, and the department spans every site or
 * sits under this one), for the team picker and the name match.
 */
export async function departmentsAtSites(
  clientId: number,
  siteIds: number[],
): Promise<Map<number, Array<{ id: number; name: string; siteId: number | null }>>> {
  const bySite = new Map<number, Array<{ id: number; name: string; siteId: number | null }>>();
  if (siteIds.length === 0) return bySite;
  const result = await db.execute(sql`
    SELECT s.id AS site_id, d.id, d.name, d.site_id AS department_site_id
    FROM sites s
    JOIN departments d ON d.client_id = s.client_id
      AND (d.site_id IS NULL OR d.site_id = s.id)
      AND (s.department_id IS NULL OR s.department_id = d.id)
    WHERE s.client_id = ${clientId} AND s.id IN (${inList(siteIds)})
    ORDER BY d.name, d.id
  `);
  for (const row of rowsOf<{ site_id: number; id: number; name: string; department_site_id: number | null }>(result)) {
    const siteId = Number(row.site_id);
    const list = bySite.get(siteId) ?? [];
    list.push({ id: Number(row.id), name: row.name, siteId: row.department_site_id == null ? null : Number(row.department_site_id) });
    bySite.set(siteId, list);
  }
  return bySite;
}

/** Each listed site's greenkeeping team, when it has one. */
export async function loadGreenkeepingTeams(clientId: number, siteIds: number[]): Promise<Map<number, GreenkeepingTeam>> {
  const teams = new Map<number, GreenkeepingTeam>();
  if (siteIds.length === 0) return teams;
  const [chosenRows, departments, siteCountRows] = await Promise.all([
    db.execute(sql`
      SELECT site_id, department_id FROM daily_checklist_teams
      WHERE client_id = ${clientId} AND area = ${GREENKEEPING_AREA} AND site_id IN (${inList(siteIds)})
    `),
    departmentsAtSites(clientId, siteIds),
    db.execute(sql`SELECT count(*)::int AS sites FROM sites WHERE client_id = ${clientId}`),
  ]);
  const oneSite = Number(rowsOf<{ sites: number }>(siteCountRows)[0]?.sites ?? 0) === 1;
  const chosen = new Map(rowsOf<{ site_id: number; department_id: number }>(chosenRows)
    .map((row) => [Number(row.site_id), Number(row.department_id)]));
  for (const siteId of siteIds) {
    const available = departments.get(siteId) ?? [];
    const picked = chosen.get(siteId);
    // A chosen team that can no longer work at the site is ignored.
    const chosenDepartment = picked != null ? available.find((department) => department.id === picked) : undefined;
    if (chosenDepartment) {
      teams.set(siteId, { siteId, departmentId: chosenDepartment.id, departmentName: chosenDepartment.name, chosen: true });
      continue;
    }
    const named = available.filter((department) => /green/i.test(department.name)
      && (department.siteId === siteId || oneSite));
    // An exact "Greenkeeping" wins when several match.
    const exact = named.filter((department) => department.name.trim().toLowerCase() === "greenkeeping");
    const match = named.length === 1 ? named[0] : exact.length === 1 ? exact[0] : undefined;
    if (match) teams.set(siteId, { siteId, departmentId: match.id, departmentName: match.name, chosen: false });
  }
  return teams;
}

export interface ShedCheckState {
  /** A checklist exists for the day (a draft or submitted). */
  started: boolean;
  submitted: boolean;
  /** Submitted with a failed item. */
  failed: boolean;
}

export type ShedDay = Record<GreenkeepingChecklistType, ShedCheckState>;

/** The day's shed opening and closing checklists at each listed site. */
export async function getGreenkeepingShedDay(clientId: number, date: string, siteIds: number[]): Promise<Map<number, ShedDay>> {
  const days = new Map<number, ShedDay>();
  for (const siteId of siteIds) {
    days.set(siteId, {
      greenkeeping_opening: { started: false, submitted: false, failed: false },
      greenkeeping_closing: { started: false, submitted: false, failed: false },
    });
  }
  if (siteIds.length === 0) return days;
  const result = await db.execute(sql`
    SELECT site_id, checklist_type,
           BOOL_OR(submitted_at IS NOT NULL) AS submitted,
           BOOL_OR(submitted_at IS NOT NULL AND jsonb_typeof(items) = 'array' AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(items) item WHERE item->>'result' = 'fail')) AS failed
    FROM daily_checklists
    WHERE client_id = ${clientId} AND check_date = ${date}
      AND checklist_type IN ('greenkeeping_opening', 'greenkeeping_closing')
      AND site_id IN (${inList(siteIds)})
    GROUP BY site_id, checklist_type
  `);
  const truthy = (value: unknown) => value === true || value === "t" || value === "true";
  for (const row of rowsOf<{ site_id: number; checklist_type: GreenkeepingChecklistType; submitted: unknown; failed: unknown }>(result)) {
    const day = days.get(Number(row.site_id));
    if (!day || !isGreenkeepingChecklistType(row.checklist_type)) continue;
    day[row.checklist_type] = { started: true, submitted: truthy(row.submitted), failed: truthy(row.failed) };
  }
  return days;
}

/**
 * The listed sites expected to do shed checks on `today`: those with a team,
 * or where a shed checklist was submitted in the last 30 days.
 */
export async function greenkeepingShedSites(
  clientId: number,
  today: string,
  siteIds: number[],
  teams?: Map<number, GreenkeepingTeam>,
): Promise<Set<number>> {
  const expected = new Set<number>();
  if (siteIds.length === 0) return expected;
  const siteTeams = teams ?? await loadGreenkeepingTeams(clientId, siteIds);
  for (const siteId of siteTeams.keys()) expected.add(siteId);
  const recent = await db.execute(sql`
    SELECT DISTINCT site_id FROM daily_checklists
    WHERE client_id = ${clientId}
      AND checklist_type IN ('greenkeeping_opening', 'greenkeeping_closing')
      AND submitted_at IS NOT NULL
      AND check_date BETWEEN ${addCalendarDays(today, -IN_USE_DAYS)} AND ${today}
      AND site_id IN (${inList(siteIds)})
  `);
  for (const row of rowsOf<{ site_id: number }>(recent)) expected.add(Number(row.site_id));
  return expected;
}

export type PreStartStatus = "checked" | "failed" | "not_in_use" | "todo";

export interface PreStartMachine {
  machineId: number;
  name: string;
  type: string | null;
  siteId: number | null;
  siteName: string | null;
  status: PreStartStatus;
  /** The day's latest pre-use check. */
  checkId: number | null;
  checkedBy: string | null;
  /** The "not in use" mark, when there is one and no check. */
  notInUseId: number | null;
  notInUseReason: string | null;
  markedBy: string | null;
}

/**
 * Every active machine's pre-start status for the day: checked (passed or
 * failed), marked not in use, or still to do. With `siteIds`, only machines
 * at those sites and machines with no site.
 */
export async function getPreStartDay(clientId: number, date: string, siteIds: number[] | null): Promise<PreStartMachine[]> {
  if (siteIds && siteIds.length === 0) return [];
  const result = await db.execute(sql`
    SELECT m.id, m.name, m.type, m.site_id, s.name AS site_name,
           c.id AS check_id, c.result, c.operator,
           n.id AS not_in_use_id, n.reason, n.marked_by_name
    FROM green_machines m
    LEFT JOIN sites s ON s.id = m.site_id AND s.client_id = m.client_id
    LEFT JOIN LATERAL (
      SELECT id, result, operator FROM green_pre_use_checks
      WHERE machine_id = m.id AND client_id = m.client_id AND check_date = ${date}
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) c ON true
    LEFT JOIN green_machine_not_in_use n ON n.machine_id = m.id AND n.client_id = m.client_id AND n.check_date = ${date}
    WHERE m.client_id = ${clientId} AND m.active = true
      ${siteIds ? sql`AND (m.site_id IS NULL OR m.site_id IN (${inList(siteIds)}))` : sql``}
    ORDER BY s.name NULLS LAST, m.name, m.id
  `);
  return rowsOf<{
    id: number; name: string; type: string | null; site_id: number | null; site_name: string | null;
    check_id: number | null; result: string | null; operator: string | null;
    not_in_use_id: number | null; reason: string | null; marked_by_name: string | null;
  }>(result).map((row) => {
    const checked = row.check_id != null;
    return {
      machineId: Number(row.id),
      name: row.name,
      type: row.type,
      siteId: row.site_id == null ? null : Number(row.site_id),
      siteName: row.site_name,
      status: checked ? (row.result === "fail" ? "failed" : "checked") : row.not_in_use_id != null ? "not_in_use" : "todo",
      checkId: checked ? Number(row.check_id) : null,
      checkedBy: checked ? row.operator : null,
      notInUseId: !checked && row.not_in_use_id != null ? Number(row.not_in_use_id) : null,
      notInUseReason: !checked ? row.reason : null,
      markedBy: !checked ? row.marked_by_name : null,
    };
  });
}
