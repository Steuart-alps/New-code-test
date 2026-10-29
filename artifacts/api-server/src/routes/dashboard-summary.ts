/**
 * GET /api/dashboard/summary?siteId=N
 *
 * Returns a per-track status summary for the dashboard.
 * Each track shows a status (ok/attention/overdue/no_data), a badge label,
 * and a list of specific outstanding items with links to complete them.
 */

import { Router } from "express";
import { historicalTestDepartmentScope } from "../lib/patLegacyHistoryScope";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { requireAuth, getActiveDepartmentId, getClientId } from "../middleware/requireAuth";
import { getCheckAlerts, RETIRED_FIRE_CHECK_TYPES, type CheckAlert } from "../lib/checkReminders";
import { getCoshhDueItems } from "../lib/coshhTrack";
import { NSTS_TEST_INSPECTION_TYPE, nstsStatus } from "@workspace/api-zod/nsts-sprayer-tests";
import { getEntitledServices, isEntitled } from "../lib/services";
import { addCalendarDays, getAccountToday } from "../lib/accountClock";
import { getDailyChecklistCompletionBySite } from "../lib/dailyChecklistCompletion";
import { getPickedModules } from "./setup";
import { siteVisibleSql, visibleSiteIdsSql } from "../lib/departmentSites";
import { greenCurrentHoursLateral } from "../lib/greenHours";
import {
  GREENKEEPING_CHECKLIST_NAMES, GREENKEEPING_CHECKLIST_TYPES, getGreenkeepingShedDay, getPreStartDay, greenDailyChecksPath,
  greenkeepingShedSites,
} from "../lib/greenkeepingChecks";

const router = Router();

export type TrackStatus = "ok" | "attention" | "overdue" | "no_data";

export interface TrackItem {
  label: string;
  detail: string;
  path: string;
}

export interface TrackSummary {
  trackId: string;
  label: string;
  path: string;
  enabled: boolean;
  status: TrackStatus;
  /**
   * action_required: overdue, failed or otherwise needs someone now.
   * not_started: nothing has been recorded yet and nothing is overdue — a
   * neutral state for a new business, not a failure.
   * clear: up to date, or only future reminders.
   */
  health: "action_required" | "not_started" | "clear";
  badge: string;
  items: TrackItem[];
  /**
   * True when the business picked its modules in the setup wizard, did not
   * pick this one, and nothing is recorded for it yet: the dashboard lists it
   * under "Other modules". Entitlement is unaffected.
   */
  otherModule?: boolean;
}

/**
 * Setup-wizard module keys that count as picking each track. Tracks of
 * superseded modules the wizard never offers (SafeTrack) are never moved.
 */
const TRACK_PICK_KEYS: Record<string, readonly string[]> = {
  daily_am: ["dailytrack_am", "kitchentrack", "premisestrack"],
  daily_pm: ["dailytrack_pm", "kitchentrack", "premisestrack"],
  kitchen: ["kitchentrack"],
  fire: ["firetrack"],
  legionella: ["legionellatrack"],
  pool: ["aquatrack"],
  swim: ["aquatrack"],
  hot_tub: ["hottubtrack"],
  pat: ["pattrack"],
  pest: ["pesttrack"],
  fix: ["fixtrack"],
  premises: ["premisestrack"],
  room: ["roomtrack"],
  doc: ["doctrack"],
  train: ["traintrack"],
  tree: ["treetrack"],
  bike: ["biketrack"],
  green: ["greentrack"],
  incident: ["incidenttrack"],
  coshh: ["coshhtrack"],
};

export interface ChecklistTotals {
  date: string;
  available: boolean;
  expectedAmPairs: number;
  completedAmPairs: number;
  expectedPmPairs: number;
  completedPmPairs: number;
  completedSitePairs: number;
  /**
   * Sites with a checklist still to submit today, in site order: `am` / `pm`
   * are true while that checklist is outstanding. Lets the dashboard link
   * straight to each one. Empty while totals are unavailable.
   */
  outstanding: Array<{ siteId: number; siteName: string; am: boolean; pm: boolean }>;
}

type TrackDraft = Omit<TrackSummary, "health">;

function rows(result: unknown): any[] {
  return (result as any).rows ?? [];
}

const plural = (count: number, word: string, suffix = "s") => `${count} ${word}${count === 1 ? "" : suffix}`;

router.get("/dashboard/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rawSiteId = req.query.siteId as string | undefined;
  const siteId = rawSiteId && !isNaN(parseInt(rawSiteId, 10)) ? parseInt(rawSiteId, 10) : null;
  const departmentId = getActiveDepartmentId(req);
  let accessibleSiteIds: number[] | null = null;
  try {
    if (departmentId != null) {
      const accessibleRows = await db.execute(visibleSiteIdsSql(clientId, departmentId));
      accessibleSiteIds = rows(accessibleRows).map((site: any) => Number(site.id));
    }
    if (siteId != null) {
      const requestedSite = await db.execute(sql`
        SELECT id FROM sites
        WHERE id = ${siteId} AND client_id = ${clientId}
          ${departmentId != null ? sql`AND ${siteVisibleSql(sql`id`, sql`department_id`, departmentId)}` : sql``}
        LIMIT 1
      `);
      if (rows(requestedSite).length === 0) {
        return res.status(403).json({ error: "Site is not available in the current department" });
      }
    }
  } catch {
    return res.status(500).json({ error: "Unable to validate site access" });
  }
  // Department users see unassigned rows plus their department's sites. The
  // ids are expanded as an IN list: an interpolated array is not a SQL array.
  const accessClause = (column: SQL) => accessibleSiteIds == null
    ? sql``
    : accessibleSiteIds.length
      ? sql`AND (${column} IS NULL OR ${column} IN (${sql.join(accessibleSiteIds.map(id => sql`${id}`), sql`, `)}))`
      : sql`AND ${column} IS NULL`;
  const scopedSiteClause = (column: SQL) => siteId != null ? sql`AND ${column} = ${siteId}` : accessClause(column);
  const protectedSiteClause = scopedSiteClause(sql`site_id`);

  // "Today" is the business's local calendar day (default Europe/London).
  const today = await getAccountToday(clientId);
  const in30 = addCalendarDays(today, 30);

  const services = await getEntitledServices(clientId);
  const entitled = (key: string) =>
    isEntitled(services, key as Parameters<typeof isEntitled>[1]);

  // A failed query must not look like an empty, never-started track.
  const unavailableTrackIds = new Set<string>();
  const unavailable = (trackId: string, error: unknown): Pick<TrackDraft, "status" | "badge"> => {
    unavailableTrackIds.add(trackId);
    req.log.warn({ err: error, trackId }, "Unable to load a dashboard track");
    return { status: "no_data", badge: "Status unavailable" };
  };

  // Shared, computed once per request: the fire/water/pool/spa alerts and
  // whether each check-based module has ever been used (anywhere the caller
  // can see, regardless of the site filter).
  let checkAlertsPromise: Promise<CheckAlert[]> | null = null;
  const loadCheckAlerts = () => (checkAlertsPromise ??= getCheckAlerts(clientId, { siteId, accessibleSiteIds }));
  let startedPromise: Promise<Record<string, boolean>> | null = null;
  const loadStarted = () => (startedPromise ??= (async () => {
    const scope = accessClause(sql`site_id`);
    const exists = (table: string, extra = sql``) =>
      sql`EXISTS (SELECT 1 FROM ${sql.raw(table)} WHERE client_id = ${clientId} ${extra} ${scope})`;
    const profile = (module: string) =>
      sql`EXISTS (SELECT 1 FROM track_control_profiles WHERE client_id = ${clientId} AND module = ${module} ${scope})`;
    try {
      const [row] = rows(await db.execute(sql`
        SELECT
          ${exists("daily_checklists", sql`AND submitted_at IS NOT NULL AND checklist_type NOT LIKE 'greenkeeping%'`)}
            OR ${exists("daily_checklist_submissions", sql`AND submitted_at IS NOT NULL`)} AS daily,
          ${exists("food_safety_records", sql`AND submitted_at IS NOT NULL`)} AS kitchen,
          ${exists("fire_safety_checks")} AS fire,
          ${exists("legionella_checks")} OR ${profile("legionella")} AS legionella,
          ${exists("pool_checks")} OR ${profile("pool")} AS pool,
          ${exists("hot_tub_checks")} OR ${profile("hot_tub")}
            OR ${exists("hot_tubs", sql`AND active = true`)} AS hot_tub
      `));
      return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, value === true || value === "t"]));
    } catch (error) {
      // Without history we cannot tell "not started" apart from neglected:
      // treat every module as started so nothing is hidden.
      req.log.warn({ err: error }, "Unable to load dashboard module history");
      return new Proxy({}, { get: () => true }) as Record<string, boolean>;
    }
  })());

  // ── Sites list (for daily track gap detection) ──────────────────────────────
  let allSites: { id: number; name: string }[] = [];
  let sitesAvailable = false;
  try {
    const siteRows = await db.execute(sql`
      SELECT id, name FROM sites
      WHERE client_id = ${clientId}
      ${siteId ? sql`AND id = ${siteId}` : sql``}
      ORDER BY name
    `);
    allSites = rows(siteRows)
      .map((r: any) => ({ id: r.id, name: r.name }))
      .filter((site) => accessibleSiteIds == null || accessibleSiteIds.includes(site.id));
    sitesAvailable = true;
  } catch (error) {
    // Checklist totals stay unavailable rather than reporting zero expected sites.
    req.log.error({ err: error }, "Unable to load sites for the dashboard summary");
  }

  const amEnabled = entitled("kitchentrack") || entitled("premisestrack") || entitled("dailytrack_am");
  const pmEnabled = entitled("kitchentrack") || entitled("premisestrack") || entitled("dailytrack_pm");

  // A site has one expected AM pair and one expected PM pair. Each branch is
  // complete when any of its real checklist types has been submitted; this
  // keeps KitchenTrack and PremisesTrack checklists under the same definition.
  const checklistTotals: ChecklistTotals = {
    date: today,
    available: false,
    expectedAmPairs: amEnabled ? allSites.length : 0,
    completedAmPairs: 0,
    expectedPmPairs: pmEnabled ? allSites.length : 0,
    completedPmPairs: 0,
    completedSitePairs: 0,
    outstanding: [],
  };
  const checklistCompletionBySite = new Map<number, { am: boolean; pm: boolean }>();
  let checklistTotalsAvailable = sitesAvailable && allSites.length === 0;
  checklistTotals.available = checklistTotalsAvailable;
  if (allSites.length > 0) {
    try {
      // Web (daily_checklists) and mobile (daily_checklist_submissions) both count.
      const completed = await getDailyChecklistCompletionBySite(clientId, today, allSites.map((site) => site.id));
      for (const [completedSiteId, complete] of completed) {
        checklistCompletionBySite.set(completedSiteId, complete);
      }
      checklistTotalsAvailable = true;
      checklistTotals.available = true;
      for (const site of allSites) {
        const complete = checklistCompletionBySite.get(site.id);
        const amComplete = !amEnabled || Boolean(complete?.am);
        const pmComplete = !pmEnabled || Boolean(complete?.pm);
        if (amEnabled && amComplete) checklistTotals.completedAmPairs++;
        if (pmEnabled && pmComplete) checklistTotals.completedPmPairs++;
        if ((amEnabled || pmEnabled) && amComplete && pmComplete) checklistTotals.completedSitePairs++;
        if (!amComplete || !pmComplete) {
          checklistTotals.outstanding.push({ siteId: site.id, siteName: site.name, am: !amComplete, pm: !pmComplete });
        }
      }
    } catch (error) {
      req.log.error({ err: error }, "Unable to load today's checklist completion");
      // Keep both the strip and module cards unavailable rather than showing a false clear state.
    }
  }

  // ── Daily AM / PM ────────────────────────────────────────────────────────────
  const dailyTrack = async (branch: "am" | "pm"): Promise<TrackDraft> => {
    const enabled = branch === "am" ? amEnabled : pmEnabled;
    const path = branch === "am" ? "/daily-track-am" : "/daily-track-pm";
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled && allSites.length > 0) {
      if (checklistTotalsAvailable) {
        const missing = allSites.filter((site) => !checklistCompletionBySite.get(site.id)?.[branch]);
        const missingCount = branch === "am"
          ? checklistTotals.expectedAmPairs - checklistTotals.completedAmPairs
          : checklistTotals.expectedPmPairs - checklistTotals.completedPmPairs;
        if (missingCount === 0) {
          status = "ok";
          badge = "All submitted";
        } else if (!(await loadStarted()).daily) {
          // No checklist has ever been submitted: a new business, not a failure.
          status = "no_data";
          badge = "Not started";
        } else {
          status = branch === "am" ? "overdue" : "attention";
          badge = `${plural(missingCount, "site")} not submitted`;
          for (const site of missing.slice(0, 10)) {
            items.push({ label: site.name, detail: `${branch.toUpperCase()} checklist not submitted today`, path: `${path}?siteId=${site.id}` });
          }
        }
      } else {
        unavailableTrackIds.add(branch === "am" ? "daily_am" : "daily_pm");
        status = "no_data";
        badge = "Status unavailable";
      }
    }

    return branch === "am"
      ? { trackId: "daily_am", label: "Daily AM Checklist", path, enabled, status, badge, items }
      : { trackId: "daily_pm", label: "Daily PM Sign-off", path, enabled, status, badge, items };
  };

  // ── KitchenTrack — food safety diary ─────────────────────────────────────────
  const kitchenTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("kitchentrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled && allSites.length > 0) {
      try {
        // Check if today's food safety record has been submitted for any relevant site
        const fsRows = await db.execute(sql`
          SELECT site_id
          FROM food_safety_records
          WHERE client_id = ${clientId}
            AND record_date = ${today}
            AND submitted_at IS NOT NULL
            ${siteId ? sql`AND site_id = ${siteId}` : sql``}
        `);
        const submittedIds = new Set(rows(fsRows).map((r: any) => r.site_id));
        // A site marked closed today (KitchenTrack closed days) is not missing.
        const closedRows = await db.execute(sql`
          SELECT site_id
          FROM kitchen_closed_days
          WHERE client_id = ${clientId}
            AND closed_date = ${today}
            AND site_id IS NOT NULL
            AND removed_at IS NULL
            ${siteId ? sql`AND site_id = ${siteId}` : sql``}
        `);
        const closedIds = new Set(rows(closedRows).map((r: any) => r.site_id));
        const missing = allSites.filter((s) => !submittedIds.has(s.id) && !closedIds.has(s.id));
        if (missing.length === 0) {
          status = "ok";
          badge = closedIds.size > 0 && submittedIds.size === 0 ? "Closed today" : "All submitted";
        } else if (!(await loadStarted()).kitchen) {
          status = "no_data";
          badge = "Not started";
        } else {
          status = "attention";
          badge = `${plural(missing.length, "site")} not recorded today`;
          for (const site of missing.slice(0, 10)) {
            items.push({ label: site.name, detail: "Food safety diary not submitted today", path: "/kitchen" });
          }
        }
      } catch (error) {
        ({ status, badge } = unavailable("kitchen", error));
      }
    }

    return { trackId: "kitchen", label: "KitchenTrack", path: "/kitchen", enabled, status, badge, items };
  };

  // ── FireTrack, LegionellaTrack, AquaTrack (pools), TubTrack ───────────────────────
  // Every site is evaluated on its own records. A site's alerts carry its name;
  // the badge says how many sites are affected and the worst items come first.
  const checkAlertTrack = async (config: {
    trackId: "fire" | "legionella" | "pool" | "hot_tub";
    module: CheckAlert["module"];
    label: string;
    path: string;
    enabled: boolean;
    daysDetail: boolean;
  }): Promise<TrackDraft> => {
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";
    if (config.enabled) {
      try {
        const [alerts, started] = await Promise.all([loadCheckAlerts(), loadStarted()]);
        const moduleAlerts = alerts.filter((a) => a.module === config.module);
        const byDue = (a: CheckAlert, b: CheckAlert) => (a.daysUntilDue ?? 0) - (b.daysUntilDue ?? 0);
        const overdue = moduleAlerts.filter((a) => a.status === "overdue").sort(byDue);
        const dueSoon = moduleAlerts.filter((a) => a.status === "due_soon").sort(byDue);
        const never = moduleAlerts.filter((a) => a.status === "never");
        const planRequired = moduleAlerts.filter((a) => a.status === "plan_required");
        const atSites = (list: CheckAlert[]) => {
          const sites = new Set(list.map((a) => a.siteId ?? null));
          return siteId == null && sites.size > 1 ? ` at ${sites.size} sites` : "";
        };

        if (!started[config.trackId]) {
          // Nothing has ever been recorded and nothing can be overdue yet.
          status = "no_data";
          badge = "Not started";
        } else if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue${atSites(overdue)}`;
        } else if (planRequired.length > 0) {
          status = "attention";
          badge = `${plural(planRequired.length, "site plan")} need review`;
        } else if (never.length > 0) {
          // The module is in use, so a site or unit never checked is a gap.
          status = "attention";
          badge = `${plural(never.length, "check")} never recorded${atSites(never)}`;
        } else if (dueSoon.length > 0) {
          status = "attention";
          badge = `${dueSoon.length} due soon${atSites(dueSoon)}`;
        } else if (allSites.length === 0 && config.module !== "fire") {
          status = "no_data";
          badge = "No sites";
        } else {
          status = "ok";
          badge = "All checks up to date";
        }

        for (const a of [...overdue, ...planRequired, ...never, ...dueSoon].slice(0, 10)) {
          const days = a.daysUntilDue;
          const detail = a.status === "plan_required"
            ? "Risk assessment and written scheme need competent-person review"
            : a.status === "never"
            ? "No record has been submitted"
            : !config.daysDetail
            ? a.status === "overdue" ? "Overdue check" : "Due soon"
            : a.status === "overdue"
            ? `Overdue by ${plural(Math.abs(days ?? 0), "day")}`
            : days === 0
            ? "Due today"
            : `Due in ${plural(days ?? 0, "day")}`;
          items.push({ label: a.checkLabel, detail, path: config.path });
        }
      } catch (error) {
        ({ status, badge } = unavailable(config.trackId, error));
      }
    }
    return { trackId: config.trackId, label: config.label, path: config.path, enabled: config.enabled, status, badge, items };
  };

  // ── PATtrack ──────────────────────────────────────────────────────────────────
  const patTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("pattrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = scopedSiteClause(sql`a.site_id`);
        const patRows = await db.execute(sql`
          SELECT
            a.id, a.name, a.appliance_type, a.location,
            last.next_test_date
          FROM pat_appliances a
          LEFT JOIN LATERAL (
            SELECT next_test_date
            FROM pat_tests t
            LEFT JOIN sites s ON s.id=t.site_id_snapshot AND s.client_id=t.client_id
            WHERE t.appliance_id = a.id AND t.client_id=a.client_id
            ${historicalTestDepartmentScope(departmentId)}
            ORDER BY t.test_date DESC, t.id DESC
            LIMIT 1
          ) last ON true
          WHERE a.client_id = ${clientId} AND a.active=true ${siteClause}
          ORDER BY last.next_test_date ASC NULLS FIRST
        `);
        const appliances = rows(patRows);
        const overdue = appliances.filter(
          (a: any) => a.next_test_date && a.next_test_date < today,
        );
        const dueSoon = appliances.filter(
          (a: any) =>
            a.next_test_date &&
            a.next_test_date >= today &&
            a.next_test_date <= in30,
        );
        const untested = appliances.filter((a: any) => !a.next_test_date);

        if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue`;
        } else if (untested.length > 0) {
          status = "attention";
          badge = `${plural(untested.length, "appliance")} never tested`;
        } else if (dueSoon.length > 0) {
          status = "attention";
          badge = `${dueSoon.length} due for testing`;
        } else if (appliances.length === 0) {
          status = "no_data";
          badge = "No appliances";
        } else {
          status = "ok";
          badge = "All appliances up to date";
        }

        for (const a of [...overdue, ...dueSoon, ...untested].slice(0, 10)) {
          const nextDate = a.next_test_date as string | null;
          const detail = !nextDate
            ? "Never tested"
            : nextDate < today
            ? `Test overdue since ${nextDate}`
            : `Next test due ${nextDate}`;
          items.push({
            label: `${a.name}${a.location ? ` — ${a.location}` : ""}`,
            detail,
            path: "/pat-track",
          });
        }
      } catch (error) {
        ({ status, badge } = unavailable("pat", error));
      }
    }

    return { trackId: "pat", label: "PATtrack", path: "/pat-track", enabled, status, badge, items };
  };

  // ── PestTrack ──────────────────────────────────────────────────────────────────
  const pestTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("pesttrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const [overdueVisits, activityCount, openActivities] = await Promise.all([
          // Each site's latest visit sets its next due visit; older visits'
          // next-visit dates are superseded and must not count as overdue.
          db.execute(sql`
            SELECT id, contractor_name, next_visit_date, site_id FROM (
              SELECT DISTINCT ON (site_id) id, contractor_name, next_visit_date, site_id
              FROM pest_visits
              WHERE client_id = ${clientId} ${siteClause}
              ORDER BY site_id, visit_date DESC, id DESC
            ) latest
            WHERE next_visit_date IS NOT NULL AND next_visit_date < ${today}
            ORDER BY next_visit_date ASC
          `),
          db.execute(sql`
            SELECT count(*)::int AS open FROM pest_activity
            WHERE client_id = ${clientId} AND resolved = false ${siteClause}
          `),
          db.execute(sql`
            SELECT id, pest_type, location
            FROM pest_activity
            WHERE client_id = ${clientId} AND resolved = false ${siteClause}
            ORDER BY recorded_date DESC, id DESC
            LIMIT 5
          `),
        ]);

        const overdueCount = rows(overdueVisits).length;
        const openCount = Number(rows(activityCount)[0]?.open ?? 0);

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${plural(overdueCount, "visit")} overdue`;
          for (const v of rows(overdueVisits).slice(0, 5)) {
            items.push({
              label: `Visit overdue`,
              detail: `${v.contractor_name ?? "Unknown contractor"} — due ${v.next_visit_date}`,
              path: "/pest-track",
            });
          }
        } else if (openCount > 0) {
          status = "attention";
          badge = `${plural(openCount, "active infestation")}`;
        } else {
          // Check if there are any records at all
          const anyRows = await db.execute(sql`
            SELECT 1 FROM pest_visits WHERE client_id = ${clientId} ${siteClause}
            UNION ALL
            SELECT 1 FROM pest_activity WHERE client_id = ${clientId} ${siteClause}
            LIMIT 1
          `);
          if (rows(anyRows).length === 0) {
            status = "no_data";
            badge = "No records yet";
          } else {
            status = "ok";
            badge = "All up to date";
          }
        }
        for (const a of rows(openActivities)) {
          items.push({
            label: a.pest_type ?? "Pest activity",
            detail: `Active — ${a.location ?? "area not specified"}`,
            path: "/pest-track",
          });
        }
      } catch (error) {
        ({ status, badge } = unavailable("pest", error));
      }
    }

    return { trackId: "pest", label: "PestTrack", path: "/pest-track", enabled, status, badge, items };
  };

  // ── FixTrack ──────────────────────────────────────────────────────────────────
  const fixTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("fixtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const [openIssues, counts] = await Promise.all([
          db.execute(sql`
            SELECT id, title, priority, status, reported_date
            FROM fix_track_issues
            WHERE client_id = ${clientId}
              AND status IN ('reported', 'in_progress')
              ${siteClause}
            ORDER BY
              CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
              reported_date ASC
            LIMIT 10
          `),
          // Counts come from the whole register, not the 10 rows displayed.
          db.execute(sql`
            SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE priority IN ('urgent', 'high'))::int AS urgent
            FROM fix_track_issues
            WHERE client_id = ${clientId}
              AND status IN ('reported', 'in_progress')
              ${siteClause}
          `),
        ]);
        const countRow = rows(counts)[0] ?? {};
        const urgent = Number(countRow.urgent ?? 0);
        const total = Number(countRow.total ?? 0);

        if (urgent > 0) {
          status = "overdue";
          badge = `${plural(urgent, "urgent/high issue")} open`;
        } else if (total > 0) {
          status = "attention";
          badge = `${plural(total, "open issue")}`;
        } else {
          const anyRows = await db.execute(sql`
            SELECT 1 FROM fix_track_issues WHERE client_id = ${clientId} ${siteClause} LIMIT 1
          `);
          status = rows(anyRows).length > 0 ? "ok" : "no_data";
          badge = rows(anyRows).length > 0 ? "No open issues" : "No records yet";
        }

        for (const i of rows(openIssues)) {
          items.push({
            label: i.title,
            detail: `${(i.priority as string).charAt(0).toUpperCase() + (i.priority as string).slice(1)} priority — ${i.status.replace("_", " ")}`,
            path: `/fix-track`,
          });
        }
      } catch (error) {
        ({ status, badge } = unavailable("fix", error));
      }
    }

    return { trackId: "fix", label: "FixTrack", path: "/fix-track", enabled, status, badge, items };
  };

  // ── PremisesTrack ─────────────────────────────────────────────────────────────
  const premisesTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("premisestrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const [overdueInspections, openInspections, activeCounts] = await Promise.all([
          // The latest inspection of each type and area at a site sets when
          // the next one is due, whatever its action status (as on the
          // PremisesTrack page).
          db.execute(sql`
            SELECT id, inspection_type, next_inspection_date FROM (
              SELECT DISTINCT ON (site_id, inspection_type, lower(trim(coalesce(area, ''))))
                id, inspection_type, next_inspection_date
              FROM premises_inspections
              WHERE client_id = ${clientId} ${siteClause}
              ORDER BY site_id, inspection_type, lower(trim(coalesce(area, ''))), inspection_date DESC, id DESC
            ) latest
            WHERE next_inspection_date IS NOT NULL AND next_inspection_date < ${today}
            ORDER BY next_inspection_date ASC
          `),
          db.execute(sql`
            SELECT id, inspection_type, inspection_date, next_inspection_date, status, site_id
            FROM premises_inspections
            WHERE client_id = ${clientId}
              AND status IN ('open', 'actioned')
              ${siteClause}
            ORDER BY next_inspection_date ASC NULLS LAST
            LIMIT 10
          `),
          db.execute(sql`
            SELECT count(*)::int AS total
            FROM premises_inspections
            WHERE client_id = ${clientId}
              AND status IN ('open', 'actioned')
              ${siteClause}
          `),
        ]);
        const overdueCount = rows(overdueInspections).length;
        const total = Number(rows(activeCounts)[0]?.total ?? 0);
        const typeLabel = (type: string) => type
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c: string) => c.toUpperCase());

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${plural(overdueCount, "overdue inspection")}`;
        } else if (total > 0) {
          status = "attention";
          badge = `${plural(total, "open inspection")}`;
        } else {
          const anyRows = await db.execute(sql`
            SELECT 1 FROM premises_inspections WHERE client_id = ${clientId} ${siteClause} LIMIT 1
          `);
          status = rows(anyRows).length > 0 ? "ok" : "no_data";
          badge = rows(anyRows).length > 0 ? "No open inspections" : "No records yet";
        }

        const overdueIds = new Set(rows(overdueInspections).map((i: any) => i.id));
        for (const i of rows(overdueInspections).slice(0, 10)) {
          items.push({ label: typeLabel(i.inspection_type as string), detail: `Overdue since ${i.next_inspection_date}`, path: "/premises-track" });
        }
        for (const i of rows(openInspections)) {
          if (items.length >= 10) break;
          if (overdueIds.has(i.id)) continue;
          const detail = i.next_inspection_date && i.next_inspection_date >= today
            ? `Due ${i.next_inspection_date}`
            : `Status: ${i.status}`;
          items.push({ label: typeLabel(i.inspection_type as string), detail, path: "/premises-track" });
        }
      } catch (error) {
        ({ status, badge } = unavailable("premises", error));
      }
    }

    return { trackId: "premises", label: "PremisesTrack", path: "/premises-track", enabled, status, badge, items };
  };

  // ── RoomTrack ─────────────────────────────────────────────────────────────────
  const roomTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("roomtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No rooms";
    if (enabled) {
      try {
        const result = await db.execute(sql`
          SELECT
            count(*)::int AS total,
            count(c.id) FILTER (WHERE c.clean = true AND c.tidy = true AND c.to_standard = true)::int AS checked
          FROM room_track_rooms r
          LEFT JOIN room_track_checks c
            ON c.room_id = r.id
           AND c.client_id = r.client_id
           AND c.check_date = ${today}
          WHERE r.client_id = ${clientId}
            AND r.active = true
            ${scopedSiteClause(sql`r.site_id`)}
        `);
        const roomTotals = rows(result)[0] ?? { total: 0, checked: 0 };
        const total = Number(roomTotals.total);
        const checked = Number(roomTotals.checked);
        if (total === 0) {
          status = "no_data";
          badge = "No rooms";
        } else if (checked === 0) {
          status = "attention";
          badge = `0 / ${total} checked today`;
          items.push({ label: `${plural(total, "room")} unchecked`, detail: "Room checks are still due today", path: "/room-track" });
        } else if (checked < total) {
          status = "attention";
          badge = `${checked} / ${total} checked today`;
          items.push({ label: `${plural(total - checked, "room")} unchecked`, detail: "Room checks are still due today", path: "/room-track" });
        } else {
          status = "ok";
          badge = `${checked} / ${total} checked today`;
        }
      } catch (error) {
        ({ status, badge } = unavailable("room", error));
      }
    }
    return { trackId: "room", label: "RoomTrack", path: "/room-track", enabled, status, badge, items };
  };

  // ── DocTrack ──────────────────────────────────────────────────────────────────
  const docTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("doctrack") || entitled("safetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const [overdueRows, dueSoonRows, counts] = await Promise.all([
          db.execute(sql`
            SELECT id, title, next_review_date, category
            FROM doc_track_documents
            WHERE client_id = ${clientId}
              AND next_review_date IS NOT NULL
              AND next_review_date < ${today}
              ${siteClause}
            ORDER BY next_review_date ASC
            LIMIT 10
          `),
          db.execute(sql`
            SELECT id, title, next_review_date, category
            FROM doc_track_documents
            WHERE client_id = ${clientId}
              AND next_review_date IS NOT NULL
              AND next_review_date >= ${today}
              AND next_review_date <= ${in30}
              ${siteClause}
            ORDER BY next_review_date ASC
            LIMIT 10
          `),
          db.execute(sql`
            SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE next_review_date < ${today})::int AS overdue,
              count(*) FILTER (WHERE next_review_date >= ${today} AND next_review_date <= ${in30})::int AS due_soon
            FROM doc_track_documents
            WHERE client_id = ${clientId} ${siteClause}
          `),
        ]);
        const countRow = rows(counts)[0] ?? {};
        const overdueCount = Number(countRow.overdue ?? 0);
        const dueSoonCount = Number(countRow.due_soon ?? 0);

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${plural(overdueCount, "review")} overdue`;
        } else if (dueSoonCount > 0) {
          status = "attention";
          badge = `${plural(dueSoonCount, "review")} due soon`;
        } else {
          const any = Number(countRow.total ?? 0) > 0;
          status = any ? "ok" : "no_data";
          badge = any ? "All documents up to date" : "No documents yet";
        }

        for (const d of rows(overdueRows)) {
          items.push({ label: d.title, detail: `Review overdue since ${d.next_review_date}`, path: "/doc-track" });
        }
        for (const d of rows(dueSoonRows)) {
          items.push({ label: d.title, detail: `Review due ${d.next_review_date}`, path: "/doc-track" });
        }
      } catch (error) {
        ({ status, badge } = unavailable("doc", error));
      }
    }

    return { trackId: "doc", label: "DocTrack", path: "/doc-track", enabled, status, badge, items };
  };

  // ── SafeTrack — risk assessments & SOPs ─────────────────────────────────────
  const safeTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("safetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        // Risk assessments carry one "Review Date" (review_date), the date the
        // assessment is next due for review. SOPs have no review date, so they
        // only count towards whether SafeTrack has any records.
        const reviewList = (overdue: boolean) => db.execute(sql`
          SELECT id, title, review_date FROM safe_risk_assessments
          WHERE client_id = ${clientId} AND review_date IS NOT NULL
            ${overdue ? sql`AND review_date < ${today}` : sql`AND review_date >= ${today} AND review_date <= ${in30}`}
            ${siteClause}
          ORDER BY review_date ASC LIMIT 5
        `);
        const [overdueRA, dueSoonRA, raCounts, sopCounts] = await Promise.all([
          reviewList(true),
          reviewList(false),
          db.execute(sql`
            SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE review_date < ${today})::int AS overdue,
              count(*) FILTER (WHERE review_date >= ${today} AND review_date <= ${in30})::int AS due_soon
            FROM safe_risk_assessments
            WHERE client_id = ${clientId} ${siteClause}
          `),
          db.execute(sql`SELECT count(*)::int AS total FROM safe_sops WHERE client_id = ${clientId} ${siteClause}`),
        ]);
        const ra = rows(raCounts)[0] ?? {};
        const sop = rows(sopCounts)[0] ?? {};
        const overdueCount = Number(ra.overdue ?? 0);
        const dueSoonCount = Number(ra.due_soon ?? 0);

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${plural(overdueCount, "review")} overdue`;
        } else if (dueSoonCount > 0) {
          status = "attention";
          badge = `${plural(dueSoonCount, "review")} due soon`;
        } else {
          const any = Number(ra.total ?? 0) + Number(sop.total ?? 0) > 0;
          status = any ? "ok" : "no_data";
          badge = any ? "All documents up to date" : "No records yet";
        }

        for (const d of rows(overdueRA)) {
          items.push({ label: d.title, detail: `Risk assessment review overdue since ${d.review_date}`, path: "/safe-track" });
        }
        for (const d of rows(dueSoonRA)) {
          items.push({ label: d.title, detail: `Risk assessment review due ${d.review_date}`, path: "/safe-track" });
        }
      } catch (error) {
        ({ status, badge } = unavailable("safe", error));
      }
    }

    return { trackId: "safe", label: "SafeTrack", path: "/safe-track", enabled, status, badge, items };
  };

  // ── TrainTrack ────────────────────────────────────────────────────────────────
  const trainTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("traintrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        // Internal training records carry a training type; uploaded
        // certificates carry a document title instead.
        const [expiredRows, expiringSoonRows, counts] = await Promise.all([
          db.execute(sql`
            SELECT id, staff_name, COALESCE(training_type, document_title, 'Training') AS training_title, expiry_date
            FROM train_track_records
            WHERE client_id = ${clientId} AND expiry_date IS NOT NULL AND expiry_date < ${today} ${siteClause}
            ORDER BY expiry_date ASC LIMIT 10
          `),
          db.execute(sql`
            SELECT id, staff_name, COALESCE(training_type, document_title, 'Training') AS training_title, expiry_date
            FROM train_track_records
            WHERE client_id = ${clientId} AND expiry_date >= ${today} AND expiry_date <= ${in30} ${siteClause}
            ORDER BY expiry_date ASC LIMIT 10
          `),
          db.execute(sql`
            SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE expiry_date < ${today})::int AS expired,
              count(*) FILTER (WHERE expiry_date >= ${today} AND expiry_date <= ${in30})::int AS expiring
            FROM train_track_records
            WHERE client_id = ${clientId} ${siteClause}
          `),
        ]);
        const countRow = rows(counts)[0] ?? {};
        const expiredCount = Number(countRow.expired ?? 0);
        const expiringSoonCount = Number(countRow.expiring ?? 0);

        if (expiredCount > 0) {
          status = "overdue";
          badge = `${plural(expiredCount, "expired certificate")}`;
        } else if (expiringSoonCount > 0) {
          status = "attention";
          badge = `${expiringSoonCount} expiring soon`;
        } else {
          const any = Number(countRow.total ?? 0) > 0;
          status = any ? "ok" : "no_data";
          badge = any ? "All training up to date" : "No records yet";
        }

        for (const r of rows(expiredRows)) {
          items.push({ label: `${r.staff_name} — ${r.training_title}`, detail: `Expired ${r.expiry_date}`, path: "/train-track" });
        }
        for (const r of rows(expiringSoonRows)) {
          items.push({ label: `${r.staff_name} — ${r.training_title}`, detail: `Expires ${r.expiry_date}`, path: "/train-track" });
        }
      } catch (error) {
        ({ status, badge } = unavailable("train", error));
      }
    }

    return { trackId: "train", label: "TrainTrack", path: "/train-track", enabled, status, badge, items };
  };

  // ── TreeTrack ─────────────────────────────────────────────────────────────────
  const treeTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("treetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const MS_DAY = 86400000;
        const toUtcDays = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_DAY);
        const todayDays = toUtcDays(today);

        const FREQ: Record<string, number> = {
          visual_assessment: 365, detailed_assessment: 365,
          post_storm: 30, remedial_works: 365, risk_assessment: 365,
        };
        const CHECK_LABELS: Record<string, string> = {
          visual_assessment: "Visual tree assessment", detailed_assessment: "Detailed tree assessment",
          post_storm: "Post-storm inspection", remedial_works: "Remedial works check",
          risk_assessment: "Tree risk assessment",
        };

        const lastRows = await db.execute(sql`
          SELECT check_type, MAX(check_date) AS last_date
          FROM tree_inspections WHERE client_id = ${clientId} ${siteClause}
          GROUP BY check_type
        `);
        const lastByType = new Map(rows(lastRows).map((r: any) => [r.check_type, r.last_date]));

        let overdueCount = 0;
        let dueSoonCount = 0;
        const hasAny = lastByType.size > 0;

        for (const [ct, freqDays] of Object.entries(FREQ)) {
          const lastDate = lastByType.get(ct);
          if (!lastDate) continue;
          const dueDays = toUtcDays(lastDate) + freqDays;
          const daysUntil = dueDays - todayDays;
          const window = Math.max(14, Math.ceil(freqDays * 0.1));
          if (daysUntil < 0) {
            overdueCount++;
            items.push({ label: CHECK_LABELS[ct] ?? ct, detail: `Overdue by ${plural(Math.abs(daysUntil), "day")}`, path: "/tree-track" });
          } else if (daysUntil <= window) {
            dueSoonCount++;
            items.push({ label: CHECK_LABELS[ct] ?? ct, detail: daysUntil === 0 ? "Due today" : `Due in ${plural(daysUntil, "day")}`, path: "/tree-track" });
          }
        }

        if (overdueCount > 0) { status = "overdue"; badge = `${overdueCount} overdue`; }
        else if (dueSoonCount > 0) { status = "attention"; badge = `${dueSoonCount} due soon`; }
        else if (!hasAny) { status = "no_data"; badge = "No records yet"; }
        else { status = "ok"; badge = "All inspections up to date"; }
      } catch (error) {
        ({ status, badge } = unavailable("tree", error));
      }
    }

    return { trackId: "tree", label: "TreeTrack", path: "/tree-track", enabled, status, badge, items };
  };

  // ── COSHHTrack ────────────────────────────────────────────────────────────────
  const coshhTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("coshhtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const due = await getCoshhDueItems(clientId, { siteId, accessibleSiteIds }, today);
        const overdue = due.filter((item) => item.status === "overdue");
        const soon = due.filter((item) => item.status === "due_soon");
        const missing = due.filter((item) => item.status === "missing");
        for (const item of overdue) {
          items.push({ label: item.label, detail: `Overdue by ${plural(Math.abs(item.daysUntilDue ?? 0), "day")}`, path: "/coshh-track" });
        }
        for (const item of missing) items.push({ label: item.label, detail: "Not recorded yet", path: "/coshh-track" });
        for (const item of soon) {
          items.push({ label: item.label, detail: item.daysUntilDue === 0 ? "Due today" : `Due in ${plural(item.daysUntilDue ?? 0, "day")}`, path: "/coshh-track" });
        }
        if (overdue.length > 0) { status = "overdue"; badge = `${overdue.length} overdue`; }
        else if (soon.length + missing.length > 0) { status = "attention"; badge = soon.length ? `${soon.length} due soon` : `${missing.length} to record`; }
        else if (due.length === 0) { status = "no_data"; badge = "No assessments yet"; }
        else { status = "ok"; badge = "All reviews and checks up to date"; }
      } catch (error) {
        ({ status, badge } = unavailable("coshh", error));
      }
    }

    return { trackId: "coshh", label: "COSHHTrack", path: "/coshh-track", enabled, status, badge, items };
  };

  // ── BikeTrack ─────────────────────────────────────────────────────────────────
  const bikeTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("biketrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = scopedSiteClause(sql`b.site_id`);
        const [overdueHires, overdueService, counts] = await Promise.all([
          // Bikes currently on hire past their expected return date
          db.execute(sql`
            SELECT h.id, COALESCE(b.name, b.ref) AS bike_name, h.guest_name, h.return_date_expected
            FROM bike_hire_records h
            JOIN bikes b ON b.id = h.bike_id AND b.client_id = h.client_id
            WHERE h.client_id = ${clientId}
              AND h.status = 'active'
              AND h.return_date_expected IS NOT NULL
              AND h.return_date_expected < ${today}
              ${siteClause}
            ORDER BY h.return_date_expected ASC
            LIMIT 10
          `),
          // Bikes whose latest service sets a next service date that has passed
          db.execute(sql`
            SELECT b.id, COALESCE(b.name, b.ref) AS name
            FROM bikes b
            JOIN LATERAL (
              SELECT next_service_date FROM bike_services
              WHERE bike_id = b.id AND client_id = b.client_id
              ORDER BY service_date DESC, id DESC LIMIT 1
            ) s ON true
            WHERE b.client_id = ${clientId} AND b.active = true
              ${siteClause}
              AND s.next_service_date IS NOT NULL
              AND s.next_service_date < ${today}
            ORDER BY s.next_service_date ASC
            LIMIT 10
          `),
          db.execute(sql`
            SELECT
              (SELECT count(*)::int FROM bike_hire_records h JOIN bikes b ON b.id = h.bike_id AND b.client_id = h.client_id
                WHERE h.client_id = ${clientId} AND h.status = 'active'
                  AND h.return_date_expected IS NOT NULL AND h.return_date_expected < ${today} ${siteClause}) AS overdue_hires,
              (SELECT count(*)::int FROM bikes b JOIN LATERAL (
                  SELECT next_service_date FROM bike_services
                  WHERE bike_id = b.id AND client_id = b.client_id
                  ORDER BY service_date DESC, id DESC LIMIT 1
                ) s ON true
                WHERE b.client_id = ${clientId} AND b.active = true ${siteClause}
                  AND s.next_service_date IS NOT NULL AND s.next_service_date < ${today}) AS overdue_service,
              (SELECT count(*)::int FROM bikes b WHERE b.client_id = ${clientId} ${siteClause}) AS bikes
          `),
        ]);
        const countRow = rows(counts)[0] ?? {};
        const overdueHireCount = Number(countRow.overdue_hires ?? 0);
        const overdueServiceCount = Number(countRow.overdue_service ?? 0);

        if (overdueHireCount > 0) {
          status = "overdue";
          badge = `${plural(overdueHireCount, "bike")} not returned`;
          for (const h of rows(overdueHires)) {
            items.push({ label: h.bike_name ?? "Bike", detail: `${h.guest_name ?? "Unknown"} — return overdue since ${h.return_date_expected}`, path: "/bike-track" });
          }
        } else if (overdueServiceCount > 0) {
          status = "attention";
          badge = `${plural(overdueServiceCount, "bike")} overdue service`;
          for (const b of rows(overdueService)) {
            items.push({ label: b.name, detail: "Service overdue", path: "/bike-track" });
          }
        } else {
          const any = Number(countRow.bikes ?? 0) > 0;
          status = any ? "ok" : "no_data";
          badge = any ? "No bikes overdue" : "No bikes registered";
        }
      } catch (error) {
        ({ status, badge } = unavailable("bike", error));
      }
    }

    return { trackId: "bike", label: "BikeTrack", path: "/bike-track", enabled, status, badge, items };
  };

  // ── GreenTrack ────────────────────────────────────────────────────────────────
  const greenTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("greentrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = scopedSiteClause(sql`m.site_id`);
        // A service is overdue by its date, or once the hour meter reaches
        // the latest service's "next service at" hours.
        const overdueServiceFrom = sql`
          FROM green_machines m
          JOIN LATERAL (
            SELECT next_service_date, next_service_hours FROM green_service_records
            WHERE machine_id = m.id AND client_id = m.client_id
            ORDER BY service_date DESC, id DESC LIMIT 1
          ) s ON true
          LEFT JOIN LATERAL ${greenCurrentHoursLateral(sql.raw("m.id"), sql.raw("m.client_id"))} h ON true
          WHERE m.client_id = ${clientId} AND m.active = true ${siteClause}
            AND ((s.next_service_date IS NOT NULL AND s.next_service_date < ${today})
              OR (s.next_service_hours IS NOT NULL AND h.hours >= s.next_service_hours))
        `;
        // Statutory (PUWER / LOLER) examinations: a machine's latest one of
        // each kind sets when the next of that kind is due.
        const overdueExamination = sql`
          SELECT m.id, m.name, p.inspection_type, p.next_inspection_date
          FROM green_machines m
          JOIN (
            SELECT DISTINCT ON (machine_id, inspection_type) machine_id, inspection_type, next_inspection_date
            FROM green_puwer_inspections
            WHERE client_id = ${clientId}
            ORDER BY machine_id, inspection_type, inspection_date DESC, id DESC
          ) p ON p.machine_id = m.id
          WHERE m.client_id = ${clientId} AND m.active = true ${siteClause}
            AND p.next_inspection_date IS NOT NULL AND p.next_inspection_date < ${today}
          ORDER BY p.next_inspection_date ASC
        `;
        // Sprayers never NSTS tested: the first test is due by a set age.
        const untestedSprayers = sql`
          SELECT m.id, m.name, m.sprayer_category, to_char(m.purchase_date, 'YYYY-MM-DD') AS purchase_date, m.year
          FROM green_machines m
          WHERE m.client_id = ${clientId} AND m.active = true AND m.sprayer_category IS NOT NULL ${siteClause}
            AND NOT EXISTS (
              SELECT 1 FROM green_puwer_inspections t
              WHERE t.machine_id = m.id AND t.client_id = m.client_id AND t.inspection_type = ${NSTS_TEST_INSPECTION_TYPE}
            )
          ORDER BY m.name
        `;
        const [machines, overdueService, overdueServiceCountRows, overdueExaminations, untestedSprayerRows] = await Promise.all([
          // Today's pre-start check or "not in use" mark for every machine
          getPreStartDay(clientId, today, siteId != null ? [siteId] : accessibleSiteIds),
          // Machines with overdue service
          db.execute(sql`SELECT m.id, m.name, s.next_service_date, s.next_service_hours, h.hours ${overdueServiceFrom} ORDER BY s.next_service_date ASC NULLS LAST LIMIT 10`),
          db.execute(sql`SELECT count(*)::int AS overdue ${overdueServiceFrom}`),
          db.execute(overdueExamination),
          db.execute(untestedSprayers),
        ]);
        // A machine marked "not in use" today needs no pre-start check.
        const uncheckedToday = machines.filter((m) => m.status === "todo" && (siteId == null || m.siteId === siteId));

        const overdueServiceCount = Number(rows(overdueServiceCountRows)[0]?.overdue ?? 0);
        const uncheckedCount = uncheckedToday.length;
        const totalMachines = machines.filter((m) => siteId == null || m.siteId === siteId).length;

        // Greenkeeping shed opening / closing checks, at the sites that do them.
        const shedSiteIds = allSites.length
          ? await greenkeepingShedSites(clientId, today, allSites.map((site) => site.id))
          : new Set<number>();
        const shedSites = allSites.filter((site) => shedSiteIds.has(site.id));
        const shedDays = await getGreenkeepingShedDay(clientId, today, shedSites.map((site) => site.id));
        const shedItems: TrackItem[] = [];
        for (const site of shedSites) {
          for (const type of GREENKEEPING_CHECKLIST_TYPES) {
            const state = shedDays.get(site.id)?.[type];
            if (state?.submitted && !state.failed) continue;
            shedItems.push({
              label: site.name,
              detail: state?.submitted ? `${GREENKEEPING_CHECKLIST_NAMES[type]} submitted with a failed item` : `${GREENKEEPING_CHECKLIST_NAMES[type]} not done today`,
              path: greenDailyChecksPath(site.id),
            });
          }
        }
        const shedOutstanding = shedItems.length;
        const dailyItems = [
          ...shedItems,
          ...uncheckedToday.slice(0, 10).map((m) => ({
            label: m.name, detail: `${m.type ?? "Machine"} — no pre-start check today (or mark it not in use)`, path: greenDailyChecksPath(m.siteId),
          })),
        ];
        const dailyBadge = [
          shedOutstanding > 0 ? `${plural(shedOutstanding, "shed checklist")} to do` : null,
          uncheckedCount > 0 ? `${plural(uncheckedCount, "machine")} not checked today` : null,
        ].filter(Boolean).join(", ");

        const isNsts = (m: any) => m.inspection_type === NSTS_TEST_INSPECTION_TYPE;
        const overdueExaminationCount = rows(overdueExaminations).filter((m: any) => !isNsts(m)).length;
        const overdueFirstTests = rows(untestedSprayerRows)
          .map((m: any) => ({ ...m, nsts: nstsStatus(m.sprayer_category, { purchaseDate: m.purchase_date, year: m.year }, null, today) }))
          .filter((m: any) => m.nsts.state === "overdue");
        const overdueNstsCount = rows(overdueExaminations).filter(isNsts).length + overdueFirstTests.length;

        if (overdueServiceCount > 0 || overdueExaminationCount > 0 || overdueNstsCount > 0) {
          status = "overdue";
          badge = [
            overdueServiceCount > 0 ? `${plural(overdueServiceCount, "machine")} service overdue` : null,
            overdueExaminationCount > 0 ? `${plural(overdueExaminationCount, "examination")} overdue` : null,
            overdueNstsCount > 0 ? `${plural(overdueNstsCount, "NSTS test")} overdue` : null,
          ].filter(Boolean).join(", ");
          for (const m of rows(overdueService)) {
            const byHours = m.next_service_hours != null && m.hours != null && Number(m.hours) >= Number(m.next_service_hours);
            items.push({
              label: m.name,
              detail: byHours ? `Service overdue: ${Number(m.hours)} hours, due at ${Number(m.next_service_hours)}` : "Service overdue",
              path: "/green-track",
            });
          }
          for (const m of rows(overdueExaminations).slice(0, 10)) {
            const kind = isNsts(m) ? "NSTS test" : /examination/.test(String(m.inspection_type)) ? "Thorough examination" : "Inspection";
            items.push({ label: m.name, detail: `${kind} overdue since ${m.next_inspection_date}`, path: "/green-track" });
          }
          for (const m of overdueFirstTests.slice(0, 10)) {
            items.push({ label: m.name, detail: `NSTS test overdue since ${m.nsts.dueDate} (never tested)`, path: "/green-track" });
          }
          items.push(...dailyItems);
        } else if (dailyBadge) {
          status = "attention";
          badge = dailyBadge;
          items.push(...dailyItems);
        } else if (totalMachines === 0 && shedSites.length === 0) {
          status = "no_data"; badge = "No machines registered";
        } else {
          status = "ok"; badge = totalMachines > 0 ? "All machines checked" : "Shed checks done";
        }
      } catch (error) {
        ({ status, badge } = unavailable("green", error));
      }
    }

    return { trackId: "green", label: "GreenTrack", path: "/green-track", enabled, status, badge, items };
  };

  // ── AquaTrack swim safety (legacy SwimTrack) ─────────────────────────────────────────────────────────────────
  const swimTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("swimtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const [todaySessions, todaySurveillance] = await Promise.all([
          // Swim sessions logged today
          db.execute(sql`
            SELECT COUNT(*)::int AS cnt FROM swim_sessions
            WHERE client_id = ${clientId} AND session_date = ${today} ${siteClause}
          `),
          // Surveillance checks today
          db.execute(sql`
            SELECT COUNT(*)::int AS cnt FROM swim_surveillance_checks
            WHERE client_id = ${clientId} AND check_date = ${today} ${siteClause}
          `),
        ]);
        const sessionCount = Number(rows(todaySessions)[0]?.cnt ?? 0);
        const surveillanceCount = Number(rows(todaySurveillance)[0]?.cnt ?? 0);

        if (sessionCount === 0) {
          // Check if there were any historical records
          const anyRows = await db.execute(sql`SELECT 1 FROM swim_sessions WHERE client_id = ${clientId} ${siteClause} LIMIT 1`);
          if (rows(anyRows).length === 0) {
            status = "no_data"; badge = "No records yet";
          } else {
            status = "attention"; badge = "No swim session logged today";
            items.push({ label: "No session today", detail: "No swimming session has been recorded for today", path: "/swim-track" });
          }
        } else if (surveillanceCount === 0) {
          status = "attention"; badge = `${plural(sessionCount, "session")} — no surveillance checks`;
          items.push({ label: "Surveillance checks missing", detail: "Session logged but no surveillance checks recorded", path: "/swim-track" });
        } else {
          status = "ok"; badge = `${plural(sessionCount, "session")} logged`;
        }
      } catch (error) {
        ({ status, badge } = unavailable("swim", error));
      }
    }

    return { trackId: "swim", label: "AquaTrack sessions", path: "/swim-track", enabled, status, badge, items };
  };

  // ── IncidentTrack ─────────────────────────────────────────────────────────────
  const incidentTrack = async (): Promise<TrackDraft> => {
    const enabled = entitled("incidenttrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const summaryRows = await db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'open')::int                                    AS open_count,
            COUNT(*) FILTER (WHERE status = 'under_investigation')::int                     AS investigating_count,
            COUNT(*) FILTER (WHERE riddor_reportable = true AND reported_to_hse = false)::int AS riddor_outstanding,
            COUNT(*)::int                                                                    AS total
          FROM incidents
          WHERE client_id = ${clientId} ${siteClause}
        `);
        const s = (rows(summaryRows)[0] as any) ?? {};
        const openCount = Number(s.open_count ?? 0);
        const investigatingCount = Number(s.investigating_count ?? 0);
        const riddorOutstanding = Number(s.riddor_outstanding ?? 0);
        const total = Number(s.total ?? 0);

        if (riddorOutstanding > 0) {
          status = "overdue";
          badge = `${plural(riddorOutstanding, "RIDDOR report")} outstanding`;
          items.push({ label: "RIDDOR reporting outstanding", detail: `${plural(riddorOutstanding, "incident")} require HSE notification`, path: "/incidents" });
        } else if (openCount > 0 || investigatingCount > 0) {
          const count = openCount + investigatingCount;
          status = "attention";
          badge = `${plural(count, "open incident")}`;
          if (openCount > 0) items.push({ label: `${plural(openCount, "open incident")}`, detail: "Awaiting action", path: "/incidents" });
          if (investigatingCount > 0) items.push({ label: `${investigatingCount} under investigation`, detail: "Investigation in progress", path: "/incidents" });
        } else if (total === 0) {
          status = "no_data"; badge = "No records yet";
        } else {
          status = "ok"; badge = "No open incidents";
        }
      } catch (error) {
        ({ status, badge } = unavailable("incident", error));
      }
    }

    return { trackId: "incident", label: "IncidentTrack", path: "/incidents", enabled, status, badge, items };
  };

  // Independent tracks load in parallel; the order here is the response order.
  const tracks: TrackDraft[] = await Promise.all([
    dailyTrack("am"),
    dailyTrack("pm"),
    kitchenTrack(),
    checkAlertTrack({ trackId: "fire", module: "fire", label: "FireTrack", path: "/fire-safety",
      enabled: entitled("firetrack"), daysDetail: true }),
    checkAlertTrack({ trackId: "legionella", module: "legionella", label: "LegionellaTrack", path: "/legionella",
      enabled: entitled("legionellatrack"), daysDetail: true }),
    checkAlertTrack({ trackId: "pool", module: "pool", label: "AquaTrack water quality", path: "/aqua-track",
      enabled: entitled("pooltrack"), daysDetail: false }),
    patTrack(),
    pestTrack(),
    fixTrack(),
    premisesTrack(),
    roomTrack(),
    docTrack(),
    safeTrack(),
    trainTrack(),
    checkAlertTrack({ trackId: "hot_tub", module: "hot_tub", label: "TubTrack", path: "/hot-tub",
      enabled: entitled("hottubtrack"), daysDetail: true }),
    treeTrack(),
    coshhTrack(),
    bikeTrack(),
    greenTrack(),
    swimTrack(),
    incidentTrack(),
  ]);

  // Actions are deliberately read-only here. During the transition to the
  // shared action table it may not exist yet, so a missing table must not
  // prevent the dashboard from loading.
  let openActions: any[] = [];
  try {
    const actionRows = await db.execute(sql`
      SELECT module, title, severity, due_date
      FROM track_actions
      WHERE client_id = ${clientId}
        AND COALESCE(status, 'open') NOT IN ('resolved', 'closed', 'completed', 'cancelled')
        ${siteId != null ? sql`AND (site_id IS NULL OR site_id = ${siteId})` : accessClause(sql`site_id`)}
      ORDER BY due_date ASC NULLS LAST
    `);
    openActions = rows(actionRows);
  } catch (error) {
    // track_actions is introduced independently of this endpoint.
    req.log.warn({ err: error }, "Unable to load open track actions for the dashboard");
  }

  const aliases: Record<string, string[]> = {
    daily_am: ["dailyam", "dailytrackam"],
    daily_pm: ["dailypm", "dailytrackpm"],
    kitchen: ["kitchen", "kitchentrack", "foodsafety"],
    fire: ["fire", "firetrack", "firesafety"],
    legionella: ["legionella", "legionellatrack"],
    pool: ["pool", "pooltrack"],
    pat: ["pat", "pattrack"],
    pest: ["pest", "pesttrack"],
    fix: ["fix", "fixtrack"],
    premises: ["premises", "premisestrack"],
    doc: ["doc", "doctrack"],
    safe: ["safe", "safetrack"],
    train: ["train", "traintrack"],
    hot_tub: ["hottub", "hottubtrack", "tub", "tubtrack"],
    tree: ["tree", "treetrack"],
    coshh: ["coshh", "coshhtrack"],
    bike: ["bike", "biketrack"],
    green: ["green", "greentrack"],
    swim: ["swim", "swimtrack"],
    incident: ["incident", "incidenttrack"],
  };
  const normaliseModule = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const actionRequiredTrackIds = new Set<string>();

  for (const track of tracks) {
    const actionModules = new Set((aliases[track.trackId] ?? [track.trackId]).map(normaliseModule));
    for (const action of openActions) {
      if (!actionModules.has(normaliseModule(action.module))) continue;
      const severity = normaliseModule(action.severity);
      const monitorIsDue = !action.due_date || String(action.due_date).slice(0, 10) <= today;
      if (severity === "actionrequired" || severity === "urgent" || (severity === "monitor" && monitorIsDue)) {
        actionRequiredTrackIds.add(track.trackId);
      }
      track.items.unshift({
        label: action.title || "Open action",
        detail: `${action.severity ? `${action.severity} priority — ` : ""}Open action${action.due_date ? ` due ${action.due_date}` : ""}`,
        path: track.path,
      });
    }
  }

  // Surface the current result for result-based tracks as an actionable item.
  // DISTINCT ON ensures an old failed check does not remain red after a newer
  // passing check of the same type at the same site.
  const machineSiteClause = scopedSiteClause(sql`m.site_id`);
  const failedResultQueries: Array<{
    trackId: string;
    path: string;
    query: ReturnType<typeof sql>;
  }> = [
    {
      trackId: "fire",
      path: "/fire-safety",
      query: sql`
        SELECT DISTINCT ON (site_id, check_type) check_type, check_date AS date, result, location
        FROM fire_safety_checks WHERE client_id = ${clientId} ${protectedSiteClause}
          AND check_type NOT IN (${sql.join(RETIRED_FIRE_CHECK_TYPES.map((type) => sql`${type}`), sql`, `)})
        ORDER BY site_id, check_type, check_date DESC, id DESC
      `,
    },
    {
      trackId: "legionella",
      path: "/legionella",
      query: sql`
        SELECT DISTINCT ON (site_id, check_type, COALESCE(outlet_id, 0)) check_type, check_date AS date, result, location
        FROM legionella_checks WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_type, COALESCE(outlet_id, 0), check_date DESC, id DESC
      `,
    },
    {
      trackId: "pool",
      path: "/aqua-track",
      query: sql`
        SELECT DISTINCT ON (site_id, check_type) check_type, check_date AS date, result, NULL::text AS location
        FROM pool_checks WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_type, check_date DESC, id DESC
      `,
    },
    {
      trackId: "hot_tub",
      path: "/hot-tub",
      query: sql`
        SELECT DISTINCT ON (site_id, check_type, COALESCE(hot_tub_id, 0)) check_type, check_date AS date, result, location
        FROM hot_tub_checks WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_type, COALESCE(hot_tub_id, 0), check_date DESC, id DESC
      `,
    },
    {
      trackId: "tree",
      path: "/tree-track",
      query: sql`
        SELECT DISTINCT ON (site_id, check_type) check_type, check_date AS date, result, location
        FROM tree_inspections WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_type, check_date DESC, id DESC
      `,
    },
    {
      trackId: "green",
      path: "/green-track",
      query: sql`
        SELECT DISTINCT ON (c.machine_id) 'pre_use_check' AS check_type, c.check_date AS date, c.result, m.name AS location
        FROM green_pre_use_checks c
        JOIN green_machines m ON m.id = c.machine_id
        WHERE c.client_id = ${clientId}
          ${machineSiteClause}
        ORDER BY c.machine_id, c.check_date DESC, c.id DESC
      `,
    },
    {
      trackId: "green",
      path: "/green-track",
      query: sql`
        SELECT DISTINCT ON (p.machine_id) p.inspection_type AS check_type, p.inspection_date AS date, p.result, m.name AS location
        FROM green_puwer_inspections p
        JOIN green_machines m ON m.id = p.machine_id
        WHERE p.client_id = ${clientId}
          ${machineSiteClause}
        ORDER BY p.machine_id, p.inspection_date DESC, p.id DESC
      `,
    },
    {
      trackId: "swim",
      path: "/swim-track",
      query: sql`
        SELECT DISTINCT ON (site_id, session_type) session_type AS check_type, session_date AS date, result, NULL::text AS location
        FROM swim_sessions WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, session_type, session_date DESC, id DESC
      `,
    },
    {
      trackId: "swim",
      path: "/swim-track",
      query: sql`
        SELECT DISTINCT ON (site_id) 'surveillance_check' AS check_type, check_date AS date, result, NULL::text AS location
        FROM swim_surveillance_checks WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_date DESC, id DESC
      `,
    },
    {
      trackId: "swim",
      path: "/swim-track",
      query: sql`
        SELECT DISTINCT ON (site_id) 'first_aid_check' AS check_type, check_date AS date, result, NULL::text AS location
        FROM swim_first_aid_checks WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_date DESC, id DESC
      `,
    },
  ];
  const resultSets = await Promise.all(failedResultQueries.map(async (resultQuery) => {
    if (!tracks.some((track) => track.trackId === resultQuery.trackId && track.enabled)) return [];
    try {
      return rows(await db.execute(resultQuery.query));
    } catch (error) {
      // Older schemas can lack a result column; dashboard availability wins.
      req.log.warn({ err: error, trackId: resultQuery.trackId }, "Unable to load latest results for a dashboard track");
      return [];
    }
  }));
  failedResultQueries.forEach((resultQuery, index) => {
    const track = tracks.find((candidate) => candidate.trackId === resultQuery.trackId);
    if (!track) return;
    for (const result of resultSets[index]!) {
      const failedResult = /fail|action.?required|urgent|out.?of.?range|unsafe|non.?compliant/i.test(
        String(result.result ?? ""),
      );
      if (!failedResult) continue;
      actionRequiredTrackIds.add(track.trackId);
      if (track.status !== "overdue") {
        track.status = "attention";
        track.badge = "Action required";
      }
      track.items.unshift({
        label: `${String(result.check_type ?? "Check").replace(/_/g, " ")} result requires action`,
        detail: `${result.result || "Action required"}${result.location ? ` — ${result.location}` : ""}${result.date ? ` (${result.date})` : ""}`,
        path: resultQuery.path,
      });
    }
  });

  // A red state means a user must act now. Amber future reminders remain
  // visible through their existing badge but do not turn the module red.
  // A track with nothing recorded and nothing overdue is "not started": a
  // neutral state, so a new business does not see every module as failing.
  const summaries: TrackSummary[] = tracks.map((track) => {
    const dueNow = track.items.some((item) => /due today/i.test(item.detail));
    const futureReminderOnly =
      track.status === "attention" &&
      /(due soon|due for testing|review.*due soon|expiring soon)/i.test(track.badge) &&
      track.items.length > 0 &&
      track.items.every((item) =>
        /^due soon$|due in|review due|next test due|expires \d{4}-\d{2}-\d{2}/i.test(item.detail),
      ) &&
      !dueNow;
    const health: TrackSummary["health"] = !track.enabled
      ? "clear"
      : track.status === "overdue" ||
        unavailableTrackIds.has(track.trackId) ||
        actionRequiredTrackIds.has(track.trackId) ||
        (track.status === "attention" && !futureReminderOnly)
      ? "action_required"
      : track.status === "no_data"
      ? "not_started"
      : "clear";
    return { ...track, health };
  });

  // Modules the business did not pick in setup move to "Other modules" while
  // they are not started; once used or needing action they stay in the list.
  const picked = new Set(await getPickedModules(clientId).catch(() => [] as string[]));
  if (picked.size > 0) {
    for (const summary of summaries) {
      const keys = TRACK_PICK_KEYS[summary.trackId];
      summary.otherModule = summary.enabled && summary.health === "not_started"
        && !!keys && !keys.some((key) => picked.has(key));
    }
  }

  res.json({ tracks: summaries, checklistTotals });
});

export default router;
