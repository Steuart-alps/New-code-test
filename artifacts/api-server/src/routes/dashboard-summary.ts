/**
 * GET /api/dashboard/summary?siteId=N
 *
 * Returns a per-track status summary for the dashboard.
 * Each track shows a status (ok/attention/overdue/no_data), a badge label,
 * and a list of specific outstanding items with links to complete them.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getActiveDepartmentId, getClientId } from "../middleware/requireAuth";
import { getCheckAlerts } from "../lib/checkReminders";
import { getEntitledServices, isEntitled } from "../lib/services";

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
  health: "action_required" | "clear";
  badge: string;
  items: TrackItem[];
}

export interface ChecklistTotals {
  date: string;
  expectedAmPairs: number;
  completedAmPairs: number;
  expectedPmPairs: number;
  completedPmPairs: number;
  completedSitePairs: number;
}

function rows(result: unknown): any[] {
  return (result as any).rows ?? [];
}

router.get("/dashboard/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rawSiteId = req.query.siteId as string | undefined;
  const siteId = rawSiteId && !isNaN(parseInt(rawSiteId, 10)) ? parseInt(rawSiteId, 10) : null;
  const departmentId = getActiveDepartmentId(req);
  let accessibleSiteIds: number[] | null = null;
  try {
    if (departmentId != null) {
      const accessibleRows = await db.execute(sql`
        SELECT id FROM sites
        WHERE client_id = ${clientId}
          AND (department_id IS NULL OR department_id = ${departmentId})
      `);
      accessibleSiteIds = rows(accessibleRows).map((site: any) => Number(site.id));
    }
    if (siteId != null) {
      const requestedSite = await db.execute(sql`
        SELECT id FROM sites
        WHERE id = ${siteId} AND client_id = ${clientId}
          ${departmentId != null ? sql`AND (department_id IS NULL OR department_id = ${departmentId})` : sql``}
        LIMIT 1
      `);
      if (rows(requestedSite).length === 0) {
        return res.status(403).json({ error: "Site is not available in the current department" });
      }
    }
  } catch {
    return res.status(500).json({ error: "Unable to validate site access" });
  }
  const protectedSiteClause = siteId != null
    ? sql`AND site_id = ${siteId}`
    : accessibleSiteIds != null
    ? sql`AND (site_id IS NULL OR site_id = ANY(${accessibleSiteIds}))`
    : sql``;

  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const services = await getEntitledServices(clientId);
  const entitled = (key: string) =>
    isEntitled(services, key as Parameters<typeof isEntitled>[1]);

  const tracks: Omit<TrackSummary, "health">[] = [];

  // ── Sites list (for daily track gap detection) ──────────────────────────────
  let allSites: { id: number; name: string }[] = [];
  try {
    const siteRows = await db.execute(sql`
      SELECT id, name FROM sites
      WHERE client_id = ${clientId} AND archived = false
      ${siteId ? sql`AND id = ${siteId}` : sql``}
      ORDER BY name
    `);
    allSites = rows(siteRows)
      .map((r: any) => ({ id: r.id, name: r.name }))
      .filter((site) => accessibleSiteIds == null || accessibleSiteIds.includes(site.id));
  } catch {
    // sites table always exists; skip silently if error
  }

  // A site has one expected AM pair and one expected PM pair. Each branch is
  // complete when any of its real checklist types has been submitted; this
  // keeps KitchenTrack and SafeTrack checklists under the same definition.
  const checklistTotals: ChecklistTotals = {
    date: today,
    expectedAmPairs: allSites.length,
    completedAmPairs: 0,
    expectedPmPairs: allSites.length,
    completedPmPairs: 0,
    completedSitePairs: 0,
  };
  const checklistCompletionBySite = new Map<number, { am: boolean; pm: boolean }>();
  let checklistTotalsAvailable = false;
  if (allSites.length > 0) {
    try {
      const completed = await db.execute(sql`
        SELECT
          site_id,
          BOOL_OR(checklist_type IN ('kitchen_opening', 'premises_opening')) FILTER (WHERE submitted_at IS NOT NULL) AS am_submitted,
          BOOL_OR(checklist_type IN ('kitchen_closing', 'premises_closing')) FILTER (WHERE submitted_at IS NOT NULL) AS pm_submitted
        FROM daily_checklists
        WHERE client_id = ${clientId}
          AND check_date = ${today}
          AND site_id = ANY(${allSites.map((site) => site.id)})
        GROUP BY site_id
      `);
      for (const row of rows(completed)) {
        checklistCompletionBySite.set(Number(row.site_id), {
          am: row.am_submitted === true || row.am_submitted === "true",
          pm: row.pm_submitted === true || row.pm_submitted === "true",
        });
      }
      checklistTotalsAvailable = true;
      for (const site of allSites) {
        const complete = checklistCompletionBySite.get(site.id);
        if (complete?.am) checklistTotals.completedAmPairs++;
        if (complete?.pm) checklistTotals.completedPmPairs++;
        if (complete?.am && complete.pm) checklistTotals.completedSitePairs++;
      }
    } catch {
      // The established per-track no-data fallback remains available below.
    }
  }

  // ── Daily AM ─────────────────────────────────────────────────────────────────
  const amEnabled = entitled("kitchentrack") || entitled("safetrack") || entitled("dailytrack_am");
  {
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (amEnabled && allSites.length > 0) {
      if (checklistTotalsAvailable) {
        const missing = allSites.filter((site) => !checklistCompletionBySite.get(site.id)?.am);
        if (missing.length === 0) {
          status = "ok";
          badge = "All submitted";
        } else {
          status = "overdue";
          badge = `${missing.length} site${missing.length > 1 ? "s" : ""} not submitted`;
          for (const site of missing.slice(0, 10)) {
            items.push({ label: site.name, detail: "AM checklist not submitted today", path: "/daily-track-am" });
          }
        }
      } else {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "daily_am",
      label: "Daily AM Checklist",
      path: "/daily-track-am",
      enabled: amEnabled,
      status,
      badge,
      items,
    });
  }

  // ── Daily PM / Sign-off ───────────────────────────────────────────────────────
  const pmEnabled = entitled("kitchentrack") || entitled("safetrack") || entitled("dailytrack_pm");
  {
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (pmEnabled && allSites.length > 0) {
      if (checklistTotalsAvailable) {
        const missing = allSites.filter((site) => !checklistCompletionBySite.get(site.id)?.pm);
        if (missing.length === 0) {
          status = "ok";
          badge = "All submitted";
        } else {
          status = "attention";
          badge = `${missing.length} site${missing.length > 1 ? "s" : ""} not submitted`;
          for (const site of missing.slice(0, 10)) {
            items.push({ label: site.name, detail: "PM checklist not submitted today", path: "/daily-track-pm" });
          }
        }
      } else {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "daily_pm",
      label: "Daily PM Sign-off",
      path: "/daily-track-pm",
      enabled: pmEnabled,
      status,
      badge,
      items,
    });
  }

  // ── KitchenTrack — food safety diary ─────────────────────────────────────────
  {
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
        const missing = allSites.filter((s) => !submittedIds.has(s.id));
        if (missing.length === 0) {
          status = "ok";
          badge = "All submitted";
        } else {
          status = "attention";
          badge = `${missing.length} site${missing.length > 1 ? "s" : ""} not recorded today`;
          for (const site of missing.slice(0, 10)) {
            items.push({ label: site.name, detail: "Food safety diary not submitted today", path: "/kitchen" });
          }
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "kitchen",
      label: "KitchenTrack",
      path: "/kitchen",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── FireTrack ─────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("firetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled && departmentId === null) {
      try {
        const alerts = await getCheckAlerts(clientId);
        const fireAlerts = alerts.filter((a) => a.module === "fire");
        const overdue = fireAlerts.filter((a) => a.status === "overdue");
        const dueSoon = fireAlerts.filter((a) => a.status === "due_soon");
        const never = fireAlerts.filter((a) => a.status === "never");
        const totalAlerts = fireAlerts.length;

        if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue`;
        } else if (dueSoon.length > 0) {
          status = "attention";
          badge = `${dueSoon.length} due soon`;
        } else if (never.length > 0) {
          status = "no_data";
          badge = `${never.length} check${never.length > 1 ? "s" : ""} never recorded`;
        } else if (totalAlerts === 0) {
          status = "ok";
          badge = "All checks up to date";
        } else if (never.length > 0 && overdue.length === 0 && dueSoon.length === 0) {
          status = "no_data";
          badge = "No records yet";
        } else {
          status = "ok";
          badge = "All checks up to date";
        }

        for (const a of [...overdue, ...dueSoon, ...never].slice(0, 10)) {
          const days = a.daysUntilDue;
          const detail =
            a.status === "overdue"
              ? `Overdue by ${Math.abs(days ?? 0)} day${Math.abs(days ?? 0) !== 1 ? "s" : ""}`
              : days === 0
              ? "Due today"
              : a.status === "never"
              ? "No record has been submitted"
              : `Due in ${days} day${days !== 1 ? "s" : ""}`;
          items.push({ label: a.checkLabel, detail, path: "/fire-safety" });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "fire",
      label: "FireTrack",
      path: "/fire-safety",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── LegionellaTrack ───────────────────────────────────────────────────────────
  {
    const enabled = entitled("legionellatrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled && departmentId === null) {
      try {
        const alerts = await getCheckAlerts(clientId);
        const legAlerts = alerts.filter((a) => a.module === "legionella");
        const overdue = legAlerts.filter((a) => a.status === "overdue");
        const dueSoon = legAlerts.filter((a) => a.status === "due_soon");
        const never = legAlerts.filter((a) => a.status === "never");

        if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue`;
        } else if (dueSoon.length > 0) {
          status = "attention";
          badge = `${dueSoon.length} due soon`;
        } else if (never.length > 0 || legAlerts.length === 0) {
          status = "no_data";
          badge = never.length > 0 ? `${never.length} check${never.length > 1 ? "s" : ""} never recorded` : "No records yet";
        } else {
          status = "ok";
          badge = "All checks up to date";
        }

        for (const a of [...overdue, ...dueSoon, ...never].slice(0, 10)) {
          const days = a.daysUntilDue;
          const detail =
            a.status === "overdue"
              ? `Overdue by ${Math.abs(days ?? 0)} day${Math.abs(days ?? 0) !== 1 ? "s" : ""}`
              : days === 0
              ? "Due today"
              : a.status === "never" ? "No record has been submitted" : `Due in ${days} day${days !== 1 ? "s" : ""}`;
          items.push({ label: a.checkLabel, detail, path: "/legionella" });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "legionella",
      label: "LegionellaTrack",
      path: "/legionella",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── PoolTrack ─────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("pooltrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled && departmentId === null) {
      try {
        const alerts = await getCheckAlerts(clientId);
        const poolAlerts = alerts.filter((a) => a.module === "pool");
        const overdue = poolAlerts.filter((a) => a.status === "overdue");
        const dueSoon = poolAlerts.filter((a) => a.status === "due_soon");
        const never = poolAlerts.filter((a) => a.status === "never");

        if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue`;
        } else if (dueSoon.length > 0) {
          status = "attention";
          badge = `${dueSoon.length} due soon`;
        } else if (never.length > 0 || poolAlerts.length === 0) {
          status = "no_data";
          badge = never.length > 0 ? `${never.length} check${never.length > 1 ? "s" : ""} never recorded` : "No records yet";
        } else {
          status = "ok";
          badge = "All checks up to date";
        }

        for (const a of [...overdue, ...dueSoon, ...never].slice(0, 10)) {
          const detail =
            a.status === "overdue" ? "Overdue check" : a.status === "never" ? "No record has been submitted" : "Due soon";
          items.push({ label: a.checkLabel, detail, path: "/aqua-track" });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "pool",
      label: "PoolTrack",
      path: "/aqua-track",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── PATtrack ──────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("pattrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = siteId != null
          ? sql`AND a.site_id = ${siteId}`
          : accessibleSiteIds != null ? sql`AND (a.site_id IS NULL OR a.site_id = ANY(${accessibleSiteIds}))` : sql``;
        const patRows = await db.execute(sql`
          SELECT
            a.id, a.name, a.appliance_type, a.location,
            last.next_test_date
          FROM pat_appliances a
          LEFT JOIN LATERAL (
            SELECT next_test_date
            FROM pat_tests
            WHERE appliance_id = a.id
            ORDER BY test_date DESC, id DESC
            LIMIT 1
          ) last ON true
          WHERE a.client_id = ${clientId} ${siteClause}
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
          badge = `${untested.length} appliance${untested.length > 1 ? "s" : ""} never tested`;
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
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "pat",
      label: "PATtrack",
      path: "/pat-track",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── PestTrack ──────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("pesttrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        // Overdue visits
        const overdueVisits = await db.execute(sql`
          SELECT id, pest_contractor, next_visit_date, site_id
          FROM pest_visits
          WHERE client_id = ${clientId}
            AND next_visit_date IS NOT NULL
            AND next_visit_date < ${today}
            ${siteClause}
          ORDER BY next_visit_date ASC
          LIMIT 10
        `);
        // Open pest activities
        const openActivities = await db.execute(sql`
          SELECT id, pest_type, area_affected
          FROM pest_activities
          WHERE client_id = ${clientId}
            AND status = 'active'
            ${siteClause}
          ORDER BY id DESC
          LIMIT 10
        `);

        const overdueCount = rows(overdueVisits).length;
        const openCount = rows(openActivities).length;

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${overdueCount} visit${overdueCount > 1 ? "s" : ""} overdue`;
          for (const v of rows(overdueVisits).slice(0, 5)) {
            items.push({
              label: `Visit overdue`,
              detail: `${v.pest_contractor ?? "Unknown contractor"} — due ${v.next_visit_date}`,
              path: "/pest-track",
            });
          }
        } else if (openCount > 0) {
          status = "attention";
          badge = `${openCount} active infestation${openCount > 1 ? "s" : ""}`;
          for (const a of rows(openActivities).slice(0, 5)) {
            items.push({
              label: a.pest_type ?? "Pest activity",
              detail: `Active — ${a.area_affected ?? "area not specified"}`,
              path: "/pest-track",
            });
          }
        } else {
          // Check if there are any records at all
          const anyRows = await db.execute(sql`
            SELECT 1 FROM pest_visits WHERE client_id = ${clientId} ${siteClause} LIMIT 1
          `);
          if (rows(anyRows).length === 0) {
            status = "no_data";
            badge = "No records yet";
          } else {
            status = "ok";
            badge = "All up to date";
          }
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "pest",
      label: "PestTrack",
      path: "/pest-track",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── FixTrack ──────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("fixtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const openIssues = await db.execute(sql`
          SELECT id, title, priority, status, reported_date
          FROM fix_track_issues
          WHERE client_id = ${clientId}
            AND status IN ('reported', 'in_progress')
            ${siteClause}
          ORDER BY
            CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            reported_date ASC
          LIMIT 10
        `);
        const urgent = rows(openIssues).filter(
          (i: any) => i.priority === "urgent" || i.priority === "high",
        );
        const total = rows(openIssues).length;

        if (urgent.length > 0) {
          status = "overdue";
          badge = `${urgent.length} urgent/high issue${urgent.length > 1 ? "s" : ""} open`;
        } else if (total > 0) {
          status = "attention";
          badge = `${total} open issue${total > 1 ? "s" : ""}`;
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
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "fix",
      label: "FixTrack",
      path: "/fix-track",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── PremisesTrack ─────────────────────────────────────────────────────────────
  {
    const enabled = entitled("premisestrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const [openInspections, activeCounts] = await Promise.all([
          db.execute(sql`
            SELECT id, inspection_type, inspection_date, next_inspection_date, status, site_id
            FROM premises_inspections
            WHERE client_id = ${clientId}
              AND status IN ('open', 'actioned')
              ${siteClause}
            ORDER BY
              CASE WHEN next_inspection_date < ${today} THEN 0 ELSE 1 END,
              next_inspection_date ASC NULLS LAST
            LIMIT 10
          `),
          db.execute(sql`
            SELECT
              count(*)::int AS total,
              count(*) FILTER (WHERE next_inspection_date < ${today})::int AS overdue
            FROM premises_inspections
            WHERE client_id = ${clientId}
              AND status IN ('open', 'actioned')
              ${siteClause}
          `),
        ]);
        const countRow = rows(activeCounts)[0] ?? {};
        const overdueCount = Number(countRow.overdue ?? 0);
        const total = Number(countRow.total ?? 0);

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${overdueCount} overdue inspection${overdueCount > 1 ? "s" : ""}`;
        } else if (total > 0) {
          status = "attention";
          badge = `${total} open inspection${total > 1 ? "s" : ""}`;
        } else {
          const anyRows = await db.execute(sql`
            SELECT 1 FROM premises_inspections WHERE client_id = ${clientId} ${siteClause} LIMIT 1
          `);
          status = rows(anyRows).length > 0 ? "ok" : "no_data";
          badge = rows(anyRows).length > 0 ? "No open inspections" : "No records yet";
        }

        for (const i of rows(openInspections)) {
          const inspType = (i.inspection_type as string)
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c: string) => c.toUpperCase());
          const detail = i.next_inspection_date
            ? i.next_inspection_date < today
              ? `Overdue since ${i.next_inspection_date}`
              : `Due ${i.next_inspection_date}`
            : `Status: ${i.status}`;
          items.push({ label: inspType, detail, path: "/premises-track" });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "premises",
      label: "PremisesTrack",
      path: "/premises-track",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── DocTrack ──────────────────────────────────────────────────────────────────
  // ── RoomTrack ─────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("roomtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No rooms";
    if (enabled) {
      try {
        const roomSiteClause = siteId != null
          ? sql`AND r.site_id = ${siteId}`
          : accessibleSiteIds != null
          ? sql`AND (r.site_id IS NULL OR r.site_id = ANY(${accessibleSiteIds}))`
          : sql``;
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
            ${roomSiteClause}
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
          items.push({ label: `${total} room${total === 1 ? "" : "s"} unchecked`, detail: "Room checks are still due today", path: "/room-track" });
        } else if (checked < total) {
          status = "attention";
          badge = `${checked} / ${total} checked today`;
          items.push({ label: `${total - checked} room${total - checked === 1 ? "" : "s"} unchecked`, detail: "Room checks are still due today", path: "/room-track" });
        } else {
          status = "ok";
          badge = `${checked} / ${total} checked today`;
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }
    tracks.push({ trackId: "room", label: "RoomTrack", path: "/room-track", enabled, status, badge, items });
  }

  {
    const enabled = entitled("doctrack") || entitled("safetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const overdueRows = await db.execute(sql`
          SELECT id, title, next_review_date, category
          FROM doc_track_documents
          WHERE client_id = ${clientId}
            AND next_review_date IS NOT NULL
            AND next_review_date < ${today}
            ${siteClause}
          ORDER BY next_review_date ASC
          LIMIT 10
        `);
        const dueSoonRows = await db.execute(sql`
          SELECT id, title, next_review_date, category
          FROM doc_track_documents
          WHERE client_id = ${clientId}
            AND next_review_date IS NOT NULL
            AND next_review_date >= ${today}
            AND next_review_date <= ${in30}
            ${siteClause}
          ORDER BY next_review_date ASC
          LIMIT 10
        `);
        const overdueCount = rows(overdueRows).length;
        const dueSoonCount = rows(dueSoonRows).length;

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${overdueCount} review${overdueCount > 1 ? "s" : ""} overdue`;
        } else if (dueSoonCount > 0) {
          status = "attention";
          badge = `${dueSoonCount} review${dueSoonCount > 1 ? "s" : ""} due soon`;
        } else {
          const anyRows = await db.execute(sql`
            SELECT 1 FROM doc_track_documents WHERE client_id = ${clientId} ${siteClause} LIMIT 1
          `);
          status = rows(anyRows).length > 0 ? "ok" : "no_data";
          badge = rows(anyRows).length > 0 ? "All documents up to date" : "No documents yet";
        }

        for (const d of rows(overdueRows)) {
          items.push({
            label: d.title,
            detail: `Review overdue since ${d.next_review_date}`,
            path: "/doc-track",
          });
        }
        for (const d of rows(dueSoonRows)) {
          items.push({
            label: d.title,
            detail: `Review due ${d.next_review_date}`,
            path: "/doc-track",
          });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "doc",
      label: "DocTrack",
      path: "/doc-track",
      enabled,
      status,
      badge,
      items,
    });
  }

  // ── SafeTrack — risk assessments & SOPs ─────────────────────────────────────
  {
    const enabled = entitled("safetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        // Overdue risk assessments
        const overdueRA = await db.execute(sql`
          SELECT id, title, next_review_date FROM safe_risk_assessments
          WHERE client_id = ${clientId} AND next_review_date IS NOT NULL AND next_review_date < ${today} ${siteClause}
          ORDER BY next_review_date ASC LIMIT 5
        `);
        // Overdue SOPs
        const overdueSOPs = await db.execute(sql`
          SELECT id, title, next_review_date FROM safe_sops
          WHERE client_id = ${clientId} AND next_review_date IS NOT NULL AND next_review_date < ${today} ${siteClause}
          ORDER BY next_review_date ASC LIMIT 5
        `);
        // Due soon
        const dueSoonRA = await db.execute(sql`
          SELECT id, title, next_review_date FROM safe_risk_assessments
          WHERE client_id = ${clientId} AND next_review_date >= ${today} AND next_review_date <= ${in30} ${siteClause}
          ORDER BY next_review_date ASC LIMIT 5
        `);
        const dueSoonSOPs = await db.execute(sql`
          SELECT id, title, next_review_date FROM safe_sops
          WHERE client_id = ${clientId} AND next_review_date >= ${today} AND next_review_date <= ${in30} ${siteClause}
          ORDER BY next_review_date ASC LIMIT 5
        `);

        const overdueCount = rows(overdueRA).length + rows(overdueSOPs).length;
        const dueSoonCount = rows(dueSoonRA).length + rows(dueSoonSOPs).length;

        if (overdueCount > 0) {
          status = "overdue";
          badge = `${overdueCount} review${overdueCount > 1 ? "s" : ""} overdue`;
        } else if (dueSoonCount > 0) {
          status = "attention";
          badge = `${dueSoonCount} review${dueSoonCount > 1 ? "s" : ""} due soon`;
        } else {
          const anyRows = await db.execute(sql`
            SELECT 1 FROM safe_risk_assessments WHERE client_id = ${clientId} ${siteClause} LIMIT 1
          `);
          status = rows(anyRows).length > 0 ? "ok" : "no_data";
          badge = rows(anyRows).length > 0 ? "All documents up to date" : "No records yet";
        }

        for (const d of rows(overdueRA)) {
          items.push({ label: d.title, detail: `Risk assessment review overdue since ${d.next_review_date}`, path: "/safe-track" });
        }
        for (const d of rows(overdueSOPs)) {
          items.push({ label: d.title, detail: `SOP review overdue since ${d.next_review_date}`, path: "/safe-track" });
        }
        for (const d of rows(dueSoonRA)) {
          items.push({ label: d.title, detail: `Risk assessment review due ${d.next_review_date}`, path: "/safe-track" });
        }
        for (const d of rows(dueSoonSOPs)) {
          items.push({ label: d.title, detail: `SOP review due ${d.next_review_date}`, path: "/safe-track" });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({ trackId: "safe", label: "SafeTrack", path: "/safe-track", enabled, status, badge, items });
  }

  // ── TrainTrack ────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("traintrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const expiredRows = await db.execute(sql`
          SELECT id, staff_name, training_title, expiry_date
          FROM train_track_records
          WHERE client_id = ${clientId} AND expiry_date IS NOT NULL AND expiry_date < ${today} ${siteClause}
          ORDER BY expiry_date ASC LIMIT 10
        `);
        const expiringSoonRows = await db.execute(sql`
          SELECT id, staff_name, training_title, expiry_date
          FROM train_track_records
          WHERE client_id = ${clientId} AND expiry_date >= ${today} AND expiry_date <= ${in30} ${siteClause}
          ORDER BY expiry_date ASC LIMIT 10
        `);

        const expiredCount = rows(expiredRows).length;
        const expiringSoonCount = rows(expiringSoonRows).length;

        if (expiredCount > 0) {
          status = "overdue";
          badge = `${expiredCount} expired certificate${expiredCount > 1 ? "s" : ""}`;
        } else if (expiringSoonCount > 0) {
          status = "attention";
          badge = `${expiringSoonCount} expiring soon`;
        } else {
          const anyRows = await db.execute(sql`SELECT 1 FROM train_track_records WHERE client_id = ${clientId} ${siteClause} LIMIT 1`);
          status = rows(anyRows).length > 0 ? "ok" : "no_data";
          badge = rows(anyRows).length > 0 ? "All training up to date" : "No records yet";
        }

        for (const r of rows(expiredRows)) {
          items.push({ label: `${r.staff_name} — ${r.training_title}`, detail: `Expired ${r.expiry_date}`, path: "/train-track" });
        }
        for (const r of rows(expiringSoonRows)) {
          items.push({ label: `${r.staff_name} — ${r.training_title}`, detail: `Expires ${r.expiry_date}`, path: "/train-track" });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({ trackId: "train", label: "TrainTrack", path: "/train-track", enabled, status, badge, items });
  }

  // ── HotTubTrack ───────────────────────────────────────────────────────────────
  {
    const enabled = entitled("hottubtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const MS_DAY = 86400000;
        const todayDays = Math.floor(Date.now() / MS_DAY);
        const toUtcDays = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_DAY);

        const FREQ: Record<string, number> = {
          water_chemistry: 1, temperature: 1, filter_clean: 7,
          cover_inspection: 7, drain_refill: 91, microbiological_test: 91, risk_assessment: 365,
        };
        const CHECK_LABELS: Record<string, string> = {
          water_chemistry: "Water chemistry check", temperature: "Temperature check",
          filter_clean: "Filter clean", cover_inspection: "Cover inspection",
          drain_refill: "Drain & refill", microbiological_test: "Microbiological test",
          risk_assessment: "Risk assessment review",
        };

        const lastRows = await db.execute(sql`
          SELECT check_type, MAX(check_date) AS last_date
          FROM hot_tub_checks WHERE client_id = ${clientId} ${siteClause}
          GROUP BY check_type
        `);
        const lastByType = new Map(rows(lastRows).map((r: any) => [r.check_type, r.last_date]));

        let overdueCount = 0;
        let dueSoonCount = 0;
        let hasAny = lastByType.size > 0;

        for (const [ct, freqDays] of Object.entries(FREQ)) {
          const lastDate = lastByType.get(ct);
          if (!lastDate) continue;
          const dueDays = toUtcDays(lastDate) + freqDays;
          const daysUntil = dueDays - todayDays;
          const window = Math.max(1, Math.ceil(freqDays * 0.2));
          if (daysUntil < 0) {
            overdueCount++;
            items.push({ label: CHECK_LABELS[ct] ?? ct, detail: `Overdue by ${Math.abs(daysUntil)} day${Math.abs(daysUntil) !== 1 ? "s" : ""}`, path: "/hot-tub" });
          } else if (daysUntil <= window) {
            dueSoonCount++;
            items.push({ label: CHECK_LABELS[ct] ?? ct, detail: daysUntil === 0 ? "Due today" : `Due in ${daysUntil} day${daysUntil !== 1 ? "s" : ""}`, path: "/hot-tub" });
          }
        }

        if (overdueCount > 0) { status = "overdue"; badge = `${overdueCount} overdue`; }
        else if (dueSoonCount > 0) { status = "attention"; badge = `${dueSoonCount} due soon`; }
        else if (!hasAny) { status = "no_data"; badge = "No records yet"; }
        else { status = "ok"; badge = "All checks up to date"; }
      } catch {
        status = "no_data"; badge = "No records";
      }
    }

    tracks.push({ trackId: "hot_tub", label: "HotTubTrack", path: "/hot-tub", enabled, status, badge, items });
  }

  // ── TreeTrack ─────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("treetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        const MS_DAY = 86400000;
        const todayDays = Math.floor(Date.now() / MS_DAY);
        const toUtcDays = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_DAY);

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
            items.push({ label: CHECK_LABELS[ct] ?? ct, detail: `Overdue by ${Math.abs(daysUntil)} day${Math.abs(daysUntil) !== 1 ? "s" : ""}`, path: "/tree-track" });
          } else if (daysUntil <= window) {
            dueSoonCount++;
            items.push({ label: CHECK_LABELS[ct] ?? ct, detail: daysUntil === 0 ? "Due today" : `Due in ${daysUntil} day${daysUntil !== 1 ? "s" : ""}`, path: "/tree-track" });
          }
        }

        if (overdueCount > 0) { status = "overdue"; badge = `${overdueCount} overdue`; }
        else if (dueSoonCount > 0) { status = "attention"; badge = `${dueSoonCount} due soon`; }
        else if (!hasAny) { status = "no_data"; badge = "No records yet"; }
        else { status = "ok"; badge = "All inspections up to date"; }
      } catch {
        status = "no_data"; badge = "No records";
      }
    }

    tracks.push({ trackId: "tree", label: "TreeTrack", path: "/tree-track", enabled, status, badge, items });
  }

  // ── BikeTrack ─────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("biketrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = siteId != null
          ? sql`AND b.site_id = ${siteId}`
          : accessibleSiteIds != null ? sql`AND (b.site_id IS NULL OR b.site_id = ANY(${accessibleSiteIds}))` : sql``;
        // Bikes currently on hire past their expected return date
        const overdueHires = await db.execute(sql`
          SELECT h.id, b.name AS bike_name, h.hirer_name, h.return_date_expected
          FROM bike_hire_records h
          JOIN bikes b ON b.id = h.bike_id
          WHERE h.client_id = ${clientId}
            AND h.status = 'active'
            AND h.return_date_expected IS NOT NULL
            AND h.return_date_expected < ${today}
            ${siteClause}
          ORDER BY h.return_date_expected ASC
          LIMIT 10
        `);
        // Bikes with overdue service
        const overdueService = await db.execute(sql`
          SELECT DISTINCT b.id, b.name
          FROM bikes b
          JOIN LATERAL (
            SELECT next_service_date FROM bike_service_records
            WHERE bike_id = b.id AND client_id = b.client_id
            ORDER BY service_date DESC LIMIT 1
          ) s ON true
          WHERE b.client_id = ${clientId}
            ${siteClause}
            AND s.next_service_date IS NOT NULL
            AND s.next_service_date < ${today}
          LIMIT 10
        `);

        const overdueHireCount = rows(overdueHires).length;
        const overdueServiceCount = rows(overdueService).length;

        if (overdueHireCount > 0) {
          status = "overdue";
          badge = `${overdueHireCount} bike${overdueHireCount > 1 ? "s" : ""} not returned`;
          for (const h of rows(overdueHires)) {
            items.push({ label: h.bike_name ?? "Bike", detail: `${h.hirer_name ?? "Unknown"} — return overdue since ${h.return_date_expected}`, path: "/bike-track" });
          }
        } else if (overdueServiceCount > 0) {
          status = "attention";
          badge = `${overdueServiceCount} bike${overdueServiceCount > 1 ? "s" : ""} overdue service`;
          for (const b of rows(overdueService)) {
            items.push({ label: b.name, detail: "Service overdue", path: "/bike-track" });
          }
        } else {
          const anyRows = await db.execute(sql`SELECT 1 FROM bikes b WHERE b.client_id = ${clientId} ${siteClause} LIMIT 1`);
          status = rows(anyRows).length > 0 ? "ok" : "no_data";
          badge = rows(anyRows).length > 0 ? "No bikes overdue" : "No bikes registered";
        }
      } catch {
        status = "no_data"; badge = "No records";
      }
    }

    tracks.push({ trackId: "bike", label: "BikeTrack", path: "/bike-track", enabled, status, badge, items });
  }

  // ── GreenTrack ────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("greentrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = siteId != null
          ? sql`AND m.site_id = ${siteId}`
          : accessibleSiteIds != null ? sql`AND (m.site_id IS NULL OR m.site_id = ANY(${accessibleSiteIds}))` : sql``;
        // Machines with no pre-use check today
        const machines = await db.execute(sql`
          SELECT m.id, m.name, m.type FROM green_machines m
          WHERE m.client_id = ${clientId} AND m.active = true ${siteClause}
          ORDER BY m.name
        `);
        const checkedTodayRows = await db.execute(sql`
          SELECT DISTINCT c.machine_id FROM green_pre_use_checks c
          JOIN green_machines m ON m.id = c.machine_id
          WHERE c.client_id = ${clientId} AND c.check_date = ${today} ${siteClause}
        `);
        const checkedTodayIds = new Set(rows(checkedTodayRows).map((r: any) => r.machine_id));
        const uncheckedToday = rows(machines).filter((m: any) => !checkedTodayIds.has(m.id));

        // Machines with overdue service
        const overdueService = await db.execute(sql`
          SELECT DISTINCT m.id, m.name
          FROM green_machines m
          JOIN LATERAL (
            SELECT next_service_date FROM green_service_records
            WHERE machine_id = m.id AND client_id = m.client_id
            ORDER BY service_date DESC LIMIT 1
          ) s ON true
          WHERE m.client_id = ${clientId} AND m.active = true ${siteClause}
            AND s.next_service_date IS NOT NULL AND s.next_service_date < ${today}
          LIMIT 10
        `);

        const overdueServiceCount = rows(overdueService).length;
        const uncheckedCount = uncheckedToday.length;
        const totalMachines = rows(machines).length;

        if (overdueServiceCount > 0) {
          status = "overdue";
          badge = `${overdueServiceCount} machine${overdueServiceCount > 1 ? "s" : ""} service overdue`;
          for (const m of rows(overdueService)) {
            items.push({ label: m.name, detail: "Service overdue", path: "/green-track" });
          }
        } else if (uncheckedCount > 0 && totalMachines > 0) {
          status = "attention";
          badge = `${uncheckedCount} machine${uncheckedCount > 1 ? "s" : ""} not checked today`;
          for (const m of uncheckedToday.slice(0, 10)) {
            items.push({ label: m.name, detail: `${m.type ?? "Machine"} — no pre-use check today`, path: "/green-track" });
          }
        } else if (totalMachines === 0) {
          status = "no_data"; badge = "No machines registered";
        } else {
          status = "ok"; badge = "All machines checked";
        }
      } catch {
        status = "no_data"; badge = "No records";
      }
    }

    tracks.push({ trackId: "green", label: "GreenTrack", path: "/green-track", enabled, status, badge, items });
  }

  // ── SwimTrack ─────────────────────────────────────────────────────────────────
  {
    const enabled = entitled("swimtrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = protectedSiteClause;
        // Check if there's a swim session logged today
        const todaySessions = await db.execute(sql`
          SELECT id, session_type, lifeguard_name, site_id
          FROM swim_sessions
          WHERE client_id = ${clientId} AND session_date = ${today} ${siteClause}
          ORDER BY id DESC LIMIT 10
        `);
        const sessionCount = rows(todaySessions).length;

        // Surveillance checks today
        const todaySurveillance = await db.execute(sql`
          SELECT COUNT(*) AS cnt FROM swim_surveillance_checks
          WHERE client_id = ${clientId} AND check_date = ${today} ${siteClause}
        `);
        const surveillanceCount = Number((rows(todaySurveillance)[0] as any)?.cnt ?? 0);

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
          status = "attention"; badge = `${sessionCount} session${sessionCount > 1 ? "s" : ""} — no surveillance checks`;
          items.push({ label: "Surveillance checks missing", detail: "Session logged but no surveillance checks recorded", path: "/swim-track" });
        } else {
          status = "ok"; badge = `${sessionCount} session${sessionCount > 1 ? "s" : ""} logged`;
        }
      } catch {
        status = "no_data"; badge = "No records";
      }
    }

    tracks.push({ trackId: "swim", label: "SwimTrack", path: "/swim-track", enabled, status, badge, items });
  }

  // ── IncidentTrack ─────────────────────────────────────────────────────────────
  {
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
          badge = `${riddorOutstanding} RIDDOR report${riddorOutstanding > 1 ? "s" : ""} outstanding`;
          items.push({ label: "RIDDOR reporting outstanding", detail: `${riddorOutstanding} incident${riddorOutstanding > 1 ? "s" : ""} require HSE notification`, path: "/incidents" });
        } else if (openCount > 0 || investigatingCount > 0) {
          const count = openCount + investigatingCount;
          status = "attention";
          badge = `${count} open incident${count > 1 ? "s" : ""}`;
          if (openCount > 0) items.push({ label: `${openCount} open incident${openCount > 1 ? "s" : ""}`, detail: "Awaiting action", path: "/incidents" });
          if (investigatingCount > 0) items.push({ label: `${investigatingCount} under investigation`, detail: "Investigation in progress", path: "/incidents" });
        } else if (total === 0) {
          status = "no_data"; badge = "No records yet";
        } else {
          status = "ok"; badge = "No open incidents";
        }
      } catch {
        status = "no_data"; badge = "No records";
      }
    }

    tracks.push({ trackId: "incident", label: "IncidentTrack", path: "/incidents", enabled, status, badge, items });
  }

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
        ${siteId != null ? sql`AND (site_id IS NULL OR site_id = ${siteId})` : accessibleSiteIds != null ? sql`AND (site_id IS NULL OR site_id = ANY(${accessibleSiteIds}))` : sql``}
      ORDER BY due_date ASC NULLS LAST
    `);
    openActions = rows(actionRows);
  } catch {
    // track_actions is introduced independently of this endpoint.
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
        ORDER BY site_id, check_type, check_date DESC, id DESC
      `,
    },
    {
      trackId: "legionella",
      path: "/legionella",
      query: sql`
        SELECT DISTINCT ON (site_id, check_type) check_type, check_date AS date, result, location
        FROM legionella_checks WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_type, check_date DESC, id DESC
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
        SELECT DISTINCT ON (site_id, check_type) check_type, check_date AS date, result, location
        FROM hot_tub_checks WHERE client_id = ${clientId} ${protectedSiteClause}
        ORDER BY site_id, check_type, check_date DESC, id DESC
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
          ${siteId != null ? sql`AND m.site_id = ${siteId}` : accessibleSiteIds != null ? sql`AND (m.site_id IS NULL OR m.site_id = ANY(${accessibleSiteIds}))` : sql``}
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
          ${siteId != null ? sql`AND m.site_id = ${siteId}` : accessibleSiteIds != null ? sql`AND (m.site_id IS NULL OR m.site_id = ANY(${accessibleSiteIds}))` : sql``}
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
  for (const resultQuery of failedResultQueries) {
    try {
      const resultRows = rows(await db.execute(resultQuery.query));
      const track = tracks.find((candidate) => candidate.trackId === resultQuery.trackId);
      if (!track) continue;
      for (const result of resultRows) {
        const failedResult = /fail|action.?required|urgent|out.?of.?range|unsafe|non.?compliant/i.test(
          String(result.result ?? ""),
        );
        if (!failedResult) continue;
        actionRequiredTrackIds.add(track.trackId);
        track.items.unshift({
          label: `${String(result.check_type ?? "Check").replace(/_/g, " ")} result requires action`,
          detail: `${result.result || "Action required"}${result.location ? ` — ${result.location}` : ""}${result.date ? ` (${result.date})` : ""}`,
          path: resultQuery.path,
        });
      }
    } catch {
      // Older schemas can lack a result column; dashboard availability wins.
    }
  }

  // A red state means a user must act now. Amber future reminders remain
  // visible through their existing badge but do not turn the module red.
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
    const health: TrackSummary["health"] =
      track.enabled &&
      (track.status === "overdue" ||
        track.status === "no_data" ||
        actionRequiredTrackIds.has(track.trackId) ||
        (track.status === "attention" && !futureReminderOnly))
        ? "action_required"
        : "clear";
    return { ...track, health };
  });

  res.json({ tracks: summaries, checklistTotals });
});

export default router;
