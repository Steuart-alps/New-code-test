/**
 * Delete a tenant's stored files as part of scheduled data deletion.
 *
 * Kept apart from offboarding.ts so the deletion job (and its tests) do not
 * load the storage provider SDK or image tooling unless files must be erased.
 */
import { sql } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { listTenantAttachmentObjectPaths } from "./attachmentReferences";
import { countClientStoredObjects, type ClientStorageEraser } from "./offboarding";

/**
 * Lists the tenant's private objects (its provider prefixes plus legacy
 * references, filtered by the ACL owner) and deletes each one. Throws — so the
 * caller's deletion transaction rolls back and retries tomorrow — when storage
 * is unconfigured while the tenant still has stored files, or any delete fails.
 */
export const eraseClientStorageObjects: ClientStorageEraser = async (clientId, executor) => {
  const storage = new ObjectStorageService();
  try {
    storage.getPrivateObjectDir();
  } catch {
    if (await countClientStoredObjects(clientId, executor) === 0) return { objectsDeleted: 0 };
    throw new Error("Object storage is not configured, so this client's stored files cannot be deleted");
  }
  const ledger = await executor.execute(
    sql`SELECT object_path FROM storage_usage_objects WHERE client_id = ${clientId} AND present`,
  );
  const referenced = [
    ...await listTenantAttachmentObjectPaths(executor, clientId),
    ...(ledger.rows as Array<{ object_path: string }>).map((row) => row.object_path),
  ];
  const owned = await storage.listTenantStorageObjects(clientId, [...new Set(referenced)]);
  for (const object of owned) {
    await storage.deleteTenantObject(object.objectPath, clientId);
  }
  return { objectsDeleted: owned.length };
};
