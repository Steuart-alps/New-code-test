/**
 * The dashboard's "Today by department" card: for each site, one bar per
 * department showing today's checks as done, not done yet or failed, plus a
 * "Whole site" bar for work that belongs to the site rather than one team.
 *
 * What counts (all on the business's local calendar day):
 *  - Whole site: the daily checklists and manager sign-off the client's
 *    services expect at every site (dailyTrackRequirements), web and phone.
 *    A submitted checklist with a failed item counts as failed.
 *  - A department: checks saved today by its staff (the department recorded
 *    on the record, never the author's current one), failed when the result
 *    is a fail; tasks due today assigned to one of its people; and compliance
 *    checks given to it that are due today or overdue, or completed today.
 *  - Work with no department (role-group tasks, checks not given to a
 *    department, records by people without one) goes to Whole site.
 *
 * Owners and consultants see every department. Managers see the departments
 * they cover; other people only their own. Who sees the card at all is the
 * Owner's choice (TODAY_BY_DEPARTMENT_ROLES_SETTING).
 */

import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import type { SafeUser } from "@workspace/db/schema";
import { dailyTrackRequirements, type DailyTrackRequirement } from "./dailyChecklistEntitlements";
import { getEntitledServices } from "./services";
import { getAccountTimezone, localDateIn, addCalendarDays, zonedDateTimeToUtc } from "./accountClock";
import { occursOn } from "./taskSchedule";
import { submittedDailyChecklists } from "./dailyChecklistCompletion";

export const TODAY_BY_DEPARTMENT_ROLES_SETTING = "todayByDepartmentRoles";

/** Which people besides Owners see the card. Owners and consultants always do. */
export interface TodayByDepartmentRoles {
  /** Heads of Department (Managers, and Staff with the older department-manager switch). */
  managers: boolean;
  /** Anyone marked as a maintenance manager. */
  maintenance: boolean;
  /** Everyone else with a login, for their own department. */
  staff: boolean;
}

export const DEFAULT_TODAY_BY_DEPARTMENT_ROLES: TodayByDepartmentRoles = {
  managers: true,
  maintenance: true,
  staff: false,
};

/** The stored setting, with defaults for anything missing or unreadable. */
export function parseTodayByDepartmentRoles(value: string | null | undefined): TodayByDepartmentRoles {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch { /* fall back to the defaults */ }
  const pick = (key: keyof TodayByDepartmentRoles) =>
    typeof stored[key] === "boolean" ? stored[key] as boolean : DEFAULT_TODAY_BY_DEPARTMENT_ROLES[key];
  return { managers: pick("managers"), maintenance: pick("maintenance"), staff: pick("staff") };
}

/** A settings value to store, or null when the body is not three booleans. */
export function normalizeTodayByDepartmentRoles(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_TODAY_BY_DEPARTMENT_ROLES) as Array<keyof TodayByDepartmentRoles>;
  if (Object.keys(record).some((key) => !keys.includes(key as keyof TodayByDepartmentRoles))) return null;
  if (keys.some((key) => record[key] !== undefined && typeof record[key] !== "boolean")) return null;
  const roles = parseTodayByDepartmentRoles(JSON.stringify(record));
  return JSON.stringify(roles);
}

type Viewer = Pick<SafeUser, "role" | "allDepartments" | "isDepartmentManager" | "isMaintenanceManager">;

/** Whether this person sees the card, given the Owner's choice. */
export function canSeeTodayByDepartment(user: Viewer, roles: TodayByDepartmentRoles): boolean {
  if (user.role === "client_admin" || user.role === "consultant") return true;
  if (user.role === "client_viewer") return false;
  const headOfDepartment = user.role === "client_manager"
    || (user.role === "client_staff" && user.isDepartmentManager === true);
  if (headOfDepartment && roles.managers) return true;
  if (user.isMaintenanceManager === true && roles.maintenance) return true;
  return user.role === "client_staff" && roles.staff;
}

export type TodayOutcome = "done" | "todo" | "failed";

export interface TodayItem {
  status: "todo" | "failed";
  label: string;
  detail: string;
  path: string;
}

export interface TodayRow {
  /** "site" for the Whole site bar, otherwise the department id. */
  key: string;
  kind: "whole_site" | "department";
  departmentId: number | null;
  name: string;
  done: number;
  todo: number;
  failed: number;
  /** Outstanding work (failed first), at most MAX_ITEMS; moreItems counts the rest. */
  items: TodayItem[];
  moreItems: number;
}

export interface TodayGroup {
  /** null for the "All sites" group of work not tied to one site. */
  siteId: number | null;
  siteName: string;
  rows: TodayRow[];
}

export interface TodayByDepartment {
  date: string;
  groups: TodayGroup[];
}

export interface TodayEntry {
  siteId: number | null;
  departmentId: number | null;
  outcome: TodayOutcome;
  /** Required for todo/failed entries: what is outstanding. */
  label?: string;
  detail?: string;
  path?: string;
}

export interface TodaySite { id: number; name: string; departmentId: number | null }
export interface TodayDepartment { id: number; name: string; siteId: number | null }

export const MAX_ITEMS = 20;
export const ALL_SITES_LABEL = "All sites";
export const WHOLE_SITE_LABEL = "Whole site";

/** The departments-under-sites rule (lib/departmentSites) for loaded rows. */
export function departmentAtSite(site: TodaySite, department: TodayDepartment): boolean {
  return (site.departmentId === null || site.departmentId === department.id)
    && (department.siteId === null || department.siteId === site.id);
}

function emptyRow(kind: TodayRow["kind"], department: TodayDepartment | null): TodayRow {
  return {
    key: department ? String(department.id) : "site",
    kind,
    departmentId: department?.id ?? null,
    name: department?.name ?? WHOLE_SITE_LABEL,
    done: 0, todo: 0, failed: 0, items: [], moreItems: 0,
  };
}

/**
 * Groups today's entries into site groups and bars. Every department a site
 * shows gets a bar (an empty one says nothing was due or saved), so an Owner
 * can see which teams have not started. Entries without a site fold into the
 * only site when there is one, and otherwise form an "All sites" group.
 * Entries for a department not shown at that site count for Whole site.
 */
export function buildTodayByDepartment(input: {
  date: string;
  sites: TodaySite[];
  departments: TodayDepartment[];
  entries: TodayEntry[];
  /** True when the caller asked for one site: work without a site is left out. */
  siteFiltered?: boolean;
}): TodayByDepartment {
  const { date, sites, departments, entries } = input;
  const byName = (a: { name: string; id: number }, b: { name: string; id: number }) =>
    a.name.localeCompare(b.name) || a.id - b.id;
  const sortedDepartments = [...departments].sort(byName);
  const groups = new Map<number | null, { group: TodayGroup; rows: Map<string, TodayRow>; shown: Map<number, TodayDepartment> }>();

  for (const site of [...sites].sort(byName)) {
    const rows = new Map<string, TodayRow>();
    rows.set("site", emptyRow("whole_site", null));
    const shown = new Map<number, TodayDepartment>();
    for (const department of sortedDepartments) {
      if (!departmentAtSite(site, department)) continue;
      shown.set(department.id, department);
      rows.set(String(department.id), emptyRow("department", department));
    }
    groups.set(site.id, { group: { siteId: site.id, siteName: site.name, rows: [] }, rows, shown });
  }
  const foldSiteless = sites.length === 1 && !input.siteFiltered;
  const allSites = () => {
    let entry = groups.get(null);
    if (!entry) {
      const rows = new Map<string, TodayRow>([["site", emptyRow("whole_site", null)]]);
      entry = { group: { siteId: null, siteName: ALL_SITES_LABEL, rows: [] }, rows, shown: new Map(sortedDepartments.map((d) => [d.id, d])) };
      groups.set(null, entry);
    }
    return entry;
  };

  const pending = new Map<TodayRow, TodayItem[]>();
  for (const item of entries) {
    let target;
    if (item.siteId === null) {
      if (input.siteFiltered) continue;
      target = foldSiteless ? groups.get(sites[0].id) : allSites();
    } else {
      target = groups.get(item.siteId);
    }
    if (!target) continue;
    let row = target.rows.get("site")!;
    if (item.departmentId !== null) {
      const department = target.shown.get(item.departmentId);
      if (department) {
        row = target.rows.get(String(department.id)) ?? emptyRow("department", department);
        target.rows.set(String(department.id), row);
      }
    }
    row[item.outcome]++;
    if (item.outcome !== "done") {
      const list = pending.get(row) ?? [];
      list.push({ status: item.outcome, label: item.label ?? "", detail: item.detail ?? "", path: item.path ?? "/dashboard" });
      pending.set(row, list);
    }
  }
  for (const [row, items] of pending) {
    items.sort((a, b) => (a.status === b.status ? 0 : a.status === "failed" ? -1 : 1));
    row.items = items.slice(0, MAX_ITEMS);
    row.moreItems = Math.max(0, items.length - MAX_ITEMS);
  }

  const result: TodayGroup[] = [];
  for (const [siteId, { group, rows }] of groups) {
    const total = (row: TodayRow) => row.done + row.todo + row.failed;
    const all = [...rows.values()];
    // Whole site leads when it has work; an empty one adds nothing.
    group.rows = all.filter((row) => row.kind === "department" || total(row) > 0);
    // In "All sites", only teams with business-wide work today.
    if (siteId === null) group.rows = group.rows.filter((row) => total(row) > 0);
    if (group.rows.length > 0) result.push(group);
  }
  // "All sites" goes last.
  result.sort((a, b) => (a.siteId === null ? 1 : 0) - (b.siteId === null ? 1 : 0));
  return { date, groups: result };
}

// ── Loading ───────────────────────────────────────────────────────────────────

const CHECKLIST_NAMES: Record<DailyTrackRequirement, string> = {
  kitchen_opening: "Kitchen opening checks",
  premises_opening: "Premises opening checks",
  kitchen_closing: "Kitchen closing checks",
  premises_closing: "Premises closing checks",
  signoff: "Manager sign-off",
};

/** Results the action register treats as a failure (sync_track_action_from_source), minus "monitor". */
const FAILED_RESULT_SQL = sql.raw(`('fail', 'failed', 'action_required', 'urgent_action', 'urgent', 'out_of_range', 'unsafe')`);

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []);
}

function inList(ids: number[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

export interface TodayScope {
  clientId: number;
  /** One site only (the dashboard's site filter), already checked as visible. */
  siteId: number | null;
  /** null: every department. Otherwise the departments this person covers (may be empty). */
  departmentIds: number[] | null;
}

/**
 * The departments a person covers on this card (null = every department):
 * all of a Manager's departments (req.departmentIds), not only the one they
 * are working in, and otherwise the person's own.
 */
export function todayDepartmentScope(
  user: Pick<SafeUser, "role" | "allDepartments" | "departmentId">,
  managerDepartmentIds?: number[],
): number[] | null {
  if (user.role === "client_admin" || user.role === "consultant") return null;
  if (user.role === "client_manager" && user.allDepartments === true) return null;
  const ids = new Set<number>(user.role === "client_manager" ? managerDepartmentIds ?? [] : []);
  if (user.departmentId != null) ids.add(user.departmentId);
  return [...ids];
}

export async function getTodayByDepartment(scope: TodayScope, now: Date = new Date()): Promise<TodayByDepartment> {
  const { clientId, siteId, departmentIds } = scope;
  const timeZone = await getAccountTimezone(clientId);
  const today = localDateIn(timeZone, now);
  const dayStart = zonedDateTimeToUtc(today, "00:00", timeZone);
  const dayEnd = zonedDateTimeToUtc(addCalendarDays(today, 1), "00:00", timeZone);

  const [siteRows, departmentRows] = await Promise.all([
    db.execute(sql`
      SELECT id, name, department_id FROM sites
      WHERE client_id = ${clientId} ${siteId != null ? sql`AND id = ${siteId}` : sql``}
    `),
    db.execute(sql`
      SELECT id, name, site_id FROM departments
      WHERE client_id = ${clientId}
        ${departmentIds !== null ? (departmentIds.length ? sql`AND id IN (${inList(departmentIds)})` : sql`AND false`) : sql``}
    `),
  ]);
  const departments: TodayDepartment[] = rows<{ id: number; name: string; site_id: number | null }>(departmentRows)
    .map((row) => ({ id: Number(row.id), name: row.name, siteId: row.site_id == null ? null : Number(row.site_id) }));
  let sites: TodaySite[] = rows<{ id: number; name: string; department_id: number | null }>(siteRows)
    .map((row) => ({ id: Number(row.id), name: row.name, departmentId: row.department_id == null ? null : Number(row.department_id) }));
  if (departmentIds !== null) {
    // Shared sites, plus the sites any of the person's departments can see.
    sites = sites.filter((site) => departments.length === 0
      ? site.departmentId === null
      : departments.some((department) => departmentAtSite(site, department)));
  }
  const siteIds = sites.map((site) => site.id);
  if (siteIds.length === 0) return { date: today, groups: [] };

  const entries: TodayEntry[] = [];
  const inScope = (departmentId: number | null) =>
    departmentId === null || departmentIds === null || departmentIds.includes(departmentId);
  const push = (entry: TodayEntry) => {
    // Work recorded for a team this person does not cover is not theirs to see here.
    if (inScope(entry.departmentId)) entries.push(entry);
  };
  const siteIn = inList(siteIds);
  // Site-less work is shown only without a site filter.
  const siteOrNone = (column: SQL) => siteId != null
    ? sql`${column} IN (${siteIn})`
    : sql`(${column} IS NULL OR ${column} IN (${siteIn}))`;

  // ── Whole site: daily checklists and sign-off ───────────────────────────────
  const requirements = dailyTrackRequirements(await getEntitledServices(clientId));
  if (requirements.length > 0) {
    const hasFail = (column: string) => sql.raw(`(jsonb_typeof(${column}) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(${column}) answer WHERE answer->>'result' = 'fail'))`);
    const [web, phone, signoffs] = await Promise.all([
      db.execute(sql`
        SELECT site_id, checklist_type, submitted_at IS NOT NULL AS submitted, ${hasFail("items")} AS failed
        FROM daily_checklists
        WHERE client_id = ${clientId} AND check_date = ${today} AND site_id IN (${siteIn})
      `),
      db.execute(sql`
        SELECT site_id, type, ${hasFail("answers")} AS failed, signed_off_at IS NOT NULL AS signed_off
        FROM daily_checklist_submissions
        WHERE client_id = ${clientId} AND checklist_date = ${today} AND site_id IN (${siteIn})
          AND submitted_at IS NOT NULL
      `),
      db.execute(sql`
        SELECT site_id FROM daily_manager_signoffs
        WHERE client_id = ${clientId} AND signoff_date = ${today} AND site_id IN (${siteIn})
          AND submitted_at IS NOT NULL
      `),
    ]);
    type State = { submitted: boolean; failed: boolean; started: boolean };
    const state = new Map<string, State>();
    const mark = (site: number, requirement: string, change: Partial<State>) => {
      const key = `${site}:${requirement}`;
      const current = state.get(key) ?? { submitted: false, failed: false, started: false };
      state.set(key, {
        submitted: current.submitted || change.submitted === true,
        failed: current.failed || change.failed === true,
        started: current.started || change.started === true,
      });
    };
    const truthy = (value: unknown) => value === true || value === "t" || value === "true";
    for (const row of rows<{ site_id: number; checklist_type: string; submitted: unknown; failed: unknown }>(web)) {
      const submitted = truthy(row.submitted);
      mark(Number(row.site_id), row.checklist_type, { started: true, submitted, failed: submitted && truthy(row.failed) });
    }
    // The phone app records one AM and one PM checklist; it stands for every
    // checklist of that period, as on the dashboard's "Today's checklists".
    for (const row of rows<{ site_id: number; type: string; failed: unknown; signed_off: unknown }>(phone)) {
      for (const requirement of requirements) {
        const period = requirement.endsWith("_opening") ? "am" : requirement.endsWith("_closing") ? "pm" : null;
        if (period === row.type) mark(Number(row.site_id), requirement, { submitted: true, failed: truthy(row.failed) });
      }
      if (row.type === "pm" && truthy(row.signed_off)) mark(Number(row.site_id), "signoff", { submitted: true });
    }
    for (const row of rows<{ site_id: number }>(signoffs)) mark(Number(row.site_id), "signoff", { submitted: true });

    for (const site of sites) {
      for (const requirement of requirements) {
        const current = state.get(`${site.id}:${requirement}`);
        const path = requirement.endsWith("_opening") ? "/daily-track-am" : "/daily-track-pm";
        const label = CHECKLIST_NAMES[requirement];
        if (current?.submitted) {
          push(current.failed
            ? { siteId: site.id, departmentId: null, outcome: "failed", label, detail: "Submitted with a failed item", path }
            : { siteId: site.id, departmentId: null, outcome: "done" });
        } else {
          push({
            siteId: site.id, departmentId: null, outcome: "todo", label,
            detail: current?.started ? "Started, not submitted yet" : "Not submitted yet", path,
          });
        }
      }
    }
  }

  // ── Checks saved today by each department ───────────────────────────────────
  // The tables that record the submitter's department (SUBMITTER_DEPARTMENT_TABLES),
  // less the daily checklists (Whole site) and incidents and FixTrack issues,
  // which report problems rather than complete checks.
  const recordSources: Array<{ name: string; path: string; query: SQL }> = [
    { name: "Fire safety check", path: "/fire-safety", query: sql`
      SELECT site_id, check_type AS detail, result, submitter_department_id, submitter_department_source
      FROM fire_safety_checks WHERE client_id = ${clientId} AND check_date = ${today}` },
    { name: "Legionella check", path: "/legionella", query: sql`
      SELECT site_id, check_type, result, submitter_department_id, submitter_department_source
      FROM legionella_checks WHERE client_id = ${clientId} AND check_date = ${today}` },
    { name: "Spa check", path: "/hot-tub", query: sql`
      SELECT site_id, check_type, result, submitter_department_id, submitter_department_source
      FROM hot_tub_checks WHERE client_id = ${clientId} AND check_date = ${today}` },
    { name: "Tree inspection", path: "/tree-track", query: sql`
      SELECT site_id, check_type, result, submitter_department_id, submitter_department_source
      FROM tree_inspections WHERE client_id = ${clientId} AND check_date = ${today}` },
    { name: "Pool check", path: "/aqua-track", query: sql`
      SELECT site_id, check_type, result, submitter_department_id, submitter_department_source
      FROM pool_checks WHERE client_id = ${clientId} AND check_date = ${today}` },
    { name: "Swim session", path: "/aqua-track", query: sql`
      SELECT site_id, NULL::text, result, submitter_department_id, submitter_department_source
      FROM swim_sessions WHERE client_id = ${clientId} AND session_date = ${today}` },
    { name: "PAT test", path: "/pat-track", query: sql`
      SELECT site_id_snapshot, NULL::text, result, submitter_department_id, submitter_department_source
      FROM pat_tests WHERE client_id = ${clientId} AND test_date = ${today}` },
    { name: "Premises inspection", path: "/premises-track", query: sql`
      SELECT site_id, NULL::text, NULL::text, submitter_department_id, submitter_department_source
      FROM premises_inspections WHERE client_id = ${clientId} AND inspection_date = ${today}` },
    { name: "Pest visit", path: "/pest-track", query: sql`
      SELECT site_id, NULL::text, NULL::text, submitter_department_id, submitter_department_source
      FROM pest_visits WHERE client_id = ${clientId} AND visit_date = ${today}` },
    { name: "Food safety record", path: "/kitchen", query: sql`
      SELECT site_id, NULL::text, NULL::text, submitter_department_id, submitter_department_source
      FROM food_safety_records WHERE client_id = ${clientId} AND record_date = ${today} AND submitted_at IS NOT NULL` },
    { name: "Kitchen cleaning log", path: "/kitchen", query: sql`
      SELECT site_id, NULL::text, NULL::text, submitter_department_id, submitter_department_source
      FROM kitchen_cleaning_logs WHERE client_id = ${clientId} AND log_date = ${today}` },
  ];
  const recordRows = await db.execute(sql`
    SELECT source, site_id, detail, lower(coalesce(result, '')) IN ${FAILED_RESULT_SQL} AS failed,
           CASE WHEN submitter_department_source = 'recorded' THEN submitter_department_id END AS department_id
    FROM (${sql.join(recordSources.map((source, index) => sql`
      SELECT ${index}::int AS source, records.* FROM (${source.query}) AS records(site_id, detail, result, submitter_department_id, submitter_department_source)
    `), sql` UNION ALL `)}) activity
    WHERE site_id IN (${siteIn})
  `);
  for (const row of rows<{ source: number; site_id: number; detail: string | null; failed: unknown; department_id: number | null }>(recordRows)) {
    const source = recordSources[Number(row.source)];
    const failed = row.failed === true || row.failed === "t";
    const detail = row.detail ? row.detail.replace(/_/g, " ") : "";
    push({
      siteId: Number(row.site_id),
      departmentId: row.department_id == null ? null : Number(row.department_id),
      outcome: failed ? "failed" : "done",
      label: `${source.name} failed`,
      detail: detail ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)} saved today with a failed result` : "Saved today with a failed result",
      path: source.path,
    });
  }

  // ── Tasks due today ─────────────────────────────────────────────────────────
  const taskRows = await db.execute(sql`
    SELECT t.id, t.title, t.site_id, t.recurrence, t.starts_on::text AS starts_on, t.assignee_role,
           u.name AS assignee_name,
           CASE WHEN u.role = 'client_manager' AND u.all_departments THEN NULL ELSE u.department_id END AS department_id,
           (EXISTS (SELECT 1 FROM task_completions c
                    WHERE c.task_id = t.id AND c.client_id = t.client_id AND c.occurrence_date = ${today})
            -- DailyTrack tasks tick themselves once the site's checklist is in (routes/tasks.ts).
            OR (t.module IN ('dailytrack_am', 'dailytrack_pm') AND EXISTS (
              SELECT 1 FROM ${submittedDailyChecklists(clientId, today, today)} submitted
              WHERE submitted.site_id = t.site_id
                AND submitted.period = CASE t.module WHEN 'dailytrack_am' THEN 'am' ELSE 'pm' END))) AS done
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_user_id AND u.client_id = t.client_id
    WHERE t.client_id = ${clientId} AND t.active = true AND t.starts_on <= ${today}
      AND ${siteOrNone(sql`t.site_id`)}
  `);
  for (const row of rows<{
    id: number; title: string; site_id: number | null; recurrence: string; starts_on: string;
    assignee_role: string | null; assignee_name: string | null; department_id: number | null; done: unknown;
  }>(taskRows)) {
    if (!occursOn({ recurrence: row.recurrence, startsOn: row.starts_on }, today)) continue;
    const done = row.done === true || row.done === "t";
    const who = row.assignee_name
      ?? (row.assignee_role === "managers" ? "managers" : row.assignee_role === "client_staff" ? "all staff" : null);
    push({
      siteId: row.site_id == null ? null : Number(row.site_id),
      departmentId: row.department_id == null ? null : Number(row.department_id),
      outcome: done ? "done" : "todo",
      label: row.title,
      detail: who ? `Task for ${who}, due today` : "Task due today",
      path: "/tasks",
    });
  }

  // ── Compliance checks due today, overdue, or completed today ───────────────
  const itemRows = await db.execute(sql`
    SELECT id, title, site_id, department_id, assigned_to, due_date::date::text AS due_day,
           (status <> 'completed' AND due_date IS NOT NULL AND due_date::date <= ${today}) AS outstanding
    FROM compliance_items
    WHERE client_id = ${clientId}
      AND ${siteOrNone(sql`site_id`)}
      AND (
        (status <> 'completed' AND due_date IS NOT NULL AND due_date::date <= ${today})
        OR (completed_at >= ${dayStart} AND completed_at < ${dayEnd})
      )
  `);
  for (const row of rows<{
    id: number; title: string; site_id: number | null; department_id: number | null;
    assigned_to: string | null; due_day: string | null; outstanding: unknown;
  }>(itemRows)) {
    const outstanding = row.outstanding === true || row.outstanding === "t";
    const due = row.due_day === today
      ? "Due today"
      : row.due_day
        ? `Overdue since ${new Date(`${row.due_day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`
        : "Due";
    push({
      siteId: row.site_id == null ? null : Number(row.site_id),
      departmentId: row.department_id == null ? null : Number(row.department_id),
      outcome: outstanding ? "todo" : "done",
      label: row.title,
      detail: row.assigned_to?.trim() ? `${due} · ${row.assigned_to.trim()}` : due,
      path: `/items/${row.id}`,
    });
  }

  return buildTodayByDepartment({ date: today, sites, departments, entries, siteFiltered: siteId != null });
}
