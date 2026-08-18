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

  // ── SafeTrack — risk assessments & SOPs ─────────────────────────────────────
  {
    const enabled = entitled("safetrack");
    const items: TrackItem[] = [];
    let status: TrackStatus = "no_data";
    let badge = "No records";

    if (enabled) {
      try {
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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
        // Bikes currently on hire past their expected return date
        const overdueHires = await db.execute(sql`
          SELECT h.id, b.name AS bike_name, h.hirer_name, h.return_date_expected
          FROM bike_hire_records h
          JOIN bikes b ON b.id = h.bike_id
          WHERE h.client_id = ${clientId}
            AND h.status = 'active'
            AND h.return_date_expected IS NOT NULL
            AND h.return_date_expected < ${today}
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
          const anyRows = await db.execute(sql`SELECT 1 FROM bikes WHERE client_id = ${clientId} LIMIT 1`);
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
        const siteClause = siteId ? sql`AND m.site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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
        const siteClause = siteId ? sql`AND site_id = ${siteId}` : sql``;
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

  res.json({ tracks });
});

export default router;
