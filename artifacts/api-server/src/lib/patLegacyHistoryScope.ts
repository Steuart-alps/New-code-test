import { sql } from "drizzle-orm";

/** For queries aliasing pat_tests as t and its historical site as s. */
export function historicalTestDepartmentScope(departmentId: number | null) {
  return departmentId === null ? sql`` : sql`
    AND (t.department_id_snapshot IS NULL OR t.department_id_snapshot=${departmentId})
    AND (t.site_id_snapshot IS NULL OR s.department_id IS NULL OR s.department_id=${departmentId})
    AND t.snapshot_source <> 'legacy_unavailable'
  `;
}