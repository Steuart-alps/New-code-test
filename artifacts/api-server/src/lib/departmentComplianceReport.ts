import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

type Options = {
  clientId: number;
  from: string;
  to: string;
  totalDays: number;
  siteId?: number;
  departmentId: number;
  departmentName: string;
  restrictSitesToDepartment: boolean;
};

/** Attribute records to the department of the account that entered them.
 * NULL/removed authors cannot be assigned reliably and are excluded.
 * The site restriction for department-scoped staff remains in effect; managers
 * can see a team's work at any site in their tenant.
 */
export async function getDepartmentComplianceReport({
  clientId, from, to, totalDays, siteId, departmentId, departmentName,
  restrictSitesToDepartment,
}: Options) {
  const siteScope = sql`
    ${siteId !== undefined ? sql`AND s.id = ${siteId}` : sql``}
    ${restrictSitesToDepartment ? sql`AND s.department_id = ${departmentId}` : sql``}
  `;
  const [sitesRes, dailyRes, moduleRes] = await Promise.all([
    db.execute(sql`
      SELECT s.id, s.name FROM sites s
      WHERE s.client_id = ${clientId} ${siteScope}
      ORDER BY s.name, s.id
    `),
    db.execute(sql`
      SELECT s.id AS site_id, checklists.checklist_type,
             COUNT(DISTINCT checklists.check_date)::int AS submitted
      FROM (
        SELECT site_id, check_date::text AS check_date,
               CASE
                 WHEN checklist_type IN ('kitchen_opening', 'premises_opening') THEN 'am'
                 WHEN checklist_type IN ('kitchen_closing', 'premises_closing') THEN 'pm'
                 ELSE checklist_type
               END AS checklist_type,
               created_by AS author_id
        FROM daily_checklists
        WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
          AND submitted_at IS NOT NULL
        UNION ALL
        SELECT site_id, checklist_date, type, submitted_by_id
        FROM daily_checklist_submissions
        WHERE client_id = ${clientId} AND checklist_date BETWEEN ${from} AND ${to}
          AND submitted_at IS NOT NULL
      ) checklists
      JOIN sites s ON s.id = checklists.site_id AND s.client_id = ${clientId}
      JOIN users author ON author.id = checklists.author_id
        AND author.client_id = ${clientId} AND author.department_id = ${departmentId}
      WHERE true ${siteScope}
      GROUP BY s.id, checklists.checklist_type
    `),
    db.execute(sql`
      SELECT activity.module, s.id AS site_id, COUNT(*)::int AS records
      FROM (
        SELECT 'FireTrack' AS module, site_id, created_by FROM fire_safety_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'LegionellaTrack', site_id, created_by FROM legionella_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'TubTrack', site_id, created_by FROM hot_tub_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'TreeTrack', site_id, created_by FROM tree_inspections
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PremisesTrack', site_id, created_by FROM premises_inspections
          WHERE client_id = ${clientId} AND inspection_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PestTrack', site_id, created_by FROM pest_visits
          WHERE client_id = ${clientId} AND visit_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'IncidentTrack', site_id, created_by FROM incidents
          WHERE client_id = ${clientId} AND incident_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'FoodSafety', site_id, created_by FROM food_safety_records
          WHERE client_id = ${clientId} AND record_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'FixTrack', site_id, created_by FROM fix_track_issues
          WHERE client_id = ${clientId} AND reported_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'KitchenTrack', site_id, created_by FROM kitchen_cleaning_logs
          WHERE client_id = ${clientId} AND log_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PoolTrack', site_id, created_by FROM pool_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'SwimTrack', site_id, created_by FROM swim_sessions
          WHERE client_id = ${clientId} AND session_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PATtrack', a.site_id, t.created_by FROM pat_tests t
          JOIN pat_appliances a ON a.id = t.appliance_id AND a.client_id = ${clientId}
          WHERE t.test_date BETWEEN ${from} AND ${to}
      ) activity
      JOIN users author ON author.id = activity.created_by
        AND author.client_id = ${clientId} AND author.department_id = ${departmentId}
      JOIN sites s ON s.id = activity.site_id AND s.client_id = ${clientId}
      WHERE true ${siteScope}
      GROUP BY activity.module, s.id
      ORDER BY activity.module, s.id
    `),
  ]);

  const allSites = (sitesRes.rows as Array<{ id: number; name: string }>).map(s => ({
    id: Number(s.id), name: s.name,
  }));
  const siteMap = new Map(allSites.map(s => [s.id, s.name]));
  const dailyCounts = new Map<string, number>();
  const activeSiteIds = new Set<number>();
  for (const row of dailyRes.rows as Array<{ site_id: number; checklist_type: string; submitted: number }>) {
    const id = Number(row.site_id);
    activeSiteIds.add(id);
    dailyCounts.set(`${id}:${row.checklist_type}`, Number(row.submitted));
  }
  const moduleActivity = (moduleRes.rows as Array<{ module: string; site_id: number; records: number }>).map(row => {
    const id = Number(row.site_id);
    activeSiteIds.add(id);
    return {
      module: row.module, siteId: id, siteName: siteMap.get(id) ?? "",
      departmentId, departmentName, count: Number(row.records),
    };
  });
  // Without a selected site, don't mark unrelated sites 0% compliant just
  // because nobody from this department has submitted a record there.
  const sites = siteId !== undefined ? allSites : allSites.filter(s => activeSiteIds.has(s.id));
  const dailyChecklists = sites.flatMap(site =>
    (["am", "pm"] as const).map(type => {
      const submitted = dailyCounts.get(`${site.id}:${type}`) ?? 0;
      return {
        siteId: site.id, siteName: site.name, departmentId, departmentName,
        type, submitted, expected: totalDays,
        missed: Math.max(0, totalDays - submitted),
        pct: totalDays > 0 ? Math.round((submitted / totalDays) * 100) : 0,
      };
    }),
  );
  return {
    from, to, totalDays, departmentId, departmentName,
    sites, dailyChecklists, moduleActivity,
  };
}