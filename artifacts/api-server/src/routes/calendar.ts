import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { getEntitledServices, isEntitled } from "../lib/services";
import { ukToday } from "../lib/riddor";
import { actionStateLabel, itemActionStates } from "../lib/certificateOutcomes";
import { inclusiveDays, isCalendarDate, resolveSiteAccessScope, siteScopeSql } from "../lib/siteAccessScope";

/**
 * Read-only calendar of what falls due: compliance check due dates, scheduled
 * contractor visits, contractor insurance/DBS/accreditation expiries, FixTrack
 * contractor target dates, PestTrack next visits, training expiries, COSHH
 * assessment reviews and asbestos management plan reviews. Each
 * entry links to its record page. Dates are calendar days (no times).
 */
const router = Router();

/** A month view with leading/trailing weeks needs 42 days; allow a quarter. */
const MAX_RANGE_DAYS = 93;
const MAX_ENTRIES = 1000;

export type CalendarKind =
  | "compliance_due" | "contractor_visit" | "contractor_insurance" | "contractor_indemnity"
  | "contractor_dbs" | "contractor_accreditation" | "fix_visit" | "pest_visit" | "training_expiry"
  | "coshh_review" | "asbestos_plan_review";

export type CalendarEntry = {
  id: string;
  date: string;
  kind: CalendarKind;
  title: string;
  detail: string | null;
  siteName: string | null;
  href: string;
  status: "overdue" | "due" | "done";
};

const dateOnly = z.string().refine(isCalendarDate, "Dates must be real calendar dates (YYYY-MM-DD)");
const querySchema = z.object({
  from: dateOnly,
  to: dateOnly,
  siteId: z.coerce.number().int().positive().optional(),
});

type Row = Record<string, any>;
const rowsOf = async (query: SQL) => (await db.execute(query)).rows as Row[];

router.get("/calendar", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid params" });
  const { from, to, siteId } = parsed.data;
  if (from > to) return res.status(400).json({ error: "The start date must not be after the end date" });
  if (inclusiveDays(from, to) > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `Choose a range of ${MAX_RANGE_DAYS} days or less` });
  }

  const scope = await resolveSiteAccessScope(req, res, clientId, siteId);
  if (!scope) return;
  const services = await getEntitledServices(clientId);
  const today = ukToday();
  const state = (date: string, done: boolean): CalendarEntry["status"] =>
    done ? "done" : date < today ? "overdue" : "due";

  const [items, visits, contractors, accreditations, fixIssues, pestVisits, training, coshh, asbestos] = await Promise.all([
    rowsOf(sql`
      SELECT ci.id, ci.title, ci.status, to_char(ci.due_date, 'YYYY-MM-DD') AS date,
             s.name AS site_name, c.name AS contractor_name, cat.name AS category
      FROM compliance_items ci
      LEFT JOIN sites s ON s.id = ci.site_id AND s.client_id = ci.client_id
      LEFT JOIN contractors c ON c.id = ci.contractor_id AND c.client_id = ci.client_id
      LEFT JOIN categories cat ON cat.id = ci.category_id
      WHERE ci.client_id = ${clientId} AND ci.due_date::date BETWEEN ${from} AND ${to}
        AND ${siteScopeSql(scope, sql`ci.site_id`)}
    `),
    rowsOf(sql`
      SELECT ci.id, ci.title, ci.status, to_char(ci.visit_scheduled_at, 'YYYY-MM-DD') AS date,
             s.name AS site_name, c.name AS contractor_name
      FROM compliance_items ci
      LEFT JOIN sites s ON s.id = ci.site_id AND s.client_id = ci.client_id
      LEFT JOIN contractors c ON c.id = ci.contractor_id AND c.client_id = ci.client_id
      WHERE ci.client_id = ${clientId} AND ci.visit_scheduled_at::date BETWEEN ${from} AND ${to}
        AND ${siteScopeSql(scope, sql`ci.site_id`)}
    `),
    // Contractors work across the business, so they appear for every site.
    rowsOf(sql`
      SELECT id, name, company, dbs_type,
             to_char(public_liability_expiry, 'YYYY-MM-DD') AS insurance,
             to_char(professional_indemnity_expiry, 'YYYY-MM-DD') AS indemnity,
             to_char(COALESCE(dbs_expiry_date, dbs_check_date + interval '3 years'), 'YYYY-MM-DD') AS dbs
      FROM contractors
      WHERE client_id = ${clientId}
        AND (public_liability_expiry::date BETWEEN ${from} AND ${to}
          OR professional_indemnity_expiry::date BETWEEN ${from} AND ${to}
          OR (COALESCE(dbs_type, '') <> 'None'
              AND COALESCE(dbs_expiry_date, dbs_check_date + interval '3 years')::date BETWEEN ${from} AND ${to}))
    `),
    rowsOf(sql`
      SELECT cc.id, cc.contractor_id, cc.certificate_name, c.name AS contractor_name,
             to_char(cc.expiry_date, 'YYYY-MM-DD') AS date
      FROM contractor_certificates cc
      JOIN contractors c ON c.id = cc.contractor_id AND c.client_id = cc.client_id
      WHERE cc.client_id = ${clientId} AND cc.expiry_date::date BETWEEN ${from} AND ${to}
    `),
    isEntitled(services, "fixtrack") ? rowsOf(sql`
      SELECT f.id, f.title, f.status, f.target_date::text AS date, s.name AS site_name,
             c.name AS contractor_name
      FROM fix_track_issues f
      JOIN contractors c ON c.id = f.contractor_id AND c.client_id = f.client_id
      LEFT JOIN sites s ON s.id = f.site_id AND s.client_id = f.client_id
      WHERE f.client_id = ${clientId} AND f.target_date BETWEEN ${from} AND ${to}
        AND ${siteScopeSql(scope, sql`f.site_id`)}
    `) : [],
    // A visit recorded on or after the planned date (same site) completes it.
    isEntitled(services, "pesttrack") ? rowsOf(sql`
      SELECT p.id, p.next_visit_date::text AS date, p.contractor_company, p.contractor_name,
             s.name AS site_name,
             EXISTS (
               SELECT 1 FROM pest_visits later
               WHERE later.client_id = p.client_id AND later.id <> p.id
                 AND later.site_id IS NOT DISTINCT FROM p.site_id
                 AND later.visit_date >= p.next_visit_date
             ) AS done
      FROM pest_visits p
      LEFT JOIN sites s ON s.id = p.site_id AND s.client_id = p.client_id
      WHERE p.client_id = ${clientId} AND p.next_visit_date BETWEEN ${from} AND ${to}
        AND ${siteScopeSql(scope, sql`p.site_id`)}
    `) : [],
    // Renewed training (a newer record of the same course) is not shown.
    isEntitled(services, "traintrack") ? rowsOf(sql`
      SELECT r.id, r.staff_name, COALESCE(r.training_type, r.document_title, 'Training') AS training,
             r.expiry_date::text AS date, s.name AS site_name
      FROM train_track_records r
      LEFT JOIN sites s ON s.id = r.site_id AND s.client_id = r.client_id
      WHERE r.client_id = ${clientId} AND r.expiry_date BETWEEN ${from} AND ${to}
        AND ${siteScopeSql(scope, sql`r.site_id`)}
        AND NOT EXISTS (
          SELECT 1 FROM train_track_records newer
          WHERE newer.client_id = r.client_id AND newer.id <> r.id
            AND COALESCE(newer.training_type, newer.document_title, '') = COALESCE(r.training_type, r.document_title, '')
            AND (CASE WHEN r.staff_roster_id IS NOT NULL THEN newer.staff_roster_id = r.staff_roster_id
                      ELSE lower(newer.staff_name) = lower(r.staff_name) END)
            AND (newer.completed_date > r.completed_date
                 OR (newer.completed_date = r.completed_date AND newer.id > r.id))
        )
    `) : [],
    // Core registers: reviews of substances still in use, and asbestos
    // management plans (none when no asbestos is expected).
    rowsOf(sql`
      SELECT cs.id, cs.product_name, cs.review_due::text AS date, s.name AS site_name
      FROM coshh_substances cs
      LEFT JOIN sites s ON s.id = cs.site_id AND s.client_id = cs.client_id
      WHERE cs.client_id = ${clientId} AND cs.deleted_at IS NULL AND cs.status = 'in_use'
        AND cs.review_due BETWEEN ${from} AND ${to}
        AND ${siteScopeSql(scope, sql`cs.site_id`)}
    `),
    rowsOf(sql`
      SELECT a.id, a.plan_review_due::text AS date, s.name AS site_name
      FROM asbestos_records a
      LEFT JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
      WHERE a.client_id = ${clientId} AND a.deleted_at IS NULL AND a.no_asbestos_expected = false
        AND a.plan_review_due BETWEEN ${from} AND ${to}
        AND ${siteScopeSql(scope, sql`a.site_id`)}
    `),
  ]);

  // An unsatisfactory newest certificate or open remedial defects show the
  // check as needing action (red) whatever its date.
  const actionStates = await itemActionStates(clientId, items.map((row) => Number(row.id)));
  const entries: CalendarEntry[] = [];
  for (const row of items) {
    const action = actionStates.get(Number(row.id));
    entries.push({
      id: `compliance-${row.id}`, date: row.date, kind: "compliance_due", title: row.title,
      detail: [action?.needsAction ? actionStateLabel(action) : null, row.category, row.contractor_name].filter(Boolean).join(" · ") || null,
      siteName: row.site_name ?? null, href: `/items/${row.id}`,
      status: action?.needsAction ? "overdue" : state(row.date, row.status === "completed"),
    });
  }
  for (const row of visits) {
    entries.push({
      id: `visit-${row.id}`, date: row.date, kind: "contractor_visit", title: `Contractor visit: ${row.title}`,
      detail: row.contractor_name ?? null, siteName: row.site_name ?? null, href: `/items/${row.id}`,
      status: state(row.date, row.status === "completed"),
    });
  }
  for (const row of contractors) {
    const name = [row.name, row.company].filter(Boolean).join(" — ");
    const add = (kind: CalendarKind, date: string | null, title: string) => {
      if (!date || date < from || date > to) return;
      entries.push({
        id: `${kind}-${row.id}`, date, kind, title, detail: name, siteName: null,
        href: `/contractors/${row.id}`, status: state(date, false),
      });
    };
    add("contractor_insurance", row.insurance, "Public liability insurance expires");
    add("contractor_indemnity", row.indemnity, "Professional indemnity expires");
    if (row.dbs_type !== "None") {
      add("contractor_dbs", row.dbs, row.dbs_type === "PVG Scheme" ? "PVG recheck due"
        : row.dbs_type ? `DBS (${row.dbs_type}) recheck due` : "DBS/PVG recheck due");
    }
  }
  for (const row of accreditations) {
    entries.push({
      id: `accreditation-${row.id}`, date: row.date, kind: "contractor_accreditation",
      title: `${row.certificate_name} expires`, detail: row.contractor_name, siteName: null,
      href: `/contractors/${row.contractor_id}`, status: state(row.date, false),
    });
  }
  for (const row of fixIssues) {
    entries.push({
      id: `fix-${row.id}`, date: row.date, kind: "fix_visit", title: `Contractor target: ${row.title}`,
      detail: row.contractor_name, siteName: row.site_name ?? null, href: `/fix-track/${row.id}`,
      status: state(row.date, row.status === "resolved" || row.status === "closed"),
    });
  }
  for (const row of pestVisits) {
    entries.push({
      id: `pest-${row.id}`, date: row.date, kind: "pest_visit", title: "Pest control visit due",
      detail: [row.contractor_company, row.contractor_name].filter(Boolean).join(" — ") || null,
      siteName: row.site_name ?? null, href: "/pest-track",
      status: state(row.date, row.done === true || row.done === "t"),
    });
  }
  for (const row of training) {
    entries.push({
      id: `training-${row.id}`, date: row.date, kind: "training_expiry", title: `${row.training} expires`,
      detail: row.staff_name, siteName: row.site_name ?? null, href: "/train-track",
      status: state(row.date, false),
    });
  }

  for (const row of coshh) {
    entries.push({
      id: `coshh-${row.id}`, date: row.date, kind: "coshh_review", title: `COSHH assessment review: ${row.product_name}`,
      detail: null, siteName: row.site_name ?? null, href: "/coshh", status: state(row.date, false),
    });
  }
  for (const row of asbestos) {
    entries.push({
      id: `asbestos-${row.id}`, date: row.date, kind: "asbestos_plan_review", title: "Asbestos management plan review",
      detail: null, siteName: row.site_name ?? null, href: "/asbestos", status: state(row.date, false),
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
  res.json({
    from, to, today,
    siteId: scope.siteId,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
  });
});

export default router;
