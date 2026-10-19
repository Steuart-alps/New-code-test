/**
 * HSE receipts bound to RIDDOR submission events (incident_riddor_events).
 *
 * A receipt is written with its submission event and can never be changed or
 * detached (the table is append-only). It usually repeats the injury details
 * from the HSE report, so only the managers who may read injury details can
 * attach or download one, and only within the incident's site/department.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AllowedUploadType } from "./uploadValidation";

export const RIDDOR_RECEIPT_TYPES: ReadonlySet<AllowedUploadType> = new Set(["application/pdf", "image/jpeg", "image/png"]);

type Executor = { execute(query: SQL): Promise<{ rows?: unknown[] }> };

/**
 * Injury details are health data (special category under UK GDPR), so only
 * managers read them: client admins, consultants and department managers.
 */
export function canReadHealthData(req: { currentUser?: { role: string; isDepartmentManager?: boolean | null } }): boolean {
  const user = req.currentUser;
  if (!user) return false;
  return user.role === "client_admin" || user.role === "consultant"
    || (user.role === "client_staff" && user.isDepartmentManager === true);
}

/**
 * Guard for the generic /storage/objects route. Private objects are tenant
 * ACL'd only, so a same-tenant user who learns a receipt's path could
 * otherwise fetch it directly. When the object is bound as a RIDDOR receipt,
 * every incident it is bound to must be within the caller's department scope,
 * and the caller must be a manager unless the same file is also one of the
 * incident's ordinary attachments (which staff can already see).
 */
export async function riddorReceiptObjectAccess(
  executor: Executor,
  clientId: number,
  objectPath: string,
  departmentId: number | null,
  manager: boolean,
): Promise<boolean> {
  const scope = departmentId === null ? sql`` : sql`
    AND (i.site_id IS NULL OR i.site_id IN (
      SELECT id FROM sites WHERE client_id = ${clientId}
        AND (department_id IS NULL OR department_id = ${departmentId})
    ))`;
  const found = (await executor.execute(sql`
    SELECT
      (SELECT count(*) FROM incident_riddor_events e
        WHERE e.client_id = ${clientId} AND e.receipt_object_path = ${objectPath})::int AS refs,
      (SELECT count(*) FROM incident_riddor_events e
        JOIN incidents i ON i.id = e.incident_id AND i.client_id = e.client_id
        WHERE e.client_id = ${clientId} AND e.receipt_object_path = ${objectPath} ${scope})::int AS visible_refs,
      EXISTS (SELECT 1 FROM check_photos p
        WHERE p.client_id = ${clientId} AND p.entity_type = 'incident' AND p.object_path = ${objectPath}) AS attachment
  `)).rows?.[0] as { refs: number; visible_refs: number; attachment: boolean } | undefined;
  const refs = Number(found?.refs ?? 0);
  if (refs === 0) return true;
  if (Number(found?.visible_refs ?? 0) !== refs) return false;
  return manager || found?.attachment === true;
}

/**
 * Receipt files that stay with their retained RIDDOR events when a business's
 * data is erased (offboarding keeps incident_riddor_events).
 */
export async function listRetainedRiddorReceiptPaths(executor: Executor, clientId: number): Promise<string[]> {
  const result = await executor.execute(sql`
    SELECT DISTINCT receipt_object_path AS object_path FROM incident_riddor_events
    WHERE client_id = ${clientId} AND receipt_object_path LIKE '/objects/%'
  `);
  return (result.rows ?? []).map((row) => (row as { object_path: string }).object_path);
}
