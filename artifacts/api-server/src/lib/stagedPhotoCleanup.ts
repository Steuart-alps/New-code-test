import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { hasTenantAttachmentReference } from "./attachmentReferences";
import { ObjectNotFoundError, ObjectOwnershipError } from "./objectStorage";

/**
 * Cleanup of verified staged photos that were never attached to a record:
 * receipts the uploader cancelled (dialog closed / photo removed) or that
 * expired unclaimed.
 *
 * Safety rules:
 * - Work starts from a server-written receipt row, never from a request path.
 * - Each receipt is processed in its own transaction holding the receipt row
 *   lock. Record creation claims receipts with SELECT ... FOR UPDATE, so a
 *   create and a cleanup of the same receipt are strictly serialized: the
 *   create either commits first (the row is gone and cleanup skips it) or
 *   waits and then sees the receipt removed.
 * - The receipt row is removed first, then every tenant attachment store is
 *   checked under the same per-object advisory lock the photo delete route
 *   uses. Referenced objects are kept.
 * - The object is deleted only through deleteTenantObject, which requires a
 *   private ACL owned by the receipt's tenant, and only under that tenant's
 *   finalized prefix.
 * - Storage deletion happens before commit. A crash or storage failure rolls
 *   back the row removal, so the receipt is retried later; a retry that finds
 *   the object already gone completes normally. Failures back off.
 */

type SqlExecutor = { execute(query: unknown): Promise<{ rows?: any[] }> };

export interface StagedCleanupStorage {
  deleteTenantObject(objectPath: string, tenantId: number): Promise<void>;
}

export interface StagedCleanupResult {
  examined: number;
  objectsDeleted: number;
  alreadyMissing: number;
  keptReferenced: number;
  keptForeign: number;
  failed: number;
}

export const STAGED_CLEANUP_DEFAULT_BATCH = 50;
const MAX_BACKOFF_MINUTES = 24 * 60;

export function isTenantFinalizedObjectPath(objectPath: string, tenantId: number): boolean {
  return objectPath.startsWith(`/objects/finalized/tenant-${tenantId}/`)
    && !objectPath.includes("/../")
    && !objectPath.includes("/./");
}

type Outcome = "deleted" | "missing" | "referenced" | "foreign" | "none";

/** Process one due receipt (optionally a specific one). Returns "none" if nothing was due. */
async function cleanupOne(
  storage: StagedCleanupStorage,
  options: { receiptId?: string; clientId?: number },
): Promise<{ outcome: Outcome; receiptId?: string }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as SqlExecutor;
    const filters = [
      sql`claimed = false`,
      sql`(cancelled_at IS NOT NULL OR expires_at <= clock_timestamp())`,
      sql`(cleanup_after IS NULL OR cleanup_after <= clock_timestamp())`,
    ];
    if (options.receiptId) filters.push(sql`id = ${options.receiptId}::uuid`);
    if (options.clientId !== undefined) filters.push(sql`client_id = ${options.clientId}`);
    const selected = await tx.execute(sql`
      SELECT id, client_id, object_path
      FROM staged_photo_upload_receipts
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY expires_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const row = selected.rows?.[0] as { id: string; client_id: number; object_path: string } | undefined;
    if (!row) return { outcome: "none" as const };
    const clientId = Number(row.client_id);
    try {
      return await removeReceiptAndObject(tx, storage, row.id, clientId, row.object_path);
    } catch (err) {
      // Tag the failure so the caller backs off this receipt and moves on.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { stagedReceiptId: row.id });
    }
  });
}

async function removeReceiptAndObject(
  tx: SqlExecutor,
  storage: StagedCleanupStorage,
  receiptId: string,
  clientId: number,
  objectPath: string,
): Promise<{ outcome: Outcome; receiptId: string }> {
  // Same per-object lock as the photo delete route.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(${`${clientId}:${objectPath}`}))
  `);
  await tx.execute(sql`
    DELETE FROM staged_photo_upload_receipts WHERE id = ${receiptId}::uuid
  `);
  if (await hasTenantAttachmentReference(tx, clientId, objectPath)) {
    return { outcome: "referenced", receiptId };
  }
  if (!isTenantFinalizedObjectPath(objectPath, clientId)) {
    return { outcome: "foreign", receiptId };
  }
  try {
    await storage.deleteTenantObject(objectPath, clientId);
    return { outcome: "deleted", receiptId };
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return { outcome: "missing", receiptId };
    // ACL not private/owned by this tenant: never delete it, drop the receipt.
    if (err instanceof ObjectOwnershipError) return { outcome: "foreign", receiptId };
    throw err;
  }
}

async function recordFailure(receiptId: string, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await db.execute(sql`
    UPDATE staged_photo_upload_receipts
    SET cleanup_attempts = cleanup_attempts + 1,
        cleanup_error = ${message},
        cleanup_after = clock_timestamp()
          + make_interval(mins => LEAST(${MAX_BACKOFF_MINUTES}, power(2, LEAST(cleanup_attempts, 20))::int))
    WHERE id = ${receiptId}::uuid AND claimed = false
  `);
}

/**
 * Remove up to `limit` due receipts and their unreferenced objects. Each item
 * is independent, so one failing object never blocks the rest of the batch.
 */
export async function cleanupStagedPhotoUploads(
  storage: StagedCleanupStorage,
  options: { limit?: number; receiptId?: string; clientId?: number; onError?: (err: unknown) => void } = {},
): Promise<StagedCleanupResult> {
  const limit = Math.max(1, Math.min(options.limit ?? STAGED_CLEANUP_DEFAULT_BATCH, 500));
  const result: StagedCleanupResult = {
    examined: 0, objectsDeleted: 0, alreadyMissing: 0, keptReferenced: 0, keptForeign: 0, failed: 0,
  };
  const failedIds = new Set<string>();
  for (let index = 0; index < limit; index++) {
    let outcome: Outcome;
    try {
      ({ outcome } = await cleanupOne(storage, options));
    } catch (err) {
      const receiptId = (err as { stagedReceiptId?: string })?.stagedReceiptId;
      result.examined++;
      result.failed++;
      options.onError?.(err);
      if (!receiptId || failedIds.has(receiptId)) break;
      failedIds.add(receiptId);
      // Back off this receipt so the next iteration moves on to other work.
      await recordFailure(receiptId, err).catch((updateError) => options.onError?.(updateError));
      if (options.receiptId) break;
      continue;
    }
    if (outcome === "none") break;
    result.examined++;
    if (outcome === "deleted") result.objectsDeleted++;
    else if (outcome === "missing") result.alreadyMissing++;
    else if (outcome === "referenced") result.keptReferenced++;
    else if (outcome === "foreign") result.keptForeign++;
    if (options.receiptId) break;
  }
  return result;
}

/**
 * Mark the caller's own unclaimed receipt as cancelled. The UPDATE takes the
 * receipt row lock, so it waits for any in-flight create using it; if that
 * create committed, the receipt no longer exists and nothing is cancelled.
 */
export async function cancelStagedPhotoReceipt(
  executor: SqlExecutor,
  receiptId: string,
  clientId: number,
  actorId: number,
): Promise<boolean> {
  const result = await executor.execute(sql`
    UPDATE staged_photo_upload_receipts
    SET cancelled_at = COALESCE(cancelled_at, clock_timestamp())
    WHERE id = ${receiptId}::uuid
      AND client_id = ${clientId}
      AND actor_id = ${actorId}
      AND claimed = false
    RETURNING id
  `);
  return (result.rows ?? []).length > 0;
}
