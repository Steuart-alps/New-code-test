import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { z } from "zod";
import { getUnscopedComplianceReport } from "../lib/unscopedComplianceReport";

const router = Router();
type RiskAcknowledgementStatus = "acknowledged" | "pending" | "expired" | "missing";

// ─── Shared schemas ───────────────────────────────────────────────────────────

// Report filters represent local calendar days (the value emitted by an HTML
// date input), not UTC instants. Keep them as DATE-compatible strings so both
// ends of an inclusive range have the expected UK calendar-day semantics.
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD").refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}, "Date must be a valid calendar date");

const complianceSchema = z.object({
  from:         dateOnly,
  to:           dateOnly,
  siteId:       z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});

const trendSchema = z.object({
  months:       z.coerce.number().int().min(2).max(24).default(6),
  siteId:       z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});

const riskAcknowledgementsSchema = z.object({
  siteId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});

type ReportScope = {
  siteId?: number;
  departmentId?: number;
  departmentName: string | null;
};

/**
 * Reports accept ids from the URL, so resolve them against the authenticated
 * tenant before using them in any query.  A department-scoped user's
 * department remains authoritative, and a selected site must belong to the
 * resulting department rather than merely be a valid site in the tenant.
 */
async function resolveReportScope(
  req: Request,
  res: Response,
  clientId: number,
  requestedSiteId: number | undefined,
  requestedDepartmentId: number | undefined,
): Promise<ReportScope | null> {
  const activeDepartmentId = getActiveDepartmentId(req);
  if (
    activeDepartmentId !== null
    && requestedDepartmentId !== undefined
    && requestedDepartmentId !== activeDepartmentId
  ) {
    res.status(403).json({ error: "Department scope cannot be changed" });
    return null;
  }

  const departmentId = activeDepartmentId ?? requestedDepartmentId;
  let departmentName: string | null = null;
  // -1 is the deliberate no-department sentinel returned for an unassigned
  // staff/viewer account. It is not a department row, but must still produce
  // an empty staff scope rather than widening the report to the whole tenant.
  if (departmentId === -1) {
    departmentName = "__unassigned_department_scope__";
  } else if (departmentId !== undefined) {
    const departmentResult = await db.execute(sql`
      SELECT name FROM departments
      WHERE id = ${departmentId} AND client_id = ${clientId}
      LIMIT 1
    `);
    const department = (departmentResult.rows ?? [])[0] as { name: string } | undefined;
    if (!department) {
      res.status(400).json({ error: "Department not found" });
      return null;
    }
    departmentName = department.name;
  }

  if (requestedSiteId !== undefined) {
    const siteResult = await db.execute(sql`
      SELECT department_id FROM sites
      WHERE id = ${requestedSiteId} AND client_id = ${clientId}
      LIMIT 1
    `);
    const site = (siteResult.rows ?? [])[0] as { department_id: number | null } | undefined;
    if (!site) {
      res.status(400).json({ error: "Site not found" });
      return null;
    }
    if (departmentId !== undefined && Number(site.department_id) !== departmentId) {
      res.status(403).json({ error: "Site is outside the selected department scope" });
      return null;
    }
  }

  return { siteId: requestedSiteId, departmentId, departmentName };
}

// ─── GET /reports/risk-acknowledgements ──────────────────────────────────────

router.get("/reports/risk-acknowledgements", requireAuth, async (req, res) => {
  // Do not accept a tenant identifier in this report's payload. getClientId is
  // the single source of the tenant context (including consultant access).
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = riskAcknowledgementsSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid params" });
  }

  const scope = await resolveReportScope(req, res, clientId, parsed.data.siteId, parsed.data.departmentId);
  if (!scope) return;
  const { siteId, departmentId: effectiveDepartmentId, departmentName } = scope;

  const staffWhere = sql`
    sr.client_id = ${clientId}
    AND sr.active = true
    ${siteId !== undefined ? sql`AND sr.site_id = ${siteId}` : sql``}
    ${departmentName !== null ? sql`AND sr.department = ${departmentName}` : sql``}
  `;

  const documentScope = sql`
    d.client_id = ${clientId}
    AND d.category = 'risk_assessment'
    AND d.requires_acknowledgement = true
    ${siteId !== undefined ? sql`AND (d.site_id IS NULL OR d.site_id = ${siteId})` : sql``}
    ${departmentName !== null ? sql`AND (d.department IS NULL OR d.department = ${departmentName})` : sql``}
    ${effectiveDepartmentId !== undefined ? sql`
      AND (
        d.site_id IS NULL
        OR EXISTS (
          SELECT 1 FROM sites scoped_site
          WHERE scoped_site.id = d.site_id
            AND scoped_site.client_id = ${clientId}
            AND scoped_site.department_id = ${effectiveDepartmentId}
        )
      )
    ` : sql``}
  `;

  const [staffResult, documentResult, matrixResult] = await Promise.all([
    db.execute(sql`
      SELECT sr.id, sr.name, sr.job_title, sr.department, sr.site_id, s.name AS site_name
      FROM staff_roster sr
      LEFT JOIN sites s ON s.id = sr.site_id AND s.client_id = ${clientId}
      WHERE ${staffWhere}
      ORDER BY sr.name ASC, sr.id ASC
    `),
    db.execute(sql`
      SELECT
        d.id, d.title, d.category, d.site_id, s.name AS site_name,
        d.department, d.requires_acknowledgement, d.annual_acknowledgement,
        d.created_at, d.updated_at
      FROM doc_track_documents d
      LEFT JOIN sites s ON s.id = d.site_id AND s.client_id = ${clientId}
      WHERE ${documentScope}
      ORDER BY d.title ASC, d.id ASC
    `),
    db.execute(sql`
      SELECT
        sr.id AS staff_id,
        d.id AS document_id,
        d.title AS document_title,
        d.category AS document_category,
        d.site_id AS document_site_id,
        ds.name AS document_site_name,
        d.department AS document_department,
        d.requires_acknowledgement,
        d.annual_acknowledgement,
        d.created_at AS document_created_at,
        d.updated_at AS document_updated_at,
        ack.acknowledged_at,
        ack.signature,
        acknowledged_by.name AS acknowledged_by_name,
        training.expiry_date,
        CASE
          WHEN ack.id IS NULL THEN 'missing'
          WHEN ack.train_track_record_id IS NOT NULL AND training.id IS NULL THEN 'pending'
          WHEN training.expiry_date IS NOT NULL AND training.expiry_date < CURRENT_DATE THEN 'expired'
          ELSE 'acknowledged'
        END AS acknowledgement_status
      FROM staff_roster sr
      JOIN doc_track_documents d
        ON d.client_id = sr.client_id
       AND d.category = 'risk_assessment'
       AND d.requires_acknowledgement = true
       AND (d.site_id IS NULL OR d.site_id = sr.site_id)
       AND (d.department IS NULL OR d.department = sr.department)
      LEFT JOIN sites ds ON ds.id = d.site_id AND ds.client_id = ${clientId}
      LEFT JOIN LATERAL (
        SELECT a.id, a.acknowledged_at, a.signature, a.acknowledged_by, a.train_track_record_id
        FROM doc_acknowledgements a
        WHERE a.document_id = d.id
          AND a.staff_roster_id = sr.id
          AND a.client_id = ${clientId}
        ORDER BY a.acknowledged_at DESC, a.id DESC
        LIMIT 1
      ) ack ON true
      LEFT JOIN train_track_records training
        ON training.id = ack.train_track_record_id
       AND training.client_id = ${clientId}
      LEFT JOIN users acknowledged_by
        ON acknowledged_by.id = ack.acknowledged_by
       AND acknowledged_by.client_id = ${clientId}
      WHERE ${staffWhere}
      ORDER BY d.title ASC, d.id ASC, sr.name ASC, sr.id ASC
    `),
  ]);

  const documents = (documentResult.rows as any[]).map((row) => ({
    id: Number(row.id),
    title: row.title,
    category: row.category,
    siteId: row.site_id === null ? null : Number(row.site_id),
    siteName: row.site_name ?? null,
    department: row.department ?? null,
    requiresAcknowledgement: Boolean(row.requires_acknowledgement),
    annualAcknowledgement: Boolean(row.annual_acknowledgement),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const cellsByStaff = new Map<number, any[]>();
  for (const row of matrixResult.rows as any[]) {
    const documentId = Number(row.document_id);
    const staffId = Number(row.staff_id);
    const cells = cellsByStaff.get(staffId) ?? [];
    cells.push({
      documentId,
      status: row.acknowledgement_status as "acknowledged" | "pending" | "expired" | "missing",
      acknowledgedAt: row.acknowledged_at ?? null,
      signature: row.signature ?? null,
      acknowledgedByName: row.acknowledged_by_name ?? null,
      expiryDate: row.expiry_date ?? null,
    });
    cellsByStaff.set(staffId, cells);
  }

  const summaryCounts = { relevant: 0, acknowledged: 0, pending: 0, expired: 0, missing: 0 };
  const staff = (staffResult.rows as any[]).map((row) => {
    const cells = cellsByStaff.get(Number(row.id)) ?? [];
    const totals = { relevant: cells.length, acknowledged: 0, pending: 0, expired: 0, missing: 0 };
    for (const cell of cells) {
      const status = cell.status as RiskAcknowledgementStatus;
      totals[status]++;
      summaryCounts[status]++;
      summaryCounts.relevant++;
    }
    return {
      id: Number(row.id),
      name: row.name,
      jobTitle: row.job_title ?? null,
      department: row.department ?? null,
      siteId: row.site_id === null ? null : Number(row.site_id),
      siteName: row.site_name ?? null,
      cells,
      totals,
    };
  });

  const completionPct = summaryCounts.relevant > 0
    ? Math.round((summaryCounts.acknowledged / summaryCounts.relevant) * 1000) / 10
    : 0;

  return res.json({
    generatedAt: new Date().toISOString(),
    scope: {
      siteId: siteId ?? null,
      departmentId: effectiveDepartmentId ?? null,
      departmentName,
    },
    documents,
    staff,
    summary: {
      staffTotal: staff.length,
      documentTotal: documents.length,
      relevantTotal: summaryCounts.relevant,
      acknowledged: summaryCounts.acknowledged,
      pending: summaryCounts.pending,
      expired: summaryCounts.expired,
      missing: summaryCounts.missing,
      completionPct,
    },
  });
});

// ─── GET /reports/compliance ─────────────────────────────────────────────────

router.get("/reports/compliance", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = complianceSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid params" });

  const { from, to } = parsed.data;

  if (from > to) return res.status(400).json({ error: "'from' must not be after 'to'" });

  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  const totalDays = Math.floor(
    (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000,
  ) + 1;
  if (totalDays > 366) return res.status(400).json({ error: "Date range cannot exceed 366 days" });

  const scope = await resolveReportScope(req, res, clientId, parsed.data.siteId, parsed.data.departmentId);
  if (!scope) return;
  const { siteId, departmentId } = scope;

  if (siteId === undefined && departmentId === undefined) {
    return res.json(await getUnscopedComplianceReport(clientId, from, to));
  }

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

  const { months } = parsed.data;

  // Compute the from/to range: from = first day of (months) months ago, to = yesterday
  const now   = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1); // yesterday
  // Start from the beginning of `months` months ago
  const fromDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);

  const from = fromDate.toISOString().slice(0, 10);
  const to   = toDate.toISOString().slice(0, 10);

  const scope = await resolveReportScope(req, res, clientId, parsed.data.siteId, parsed.data.departmentId);
  if (!scope) return;
  const { siteId, departmentId } = scope;

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
