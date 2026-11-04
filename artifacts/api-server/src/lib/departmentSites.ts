import { db } from "@workspace/db";
import { sitesTable } from "@workspace/db/schema";
import { sql, type SQL } from "drizzle-orm";

// Department scoping by site. A site with a department_id belongs to that
// department alone; one without is shared. A department can also sit under a
// site (departments.site_id), and then its people see only that site. The
// rule, for an active department D (getActiveDepartmentId):
//
//   site visible = (site.department_id IS NULL OR site.department_id = D)
//                  AND (D has no site OR site.id = D's site)
//
// Every department check on a site goes through these helpers so the two
// halves stay together.

/** D's site, as SQL (NULL when D spans every site or does not exist). */
export function departmentSiteIdSql(departmentId: number | SQL): SQL {
  return sql`(SELECT dsite.site_id FROM departments dsite WHERE dsite.id = ${departmentId})`;
}

/**
 * Boolean SQL: the site whose id and department_id columns are given is visible
 * to department `departmentId`. Pass raw column references, e.g.
 * siteVisibleSql(sql`s.id`, sql`s.department_id`, deptId). The department can
 * also be a column, e.g. sql`d.department_id`.
 */
export function siteVisibleSql(siteIdColumn: SQL, siteDepartmentColumn: SQL, departmentId: number | SQL): SQL {
  // The columns stay outside the departments subquery, so an unqualified
  // column name can't be read as the departments table's own id or site_id.
  return sql`((${siteDepartmentColumn} IS NULL OR ${siteDepartmentColumn} = ${departmentId})
    AND COALESCE(${departmentSiteIdSql(departmentId)}, ${siteIdColumn}) IS NOT DISTINCT FROM ${siteIdColumn})`;
}

/** siteVisibleSql for the unaliased Drizzle sites table. */
export function sitesTableVisibleTo(departmentId: number): SQL {
  return siteVisibleSql(sql`${sitesTable.id}`, sql`${sitesTable.departmentId}`, departmentId);
}

/** Subquery of the ids of every site in `clientId` visible to `departmentId`. */
export function visibleSiteIdsSql(clientId: number, departmentId: number): SQL {
  return sql`SELECT vs.id FROM sites vs WHERE vs.client_id = ${clientId}
    AND ${siteVisibleSql(sql`vs.id`, sql`vs.department_id`, departmentId)}`;
}

/**
 * Boolean SQL for a record scoped by its own department_id rather than its
 * site's: a record at a site belongs to a site-bound department's site only.
 * Site-neutral records (no site) stay visible, as before.
 */
export function recordSiteVisibleSql(recordSiteColumn: SQL, departmentId: number): SQL {
  return sql`(${recordSiteColumn} IS NULL OR COALESCE(${departmentSiteIdSql(departmentId)}, ${recordSiteColumn}) = ${recordSiteColumn})`;
}

/** D's site, or null when D spans every site. */
export async function departmentSiteId(departmentId: number | null): Promise<number | null> {
  if (departmentId === null || departmentId <= 0) return null;
  const result = await db.execute(sql`SELECT site_id FROM departments WHERE id = ${departmentId}`);
  const row = (result.rows ?? [])[0] as { site_id: number | null } | undefined;
  return row?.site_id ?? null;
}

/**
 * The JavaScript form of the rule for a site row already loaded. A null
 * departmentId (owners, consultants, every-department Managers) sees everything.
 */
export async function siteVisibleToDepartment(
  site: { id: number; departmentId: number | null },
  departmentId: number | null,
): Promise<boolean> {
  if (departmentId === null) return true;
  if (site.departmentId !== null && site.departmentId !== departmentId) return false;
  const bound = await departmentSiteId(departmentId);
  return bound === null || bound === site.id;
}
