import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { z } from "zod";

const router = Router();

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  siteId: z.coerce.number().int().positive().optional(),
});

router.get("/reports/compliance", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid params" });

  const { from, to, siteId } = parsed.data;

  if (from > to) return res.status(400).json({ error: "'from' must not be after 'to'" });

  const fromDate = new Date(from);
  const toDate   = new Date(to);
  const totalDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;

  if (totalDays > 366) return res.status(400).json({ error: "Date range cannot exceed 366 days" });

  const siteWhere     = siteId ? sql`AND s.id = ${siteId}`     : sql``;
  const moduleWhere   = siteId ? sql`WHERE site_id = ${siteId}` : sql``;

  const [sitesRes, dailyRes, moduleRes] = await Promise.all([

    // ── All sites for this client ──────────────────────────────────────────────
    db.execute(sql`
      SELECT id, name FROM sites
      WHERE client_id = ${clientId}
      ORDER BY name
    `),

    // ── Daily checklists AM & PM — submitted vs expected (1 per day) ──────────
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
      ${siteWhere}
      GROUP BY s.id, s.name, t.checklist_type
      ORDER BY s.name, t.checklist_type
    `),

    // ── Module activity — record counts per module per site ────────────────────
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
      ${moduleWhere}
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

export default router;
