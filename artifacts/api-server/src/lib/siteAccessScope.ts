import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { getActiveDepartmentId } from "../middleware/requireAuth";

export type ScopedSite = { id: number; name: string };

/**
 * The sites one request may read, resolved from the authenticated tenant and
 * the user's department (never from client-supplied ids). Matches GET /sites:
 * department-restricted staff and viewers see their department's sites and
 * sites without a department; admins and consultants see every site.
 */
export type SiteAccessScope = {
  clientId: number;
  /** null = unrestricted (client admin / consultant). */
  departmentId: number | null;
  /** The selected site, or null for every site in scope. */
  siteId: number | null;
  /** Sites in scope: the selected one, or all accessible sites. */
  sites: ScopedSite[];
};

/**
 * Resolve an optional ?siteId= against the tenant and department. Sends the
 * error response and returns null when the site is unknown (400) or outside
 * the user's department (403).
 */
export async function resolveSiteAccessScope(
  req: Request,
  res: Response,
  clientId: number,
  requestedSiteId: number | undefined,
): Promise<SiteAccessScope | null> {
  const departmentId = getActiveDepartmentId(req);
  const result = await db.execute(sql`
    SELECT id, name, department_id FROM sites
    WHERE client_id = ${clientId}
    ORDER BY name, id
  `);
  const all = (result.rows as Array<{ id: number; name: string; department_id: number | null }>).map(row => ({
    id: Number(row.id),
    name: row.name,
    departmentId: row.department_id === null ? null : Number(row.department_id),
  }));
  const accessible = all.filter(site =>
    departmentId === null || site.departmentId === null || site.departmentId === departmentId);

  if (requestedSiteId !== undefined) {
    if (!all.some(site => site.id === requestedSiteId)) {
      res.status(400).json({ error: "Site not found" });
      return null;
    }
    const site = accessible.find(candidate => candidate.id === requestedSiteId);
    if (!site) {
      res.status(403).json({ error: "Site is outside your department" });
      return null;
    }
    return { clientId, departmentId, siteId: site.id, sites: [{ id: site.id, name: site.name }] };
  }
  return {
    clientId,
    departmentId,
    siteId: null,
    sites: accessible.map(site => ({ id: site.id, name: site.name })),
  };
}

/**
 * SQL predicate limiting a nullable site_id column to the scope. With a
 * selected site only that site's records match; otherwise records without a
 * site (organisation-wide) also match, as they do in the module lists.
 */
export function siteScopeSql(scope: SiteAccessScope, column: SQL): SQL {
  if (scope.siteId !== null) return sql`${column} = ${scope.siteId}`;
  if (scope.departmentId === null) return sql`true`;
  if (scope.sites.length === 0) return sql`${column} IS NULL`;
  return sql`(${column} IS NULL OR ${column} IN (${sql.join(scope.sites.map(site => sql`${site.id}`), sql`, `)}))`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real YYYY-MM-DD calendar date. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** Inclusive number of calendar days from `from` to `to` (date-only, DST-safe). */
export function inclusiveDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/** Add calendar days to a YYYY-MM-DD date. */
export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Add calendar months to a YYYY-MM-DD date (end-of-month clamped). */
export function addCalendarMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
