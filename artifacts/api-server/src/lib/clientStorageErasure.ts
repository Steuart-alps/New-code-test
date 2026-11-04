/**
 * Delete a tenant's stored files as part of scheduled data deletion.
 *
 * Kept apart from offboarding.ts so the deletion job (and its tests) do not
 * load the storage provider SDK or image tooling unless files must be erased.
 */
import { sql } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { listTenantAttachmentObjectPaths } from "./attachmentReferences";
import { listRetainedRiddorReceiptPaths } from "./riddorReceipts";
import { ClientStorageErasureError, countClientStoredObjects, type ClientStorageEraser } from "./offboarding";

/**
 * Object paths the client's rows refer to (attachment columns plus the usage
 * ledger), once each. Ownership is decided later from each object's ACL.
 */
export async function listClientStorageReferences(
  clientId: number,
  executor: Parameters<ClientStorageEraser>[1],
): Promise<string[]> {
  const ledger = await executor.execute(
    sql`SELECT object_path FROM storage_usage_objects WHERE client_id = ${clientId} AND present`,
  );
  return [...new Set([
    ...await listTenantAttachmentObjectPaths(executor, clientId),
    ...(ledger.rows as Array<{ object_path: string }>).map((row) => row.object_path),
  ])];
}

/**
 * Lists the tenant's private objects (its provider prefixes plus legacy
 * references, filtered by the ACL owner) and deletes each one. Throws — so the
 * caller's deletion transaction rolls back and retries tomorrow — when storage
 * is unconfigured while the tenant still has stored files, or any delete fails
 * (reporting how many files had already gone).
 * HSE receipts bound to RIDDOR submission events are kept with those retained
 * events.
 */
export const eraseClientStorageObjects: ClientStorageEraser = async (clientId, executor) => {
  const storage = new ObjectStorageService();
  try {
    storage.getPrivateObjectDir();
  } catch {
    if (await countClientStoredObjects(clientId, executor) === 0) return { objectsDeleted: 0 };
    throw new Error("Object storage is not configured, so this client's stored files cannot be deleted");
  }
  const candidates = await listClientStorageReferences(clientId, executor);
  const retained = new Set(await listRetainedRiddorReceiptPaths(executor, clientId));
  // Ownership comes from each object's ACL, never from the reference: an
  // unmarked object, or one another tenant owns, is left in place and counted.
  const owned = (await storage.listTenantStorageObjects(clientId, candidates))
    .filter((object) => !retained.has(object.objectPath));
  let objectsDeleted = 0;
  for (const object of owned) {
    try {
      await storage.deleteTenantObject(object.objectPath, clientId);
    } catch (err) {
      throw new ClientStorageErasureError(
        `Stored file deletion stopped after ${objectsDeleted} of ${owned.length} files`,
        objectsDeleted,
        { cause: err },
      );
    }
    objectsDeleted++;
  }
  const deletedPaths = new Set(owned.map((object) => object.objectPath));
  const objectsSkipped = candidates.filter((objectPath) => !deletedPaths.has(objectPath)).length;
  return { objectsDeleted, objectsSkipped };
};
