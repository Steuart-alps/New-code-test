/**
 * Cheaper storage for cancelled businesses' files.
 *
 * A business that cancels (or whose trial lapses) keeps its records for 12
 * months, but nobody uses its files meanwhile. After a 30-day grace period —
 * when an export or a change of heart is most likely — its files move to a
 * cold storage class; if the business subscribes again they move back.
 *
 * Every class stays readable by the same code (exports, downloads, legal
 * holds); cold classes only charge a per-GB fee when read. ARCHIVE is the
 * default because its 365-day minimum charge still costs less than ~11 months
 * of COLDLINE before the 12-month deletion. CANCELLED_FILES_STORAGE_CLASS can
 * choose NEARLINE or COLDLINE, or "off" (e.g. for a bucket using Autoclass,
 * which manages classes itself).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { listClientStorageReferences } from "./clientStorageErasure";

export const CANCELLED_FILES_GRACE_DAYS = 30;
const COLD_CLASSES = new Set(["NEARLINE", "COLDLINE", "ARCHIVE"]);
const ACTIVE_CLASS = "STANDARD";

/** The configured cold class, or null when switched off. Throws on a typo. */
export function cancelledFilesStorageClass(): string | null {
  const raw = (process.env.CANCELLED_FILES_STORAGE_CLASS ?? "").trim().toUpperCase();
  if (raw === "") return "ARCHIVE";
  if (raw === "OFF") return null;
  if (!COLD_CLASSES.has(raw)) {
    throw new Error("CANCELLED_FILES_STORAGE_CLASS must be NEARLINE, COLDLINE, ARCHIVE or off");
  }
  return raw;
}

type StorageClassMover = Pick<ObjectStorageService, "setTenantObjectsStorageClass" | "getPrivateObjectDir">;

export interface CancelledStorageDependencies {
  storage?: StorageClassMover;
  /** Optional fixture scope for tests; omitted by the production scheduler. */
  clientIds?: readonly number[];
}

/**
 * Daily: archive the files of businesses cancelled more than 30 days ago, and
 * restore those of businesses that have a live subscription again (the
 * cancellation job clears cancelled_at then). Runs under the per-client
 * erasure lock, so it never races a deletion. A failed client keeps its
 * marker unchanged, is retried tomorrow, and fails the run so it is alerted.
 */
export async function runCancelledStorageClassJob(
  deps: CancelledStorageDependencies = {},
): Promise<{ archived: number; restored: number; objectsMoved: number; skipped?: string }> {
  const coldClass = cancelledFilesStorageClass();
  if (!coldClass) return { archived: 0, restored: 0, objectsMoved: 0, skipped: "switched off" };
  const storage = deps.storage ?? new ObjectStorageService();
  try {
    storage.getPrivateObjectDir();
  } catch {
    return { archived: 0, restored: 0, objectsMoved: 0, skipped: "object storage not configured" };
  }
  if (deps.clientIds?.length === 0) return { archived: 0, restored: 0, objectsMoved: 0 };
  const scope = deps.clientIds === undefined
    ? sql``
    : sql`AND c.id IN (${sql.join(deps.clientIds.map((id) => sql`${id}`), sql`, `)})`;
  const due = (client: ReturnType<typeof sql>) => sql`
    c.data_deleted_at IS NULL AND (
      (c.files_archived_at IS NULL AND c.cancelled_at IS NOT NULL
        AND c.cancelled_at <= now() - make_interval(days => ${CANCELLED_FILES_GRACE_DAYS}))
      OR (c.files_archived_at IS NOT NULL AND c.cancelled_at IS NULL)
    ) ${client}`;
  const candidates = await db.execute(sql`SELECT c.id FROM clients c WHERE ${due(scope)} ORDER BY c.id`);

  let archived = 0;
  let restored = 0;
  let objectsMoved = 0;
  const failed: number[] = [];
  for (const { id } of candidates.rows as Array<{ id: number }>) {
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(106, ${id})`);
        const current = await tx.execute(sql`
          SELECT c.files_archived_at IS NULL AS archive FROM clients c WHERE c.id = ${id} AND ${due(sql``)}
        `);
        const row = current.rows[0] as { archive: boolean } | undefined;
        if (!row) return null;
        const references = await listClientStorageReferences(id, tx);
        const moved = await storage.setTenantObjectsStorageClass(id, references, row.archive ? coldClass : ACTIVE_CLASS);
        await tx.execute(row.archive
          ? sql`UPDATE clients SET files_archived_at = now() WHERE id = ${id}`
          : sql`UPDATE clients SET files_archived_at = NULL WHERE id = ${id}`);
        return { archive: row.archive, moved: moved.changed };
      });
      if (!result) continue;
      if (result.archive) archived++; else restored++;
      objectsMoved += result.moved;
      logger.info({ clientId: id, storageClass: result.archive ? coldClass : ACTIVE_CLASS, objectsMoved: result.moved },
        result.archive ? "Cancelled business's files moved to cold storage" : "Reactivated business's files moved back to standard storage");
    } catch (err) {
      failed.push(id);
      logger.error({ err, clientId: id }, "Could not change the storage class of a business's files; will retry tomorrow");
    }
  }
  if (failed.length > 0) {
    throw new Error(`Storage class change failed for ${failed.length} client(s): ${failed.join(", ")}`);
  }
  return { archived, restored, objectsMoved };
}
