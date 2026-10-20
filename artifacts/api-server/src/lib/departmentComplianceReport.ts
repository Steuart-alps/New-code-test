import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { historicalTestDepartmentScope } from "./patLegacyHistoryScope";
import { submittedDailyChecklists } from "./dailyChecklistCompletion";
import { departmentSiteIdSql, siteVisibleSql } from "./departmentSites";

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

/**
 * Boolean SQL: the site whose id and department_id columns are given is one of
 * department `departmentId`'s own sites, i.e. given to it or the site it sits
 * under (when not another department's), and never another site than that.
 */
export function departmentOwnsSiteSql(siteIdColumn: SQL, siteDepartmentColumn: SQL, departmentId: number): SQL {
  return sql`(${siteVisibleSql(siteIdColumn, siteDepartmentColumn, departmentId)}
    AND (${siteDepartmentColumn} = ${departmentId} OR ${siteIdColumn} = ${departmentSiteIdSql(departmentId)}))`;
}

export const DEPARTMENT_NOT_RECORDED_LABEL = "Department not recorded";

/** Attribute records to the department their author belonged to when each
 * record was created (submitter_department_id, captured by a database trigger;
 * see submitterDepartmentMigration.ts), so moving an account between
 * departments never changes past totals, and records stay counted after their
 * author is removed. Records created before capture began have no known
 * department: they are counted separately under "Department not recorded"
 * and never assigned from the author's current department.
 * The site restriction for department-scoped staff remains in effect; managers
 * can see a team's work at any site in their tenant.
 */
export async function getDepartmentComplianceReport({
  clientId, from, to, totalDays, siteId, departmentId, departmentName,
  restrictSitesToDepartment,
}: Options) {
  const siteScope = sql`
    ${siteId !== undefined ? sql`AND s.id = ${siteId}` : sql``}
    ${restrictSitesToDepartment ? sql`AND ${departmentOwnsSiteSql(sql`s.id`, sql`s.department_id`, departmentId)}` : sql``}
  `;
  // Either this department's recorded rows or rows with no recorded department.
  const attribution = (alias: string) => sql.raw(`
    CASE WHEN ${alias}.submitter_department_source = 'not_recorded' THEN 'not_recorded' ELSE 'department' END
  `);
  const inReport = (alias: string) => sql`
    AND (${sql.raw(alias)}.submitter_department_source = 'not_recorded'
      OR (${sql.raw(alias)}.submitter_department_source = 'recorded'
        AND ${sql.raw(alias)}.submitter_department_id = ${departmentId}))
  `;
  const [sitesRes, dailyRes, moduleRes] = await Promise.all([
    db.execute(sql`
      SELECT s.id, s.name FROM sites s
      WHERE s.client_id = ${clientId} ${siteScope}
      ORDER BY s.name, s.id
    `),
    db.execute(sql`
      SELECT ${attribution("checklists")} AS attribution,
             s.id AS site_id, checklists.period AS checklist_type,
             COUNT(DISTINCT checklists.check_date)::int AS submitted
      FROM ${submittedDailyChecklists(clientId, from, to)} checklists
      JOIN sites s ON s.id = checklists.site_id AND s.client_id = ${clientId}
      WHERE true ${inReport("checklists")} ${siteScope}
      GROUP BY 1, s.id, checklists.period
    `),
    db.execute(sql`
      SELECT ${attribution("activity")} AS attribution,
             activity.module, s.id AS site_id, COUNT(*)::int AS records
      FROM (
        SELECT 'FireTrack' AS module, site_id, submitter_department_id, submitter_department_source FROM fire_safety_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'LegionellaTrack', site_id, submitter_department_id, submitter_department_source FROM legionella_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'TubTrack', site_id, submitter_department_id, submitter_department_source FROM hot_tub_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'TreeTrack', site_id, submitter_department_id, submitter_department_source FROM tree_inspections
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PremisesTrack', site_id, submitter_department_id, submitter_department_source FROM premises_inspections
          WHERE client_id = ${clientId} AND inspection_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PestTrack', site_id, submitter_department_id, submitter_department_source FROM pest_visits
          WHERE client_id = ${clientId} AND visit_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'IncidentTrack', site_id, submitter_department_id, submitter_department_source FROM incidents
          WHERE client_id = ${clientId} AND incident_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'FoodSafety', site_id, submitter_department_id, submitter_department_source FROM food_safety_records
          WHERE client_id = ${clientId} AND record_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'FixTrack', site_id, submitter_department_id, submitter_department_source FROM fix_track_issues
          WHERE client_id = ${clientId} AND reported_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'KitchenTrack', site_id, submitter_department_id, submitter_department_source FROM kitchen_cleaning_logs
          WHERE client_id = ${clientId} AND log_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PoolTrack', site_id, submitter_department_id, submitter_department_source FROM pool_checks
          WHERE client_id = ${clientId} AND check_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'SwimTrack', site_id, submitter_department_id, submitter_department_source FROM swim_sessions
          WHERE client_id = ${clientId} AND session_date BETWEEN ${from} AND ${to}
        UNION ALL
        SELECT 'PATtrack', t.site_id_snapshot, t.submitter_department_id, t.submitter_department_source FROM pat_tests t
          JOIN pat_appliances a ON a.id = t.appliance_id AND a.client_id = t.client_id
          LEFT JOIN sites s ON s.id = t.site_id_snapshot AND s.client_id = t.client_id
          WHERE t.client_id = ${clientId}
            AND t.test_date BETWEEN ${from} AND ${to}
            AND t.site_id_snapshot IS NOT NULL
            ${historicalTestDepartmentScope(departmentId)}
      ) activity
      JOIN sites s ON s.id = activity.site_id AND s.client_id = ${clientId}
      WHERE true ${inReport("activity")} ${siteScope}
      GROUP BY 1, activity.module, s.id
      ORDER BY activity.module, s.id
    `),
  ]);

  const allSites = (sitesRes.rows as Array<{ id: number; name: string }>).map(s => ({
    id: Number(s.id), name: s.name,
  }));
  const siteMap = new Map(allSites.map(s => [s.id, s.name]));
  const dailyCounts = new Map<string, number>();
  const activeSiteIds = new Set<number>();
  const notRecordedDaily: Array<{ siteId: number; siteName: string; type: "am" | "pm"; submitted: number }> = [];
  for (const row of dailyRes.rows as Array<{ attribution: string; site_id: number; checklist_type: "am" | "pm"; submitted: number }>) {
    const id = Number(row.site_id);
    if (row.attribution === "not_recorded") {
      notRecordedDaily.push({ siteId: id, siteName: siteMap.get(id) ?? "", type: row.checklist_type, submitted: Number(row.submitted) });
      continue;
    }
    activeSiteIds.add(id);
    dailyCounts.set(`${id}:${row.checklist_type}`, Number(row.submitted));
  }
  const moduleActivity: Array<{
    module: string; siteId: number; siteName: string; departmentId: number; departmentName: string; count: number;
  }> = [];
  const notRecordedModules: Array<{ module: string; siteId: number; siteName: string; count: number }> = [];
  for (const row of moduleRes.rows as Array<{ attribution: string; module: string; site_id: number; records: number }>) {
    const id = Number(row.site_id);
    const base = { module: row.module, siteId: id, siteName: siteMap.get(id) ?? "", count: Number(row.records) };
    if (row.attribution === "not_recorded") {
      notRecordedModules.push(base);
      continue;
    }
    activeSiteIds.add(id);
    moduleActivity.push({ ...base, departmentId, departmentName });
  }
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
  notRecordedDaily.sort((a, b) => a.siteName.localeCompare(b.siteName) || a.siteId - b.siteId || a.type.localeCompare(b.type));
  return {
    from, to, totalDays, departmentId, departmentName,
    attribution: "recorded_at_submission" as const,
    sites, dailyChecklists, moduleActivity,
    // Older records whose author's department wasn't captured. Shown, but
    // counted for no department; their author's current team is not used.
    departmentNotRecorded: {
      label: DEPARTMENT_NOT_RECORDED_LABEL,
      dailyChecklists: notRecordedDaily,
      moduleActivity: notRecordedModules,
      records: notRecordedModules.reduce((sum, row) => sum + row.count, 0)
        + notRecordedDaily.reduce((sum, row) => sum + row.submitted, 0),
    },
  };
}
