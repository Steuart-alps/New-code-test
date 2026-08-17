import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { z } from "zod";

const router = Router();

// ─── Shared schemas ───────────────────────────────────────────────────────────

const complianceSchema = z.object({
  from:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  siteId:       z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});

const trendSchema = z.object({
  months:       z.coerce.number().int().min(2).max(24).default(6),
  siteId:       z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});

// ─── GET /reports/compliance ─────────────────────────────────────────────────

router.get("/reports/compliance", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = complianceSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid params" });

  const { from, to, siteId, departmentId } = parsed.data;

  if (from > to) return res.status(400).json({ error: "'from' must not be after 'to'" });

  const totalDays = Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
  if (totalDays > 366) return res.status(400).json({ error: "Date range cannot exceed 366 days" });

  // Build WHERE fragments for site-scoped queries
  const siteWhereClause =
    siteId && departmentId ? sql`AND s.id = ${siteId} AND s.department_id = ${departmentId}`
    : siteId               ? sql`AND s.id = ${siteId}`
    : departmentId         ? sql`AND s.department_id = ${departmentId}`
    : sql``;

  // Module WHERE: filter by site_id (modules don't join sites directly)
  const moduleWhereClause =
    siteId && departmentId
      ? sql`WHERE site_id = ${siteId} AND site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND department_id = ${departmentId})`
      : siteId
        ? sql`WHERE site_id = ${siteId}`
        : departmentId
          ? sql`WHERE site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND department_id = ${departmentId})`
          : sql``;

  const sitesWhereClause = departmentId
    ? sql`WHERE client_id = ${clientId} AND department_id = ${departmentId}`
    : sql`WHERE client_id = ${clientId}`;

  const [sitesRes, dailyRes, moduleRes] = await Promise.all([

    // ── All sites for this client (optionally filtered by dept) ──────────────
    db.execute(sql`
      SELECT id, name FROM sites
      ${sitesWhereClause}
      ORDER BY name
    `),

    // ── Daily checklists AM & PM — submitted vs expected ─────────────────────
    db.execute(sql`
      SELECT
        s.id         AS site_id,
        s.name       AS site_name,
        t.checklist_type,
        COUNT(DISTINCT dc.check_date)::int AS submitted
      FROM sites s
      CROSS JOIN (VALUES ('am'), ('pm')) AS t(checklist_type)
      LEFT JOIN daily_checklists dc
        ON  dc.site_id        = s.id
        AND dc.client_id      = ${clientId}
        AND dc.checklist_type = t.checklist_type
        AND dc.check_date     BETWEEN ${from} AND ${to}
        AND dc.submitted_at IS NOT NULL
      WHERE s.client_id = ${clientId}
      ${siteWhereClause}
      GROUP BY s.id, s.name, t.checklist_type
      ORDER BY s.name, t.checklist_type
    `),

    // ── Module activity — record counts per module per site ──────────────────
    db.execute(sql`
      SELECT module, site_id, COUNT(*)::int AS records
      FROM (
        SELECT 'FireTrack'     AS module, site_id FROM fire_safety_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'LegionellaTrack',          site_id FROM legionella_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'TubTrack',                 site_id FROM hot_tub_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'TreeTrack',                site_id FROM tree_inspections
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PremisesTrack',            site_id FROM premises_inspections
          WHERE client_id = ${clientId} AND inspection_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PestTrack',                site_id FROM pest_visits
          WHERE client_id = ${clientId} AND visit_date      BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'IncidentTrack',            site_id FROM incidents
          WHERE client_id = ${clientId} AND incident_date   BETWEEN ${from} AND ${to}
            AND site_id IS NOT NULL
        UNION ALL
        SELECT 'FoodSafety',               site_id FROM food_safety_records
          WHERE client_id = ${clientId} AND record_date     BETWEEN ${from} AND ${to}
            AND site_id IS NOT NULL
        UNION ALL
        SELECT 'FixTrack',                 site_id FROM fix_track_issues
          WHERE client_id = ${clientId} AND reported_date   BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'KitchenTrack',             site_id FROM kitchen_cleaning_logs
          WHERE client_id = ${clientId} AND log_date        BETWEEN ${from} AND ${to}
            AND site_id IS NOT NULL
        UNION ALL
        SELECT 'PoolTrack',                site_id FROM pool_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'SwimTrack',                site_id FROM swim_sessions
          WHERE client_id = ${clientId} AND session_date    BETWEEN ${from} AND ${to}
            AND site_id IS NOT NULL
        UNION ALL
        SELECT 'PATtrack', a.site_id
          FROM pat_tests t
          JOIN pat_appliances a ON a.id = t.appliance_id AND a.client_id = ${clientId}
          WHERE t.test_date BETWEEN ${from} AND ${to}
            AND a.site_id IS NOT NULL
      ) sub
      ${moduleWhereClause}
      GROUP BY module, site_id
      ORDER BY module, site_id
    `),
  ]);

  const allSites = sitesRes.rows as { id: number; name: string }[];
  const sites    = siteId ? allSites.filter(s => s.id === siteId) : allSites;
  const siteMap  = Object.fromEntries(allSites.map(s => [s.id, s.name]));

  const dailyChecklists = (dailyRes.rows as any[]).map(r => ({
    siteId:    Number(r.site_id),
    siteName:  r.site_name as string,
    type:      r.checklist_type as "am" | "pm",
    submitted: Number(r.submitted),
    expected:  totalDays,
    missed:    Math.max(0, totalDays - Number(r.submitted)),
    pct:       totalDays > 0 ? Math.round((Number(r.submitted) / totalDays) * 100) : 0,
  }));

  const moduleActivity = (moduleRes.rows as any[]).map(r => ({
    module:   r.module as string,
    siteId:   Number(r.site_id),
    siteName: siteMap[r.site_id] ?? `Site ${r.site_id}`,
    count:    Number(r.records),
  }));

  return res.json({ from, to, totalDays, sites, dailyChecklists, moduleActivity });
});

// ─── GET /reports/compliance-trend ──────────────────────────────────────────

router.get("/reports/compliance-trend", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = trendSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid params" });

  const { months, siteId, departmentId } = parsed.data;

  // Compute the from/to range: from = first day of (months) months ago, to = yesterday
  const now   = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); // yesterday
  // Start from the beginning of `months` months ago
  const fromDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);

  const from = fromDate.toISOString().slice(0, 10);
  const to   = toDate.toISOString().slice(0, 10);

  const siteFilter = siteId && departmentId
    ? sql`AND dc.site_id = ${siteId} AND dc.site_id IN (SELECT id FROM sites WHERE department_id = ${departmentId})`
    : siteId
      ? sql`AND dc.site_id = ${siteId}`
      : departmentId
        ? sql`AND dc.site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND department_id = ${departmentId})`
        : sql``;

  const sitesFilter = departmentId
    ? sql`WHERE client_id = ${clientId} AND department_id = ${departmentId}`
    : sql`WHERE client_id = ${clientId}`;

  const [sitesRes, trendRes] = await Promise.all([
    db.execute(sql`
      SELECT id, name FROM sites
      ${sitesFilter}
      ${siteId ? sql`AND id = ${siteId}` : sql``}
      ORDER BY name
    `),

    db.execute(sql`
      SELECT
        to_char(dc.check_date, 'YYYY-MM') AS month,
        s.id                              AS site_id,
        s.name                            AS site_name,
        dc.checklist_type,
        COUNT(DISTINCT dc.check_date)::int AS submitted
      FROM daily_checklists dc
      JOIN sites s ON s.id = dc.site_id AND s.client_id = ${clientId}
      WHERE dc.client_id   = ${clientId}
        AND dc.check_date  BETWEEN ${from} AND ${to}
        AND dc.submitted_at IS NOT NULL
        ${siteFilter}
      GROUP BY month, s.id, s.name, dc.checklist_type
      ORDER BY month, s.name, dc.checklist_type
    `),
  ]);

  const allSites = sitesRes.rows as { id: number; name: string }[];

  // Build the ordered list of YYYY-MM strings for the range
  const monthLabels: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - months + 1 + i, 1);
    monthLabels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  // Days per month (approximate from calendar)
  function daysInMonth(ym: string): number {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y!, m!, 0).getDate();
  }

  // Index raw rows by site+month+type
  type RawRow = { month: string; site_id: number | string; site_name: string; checklist_type: string; submitted: number | string };
  const idx = new Map<string, number>();
  for (const r of trendRes.rows as RawRow[]) {
    idx.set(`${r.site_id}:${r.month}:${r.checklist_type}`, Number(r.submitted));
  }

  // Build series — one per site
  const series = allSites.map(site => {
    const data = monthLabels.map(month => {
      const days   = daysInMonth(month);
      const amSub  = idx.get(`${site.id}:${month}:am`) ?? 0;
      const pmSub  = idx.get(`${site.id}:${month}:pm`) ?? 0;
      return {
        month,
        daysInMonth: days,
        amSubmitted: amSub,
        pmSubmitted: pmSub,
        amPct: days > 0 ? Math.round((amSub / days) * 100) : 0,
        pmPct: days > 0 ? Math.round((pmSub / days) * 100) : 0,
        combinedPct: days > 0 ? Math.round(((amSub + pmSub) / (days * 2)) * 100) : 0,
      };
    });
    return { siteId: site.id, siteName: site.name, data };
  });

  return res.json({ from, to, months: monthLabels, sites: allSites, series });
});

export default router;
