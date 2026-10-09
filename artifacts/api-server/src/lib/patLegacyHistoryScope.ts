import { sql, type SQL } from "drizzle-orm";

/** For queries aliasing pat_tests as t and its historical site as s. */
export function historicalTestDepartmentScope(departmentId: number | null) {
  return departmentId === null ? sql`` : sql`
    AND (t.department_id_snapshot IS NULL OR t.department_id_snapshot=${departmentId})
    AND (t.site_id_snapshot IS NULL OR s.department_id IS NULL OR s.department_id=${departmentId})
    AND t.snapshot_source <> 'legacy_unavailable'
  `;
}

type Executor = { execute(query: SQL): Promise<any> };
const rows = (result: any): any[] => result?.rows ?? result ?? [];

/**
 * Whether a caller may use a PAT test as a photo parent. The boundary is the
 * department/site recorded with the test (its immutable snapshot), never the
 * appliance's current location, so relocation or retirement neither exposes a
 * retained test to the destination department nor hides it from its own.
 */
export async function patTestHistoryAccess(
  executor: Executor,
  clientId: number,
  testId: number,
  departmentId: number | null,
): Promise<"allowed" | "forbidden" | "missing"> {
  const found = rows(await executor.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM pat_tests t
        LEFT JOIN sites s ON s.id=t.site_id_snapshot AND s.client_id=t.client_id
        WHERE t.id=${testId} AND t.client_id=${clientId}
        ${historicalTestDepartmentScope(departmentId)}
      ) AS in_scope,
      EXISTS (SELECT 1 FROM pat_tests WHERE id=${testId} AND client_id=${clientId}) AS owned
  `))[0] as { in_scope: boolean; owned: boolean } | undefined;
  if (!found?.owned) return "missing";
  return found.in_scope ? "allowed" : "forbidden";
}

/**
 * Private objects are tenant-ACL'd, so a same-tenant user who learns another
 * department's PAT photo path could otherwise download it directly. When an
 * object is attached to PAT test photos, the caller must be able to see every
 * one of those tests. Finalisation always writes a fresh key, so a legitimate
 * object has one parent; a copied reference (under another test or another
 * module) therefore never widens access to the original department's photo.
 */
export async function patPhotoObjectAccess(
  executor: Executor,
  clientId: number,
  objectPath: string,
  departmentId: number | null,
): Promise<boolean> {
  if (departmentId === null) return true;
  const found = rows(await executor.execute(sql`
    SELECT
      (SELECT count(*) FROM check_photos p
        WHERE p.client_id=${clientId} AND p.entity_type='pat_test' AND p.object_path=${objectPath})::int AS pat_refs,
      (SELECT count(*) FROM check_photos p
        JOIN pat_tests t ON t.id=p.entity_id AND t.client_id=p.client_id
        LEFT JOIN sites s ON s.id=t.site_id_snapshot AND s.client_id=t.client_id
        WHERE p.client_id=${clientId} AND p.entity_type='pat_test' AND p.object_path=${objectPath}
        ${historicalTestDepartmentScope(departmentId)})::int AS visible_refs
  `))[0] as { pat_refs: number; visible_refs: number } | undefined;
  return Number(found?.pat_refs ?? 0) === Number(found?.visible_refs ?? 0);
}

/** Tenant-namespaced object keys must belong to the caller's tenant. */
export function objectPathTenantMismatch(objectPath: string, clientId: number): boolean {
  const owner = objectPath.match(/^\/objects\/(?:uploads|finalized)\/tenant-(\d+)\//)?.[1];
  return owner !== undefined && Number(owner) !== clientId;
}
