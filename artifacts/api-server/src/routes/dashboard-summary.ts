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
import { requireAuth, getClientId } from "../middleware/requireAuth";
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
  badge: string;
  items: TrackItem[];
}

function rows(result: unknown): any[] {
  return (result as any).rows ?? [];
}

router.get("/dashboard/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rawSiteId = req.query.siteId as string | undefined;
  const siteId = rawSiteId && !isNaN(parseInt(rawSiteId, 10)) ? parseInt(rawSiteId, 10) : null;

  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const services = await getEntitledServices(clientId);
  const entitled = (key: string) =>
    isEntitled(services, key as Parameters<typeof isEntitled>[1]);

  const tracks: TrackSummary[] = [];

  // ── Sites list (for daily track gap detection) ──────────────────────────────
  let allSites: { id: number; name: string }[] = [];
  try {
    const siteRows = await db.execute(sql`
      SELECT id, name FROM sites
      WHERE client_id = ${clientId} AND archived = false
      ${siteId ? sql`AND id = ${siteId}` : sql``}
      ORDER BY name
    `);
    allSites = rows(siteRows).map((r: any) => ({ id: r.id, name: r.name }));
  } catch {
    // sites table always exists; skip silently if error
  }

  // ── Daily AM ─────────────────────────────────────────────────────────────────
  const amEnabled = entitled("kitchentrack") || entitled("safetrack") || entitled("dailytrack_am");
  {
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (amEnabled && allSites.length > 0) {
      try {
        const submitted = await db.execute(sql`
          SELECT DISTINCT site_id
          FROM daily_checklists
          WHERE client_id = ${clientId}
            AND check_date = ${today}
            AND checklist_type = 'am'
            AND submitted_at IS NOT NULL
            ${siteId ? sql`AND site_id = ${siteId}` : sql``}
        `);
        const submittedIds = new Set(rows(submitted).map((r: any) => r.site_id));
        const missing = allSites.filter((s) => !submittedIds.has(s.id));
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
      } catch {
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
      try {
        const signed = await db.execute(sql`
          SELECT DISTINCT site_id
          FROM daily_manager_signoffs
          WHERE client_id = ${clientId}
            AND signoff_date = ${today}
            ${siteId ? sql`AND site_id = ${siteId}` : sql``}
        `);
        const signedIds = new Set(rows(signed).map((r: any) => r.site_id));
        const missing = allSites.filter((s) => !signedIds.has(s.id));
        if (missing.length === 0) {
          status = "ok";
          badge = "All signed off";
        } else {
          status = "attention";
          badge = `${missing.length} site${missing.length > 1 ? "s" : ""} not signed off`;
          for (const site of missing.slice(0, 10)) {
            items.push({ label: site.name, detail: "PM sign-off not completed today", path: "/daily-track-pm" });
          }
        }
      } catch {
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
            items.push({ label: site.name, detail: "Food safety diary not submitted today", path: "/food-safety" });
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
      path: "/food-safety",
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

    if (enabled) {
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
        } else if (totalAlerts === 0 && never.length === 0) {
          status = "ok";
          badge = "All checks up to date";
        } else if (never.length > 0 && overdue.length === 0 && dueSoon.length === 0) {
          status = "no_data";
          badge = "No records yet";
        } else {
          status = "ok";
          badge = "All checks up to date";
        }

        for (const a of [...overdue, ...dueSoon].slice(0, 10)) {
          const days = a.daysUntilDue;
          const detail =
            a.status === "overdue"
              ? `Overdue by ${Math.abs(days ?? 0)} day${Math.abs(days ?? 0) !== 1 ? "s" : ""}`
              : days === 0
              ? "Due today"
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

    if (enabled) {
      try {
        const alerts = await getCheckAlerts(clientId);
        const legAlerts = alerts.filter((a) => a.module === "legionella");
        const overdue = legAlerts.filter((a) => a.status === "overdue");
        const dueSoon = legAlerts.filter((a) => a.status === "due_soon");

        if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue`;
        } else if (dueSoon.length > 0) {
          status = "attention";
          badge = `${dueSoon.length} due soon`;
        } else if (legAlerts.length === 0) {
          status = "no_data";
          badge = "No records yet";
        } else {
          status = "ok";
          badge = "All checks up to date";
        }

        for (const a of [...overdue, ...dueSoon].slice(0, 10)) {
          const days = a.daysUntilDue;
          const detail =
            a.status === "overdue"
              ? `Overdue by ${Math.abs(days ?? 0)} day${Math.abs(days ?? 0) !== 1 ? "s" : ""}`
              : days === 0
              ? "Due today"
              : `Due in ${days} day${days !== 1 ? "s" : ""}`;
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

    if (enabled) {
      try {
        const alerts = await getCheckAlerts(clientId);
        const poolAlerts = alerts.filter((a) => a.module === "pool");
        const overdue = poolAlerts.filter((a) => a.status === "overdue");
        const dueSoon = poolAlerts.filter((a) => a.status === "due_soon");

        if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue`;
        } else if (dueSoon.length > 0) {
          status = "attention";
          badge = `${dueSoon.length} due soon`;
        } else if (poolAlerts.length === 0) {
          status = "no_data";
          badge = "No records yet";
        } else {
          status = "ok";
          badge = "All checks up to date";
        }

        for (const a of [...overdue, ...dueSoon].slice(0, 10)) {
          const detail =
            a.status === "overdue" ? "Overdue check" : "Due soon";
          items.push({ label: a.checkLabel, detail, path: "/pool-track" });
        }
      } catch {
        status = "no_data";
        badge = "No records";
      }
    }

    tracks.push({
      trackId: "pool",
      label: "PoolTrack",
      path: "/pool-track",
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
        const siteClause = siteId ? sql`AND a.site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
        const openInspections = await db.execute(sql`
          SELECT id, inspection_type, inspection_date, next_inspection_date, status, site_id
          FROM premises_inspections
          WHERE client_id = ${clientId}
            AND status IN ('open', 'actioned')
            ${siteClause}
          ORDER BY
            CASE WHEN next_inspection_date < ${today} THEN 0 ELSE 1 END,
            next_inspection_date ASC NULLS LAST
          LIMIT 10
        `);
        const overdue = rows(openInspections).filter(
          (i: any) => i.next_inspection_date && i.next_inspection_date < today,
        );
        const total = rows(openInspections).length;

        if (overdue.length > 0) {
          status = "overdue";
          badge = `${overdue.length} overdue inspection${overdue.length > 1 ? "s" : ""}`;
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
  {
    const enabled = entitled("doctrack") || entitled("safetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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

  res.json({ tracks });
});

export default router;
