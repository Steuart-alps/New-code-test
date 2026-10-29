/**
 * COSHHTrack due dates, shared by its status route, the dashboard, the daily
 * 08:45 reminder email and the track owners' bell reminders.
 *
 * Something is due when:
 *  - a current COSHH assessment reaches its review date;
 *  - the latest check in a series reaches its next due date. A series is one
 *    check type at one site for one assessment and subject (the extraction
 *    system, the person, the area), so recording the next LEV examination of
 *    "Spray booth" replaces the previous one's due date;
 *  - an assessment says health surveillance or exposure monitoring is needed
 *    and none has been recorded against it yet ("missing").
 */
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import type { CoshhCheckType } from "@workspace/db/schema";
import { visibleSiteIdsSql } from "./departmentSites";

/** Due-soon window: reminders start this many days before a due date. */
export const COSHH_DUE_SOON_DAYS = 30;

/** Suggested months to the next check when none is entered. */
export const COSHH_DEFAULT_INTERVAL_MONTHS: Record<CoshhCheckType, number> = {
  // COSHH regulation 9 allows up to 14 months between thorough examinations;
  // a yearly contractor visit is the usual practice.
  lev_examination: 12,
  health_surveillance: 12,
  exposure_monitoring: 12,
  staff_briefing: 12,
};

export const COSHH_CHECK_LABELS: Record<CoshhCheckType, string> = {
  lev_examination: "LEV thorough examination",
  health_surveillance: "Health check",
  exposure_monitoring: "Exposure monitoring",
  staff_briefing: "Staff briefing",
};

/** Default review interval for a COSHH assessment. */
export const COSHH_ASSESSMENT_REVIEW_MONTHS = 12;

export type CoshhDueKind = "assessment_review" | CoshhCheckType;

export interface CoshhDueItem {
  kind: CoshhDueKind;
  /** The assessment (assessment_review and missing items) or check id. */
  recordId: number;
  assessmentId: number | null;
  label: string;
  siteId: number | null;
  siteName: string | null;
  dueDate: string | null;
  /** Negative = overdue by N days; 0 = due today; null for missing items. */
  daysUntilDue: number | null;
  status: "overdue" | "due_soon" | "ok" | "missing";
}

export interface CoshhScope {
  siteId?: number | null;
  /** Sites the caller may see (null = all); records with no site stay visible. */
  accessibleSiteIds?: number[] | null;
  /** Alternatively, the caller's active department (getActiveDepartmentId). */
  departmentId?: number | null;
}

const MS_DAY = 86_400_000;
const toUtcDays = (iso: string) => Math.floor(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / MS_DAY);
const isoDay = (value: unknown) => (value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10));

/** YYYY-MM-DD plus whole calendar months, clamped to the end of the month. */
export function addMonthsIso(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date, lastDay));
  return first.toISOString().slice(0, 10);
}

function scopeClause(alias: string, clientId: number, scope: CoshhScope): SQL {
  const column = sql.raw(`${alias}.site_id`);
  if (scope.siteId != null) return sql`AND ${column} = ${scope.siteId}`;
  if (scope.accessibleSiteIds != null) {
    return scope.accessibleSiteIds.length
      ? sql`AND (${column} IS NULL OR ${column} IN (${sql.join(scope.accessibleSiteIds.map((id) => sql`${id}`), sql`, `)}))`
      : sql`AND ${column} IS NULL`;
  }
  if (scope.departmentId != null) {
    return sql`AND (${column} IS NULL OR ${column} IN (${visibleSiteIdsSql(clientId, scope.departmentId)}))`;
  }
  return sql``;
}

function dueStatus(dueDate: string, todayDays: number): Pick<CoshhDueItem, "daysUntilDue" | "status"> {
  const daysUntilDue = toUtcDays(dueDate) - todayDays;
  return {
    daysUntilDue,
    status: daysUntilDue < 0 ? "overdue" : daysUntilDue <= COSHH_DUE_SOON_DAYS ? "due_soon" : "ok",
  };
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

/** Every COSHHTrack due date the scope can see, soonest first. */
export async function getCoshhDueItems(clientId: number, scope: CoshhScope, today: string): Promise<CoshhDueItem[]> {
  const todayDays = toUtcDays(today);
  const assessments = rowsOf<{
    id: number; task: string; review_due: unknown; site_id: number | null; site_name: string | null;
    product_name: string | null; health_surveillance_required: boolean; monitoring_required: boolean;
    has_surveillance: boolean; has_monitoring: boolean;
  }>(await db.execute(sql`
    SELECT a.id, a.task, a.review_due, a.site_id, s.name AS site_name, sub.product_name,
           a.health_surveillance_required, a.monitoring_required,
           EXISTS (SELECT 1 FROM coshh_checks c WHERE c.client_id = a.client_id AND c.assessment_id = a.id
             AND c.check_type = 'health_surveillance' AND c.deleted_at IS NULL) AS has_surveillance,
           EXISTS (SELECT 1 FROM coshh_checks c WHERE c.client_id = a.client_id AND c.assessment_id = a.id
             AND c.check_type = 'exposure_monitoring' AND c.deleted_at IS NULL) AS has_monitoring
    FROM coshh_assessments a
    LEFT JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
    LEFT JOIN coshh_substances sub ON sub.id = a.substance_id AND sub.client_id = a.client_id
    WHERE a.client_id = ${clientId} AND a.deleted_at IS NULL AND a.status = 'current'
      ${scopeClause("a", clientId, scope)}
  `));
  const checks = rowsOf<{
    id: number; check_type: CoshhCheckType; subject: string | null; next_due_date: unknown;
    site_id: number | null; site_name: string | null; assessment_id: number | null;
  }>(await db.execute(sql`
    SELECT latest.*, s.name AS site_name FROM (
      SELECT DISTINCT ON (c.site_id, c.check_type, COALESCE(c.assessment_id, 0), lower(btrim(COALESCE(c.subject, ''))))
             c.id, c.check_type, c.subject, c.next_due_date, c.site_id, c.assessment_id, c.client_id
      FROM coshh_checks c
      LEFT JOIN coshh_assessments a ON a.id = c.assessment_id AND a.client_id = c.client_id
      WHERE c.client_id = ${clientId} AND c.deleted_at IS NULL
        -- Checks for an archived or removed assessment are no longer chased.
        AND (c.assessment_id IS NULL OR (a.deleted_at IS NULL AND a.status = 'current'))
        ${scopeClause("c", clientId, scope)}
      ORDER BY c.site_id, c.check_type, COALESCE(c.assessment_id, 0), lower(btrim(COALESCE(c.subject, ''))),
               c.check_date DESC, c.id DESC
    ) latest
    LEFT JOIN sites s ON s.id = latest.site_id AND s.client_id = latest.client_id
    WHERE latest.next_due_date IS NOT NULL
  `));

  const items: CoshhDueItem[] = [];
  for (const row of assessments) {
    const what = row.product_name ? `${row.task} (${row.product_name})` : row.task;
    const base = {
      recordId: Number(row.id), assessmentId: Number(row.id),
      siteId: row.site_id == null ? null : Number(row.site_id), siteName: row.site_name ?? null,
    };
    const reviewDue = isoDay(row.review_due);
    if (reviewDue) {
      items.push({ ...base, kind: "assessment_review", label: `COSHH assessment review: ${what}`, dueDate: reviewDue, ...dueStatus(reviewDue, todayDays) });
    }
    if (row.health_surveillance_required && !row.has_surveillance) {
      items.push({ ...base, kind: "health_surveillance", label: `Health checks needed, none recorded: ${what}`, dueDate: null, daysUntilDue: null, status: "missing" });
    }
    if (row.monitoring_required && !row.has_monitoring) {
      items.push({ ...base, kind: "exposure_monitoring", label: `Exposure monitoring needed, none recorded: ${what}`, dueDate: null, daysUntilDue: null, status: "missing" });
    }
  }
  for (const row of checks) {
    const dueDate = isoDay(row.next_due_date)!;
    const label = COSHH_CHECK_LABELS[row.check_type] ?? row.check_type;
    items.push({
      kind: row.check_type, recordId: Number(row.id),
      assessmentId: row.assessment_id == null ? null : Number(row.assessment_id),
      label: row.subject ? `${label}: ${row.subject}` : label,
      siteId: row.site_id == null ? null : Number(row.site_id), siteName: row.site_name ?? null,
      dueDate, ...dueStatus(dueDate, todayDays),
    });
  }
  const rank = (item: CoshhDueItem) => (item.daysUntilDue ?? -100_000);
  return items.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}
