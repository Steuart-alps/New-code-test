import { randomUUID } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const STAGED_PHOTO_ENTITY_TYPES = [
  "green_pre_use_check",
  "green_service",
  "green_defect",
  "swim_session",
  "swim_surveillance_check",
  "swim_first_aid_check",
  "swim_incident",
] as const;

export type StagedPhotoEntityType = (typeof STAGED_PHOTO_ENTITY_TYPES)[number];

export function isStagedPhotoEntityType(value: unknown): value is StagedPhotoEntityType {
  return typeof value === "string"
    && (STAGED_PHOTO_ENTITY_TYPES as readonly string[]).includes(value);
}

export class StagedPhotoReceiptError extends Error {
  constructor(
    readonly status: 400 | 403 | 422,
    message: string,
  ) {
    super(message);
    this.name = "StagedPhotoReceiptError";
    Object.setPrototypeOf(this, StagedPhotoReceiptError.prototype);
  }
}

type SqlExecutor = {
  execute(query: unknown): Promise<{ rows?: any[] }>;
};

type TransactionExecutor = SqlExecutor;

export type StagedPhotoCreateOptions = {
  clientId: number;
  entityType: StagedPhotoEntityType;
  actorId: number;
  photoUploadIds?: unknown;
  requestBody?: unknown;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePhotoUploadIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw new StagedPhotoReceiptError(400, "photoUploadIds must be an array of at most 10 UUIDs");
  }
  if (value.some((id) => typeof id !== "string" || !UUID_RE.test(id))) {
    throw new StagedPhotoReceiptError(400, "photoUploadIds must contain valid UUIDs");
  }
  const ids = value as string[];
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
    throw new StagedPhotoReceiptError(400, "photoUploadIds must be unique");
  }
  return ids;
}

export function rejectDirectPhotoPaths(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const directPathFields = [
    "objectPath", "objectPaths", "photoPath", "photoPaths", "photoUrl", "photoUrls",
  ];
  if (directPathFields.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new StagedPhotoReceiptError(400, "Submit verified photoUploadIds instead of direct photo paths");
  }
}

/**
 * The lock protects even a missing photo_requirements row. The requirement
 * writer takes the same lock, so a create observes either the complete old
 * configuration or the complete new one, never a partial settings update.
 */
export async function lockPhotoRequirement(
  executor: SqlExecutor,
  clientId: number,
  entityType: string,
): Promise<void> {
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext(${`photo-requirement:${clientId}:${entityType}`}))
  `);
}

/**
 * Run an original record insert and its staged-photo claim in one database
 * transaction. Callers retain responsibility for their existing authorization
 * and parent/site validation; the callback contains only their original writes.
 */
export async function createWithStagedPhotoReceipts<T extends { id: number | string }>(
  options: StagedPhotoCreateOptions,
  createRecord: (tx: TransactionExecutor) => Promise<T>,
): Promise<T> {
  if (!isStagedPhotoEntityType(options.entityType)) {
    throw new StagedPhotoReceiptError(400, "Unsupported staged photo entity type");
  }
  rejectDirectPhotoPaths(options.requestBody);
  const photoIds = parsePhotoUploadIds(options.photoUploadIds);

  return db.transaction(async (tx) => {
    await lockPhotoRequirement(tx as unknown as SqlExecutor, options.clientId, options.entityType);
    const requirements = await tx.execute(sql`
      SELECT required, min_photos
      FROM photo_requirements
      WHERE client_id = ${options.clientId} AND entity_type = ${options.entityType}
      LIMIT 1
    `);
    const requirement = requirements.rows?.[0] as
      | { required: boolean; min_photos: number | string }
      | undefined;
    const requiredCount = requirement?.required ? Number(requirement.min_photos) || 1 : 0;
    if (photoIds.length < requiredCount) {
      throw new StagedPhotoReceiptError(422, `At least ${requiredCount} verified photo(s) are required`);
    }

    const receipts: Array<{
      id: string;
      client_id: number;
      entity_type: string;
      actor_id: number;
      object_path: string;
      unexpired: boolean;
      claimed: boolean;
      cancelled?: boolean;
    }> = [];
    if (photoIds.length) {
      const idList = sql.join(photoIds.map((id) => sql`${id}::uuid`), sql`, `);
      const result = await tx.execute(sql`
        SELECT id, client_id, entity_type, actor_id, object_path,
          expires_at > clock_timestamp() AS unexpired, claimed,
          cancelled_at IS NOT NULL AS cancelled
        FROM staged_photo_upload_receipts
        WHERE id IN (${idList})
        ORDER BY id
        FOR UPDATE
      `);
      receipts.push(...((result.rows ?? []) as typeof receipts));
      if (receipts.length !== photoIds.length) {
        throw new StagedPhotoReceiptError(400, "One or more photo upload receipts are invalid or already claimed");
      }

      const byId = new Map(receipts.map((receipt) => [receipt.id.toLowerCase(), receipt]));
      const ordered = photoIds.map((id) => byId.get(id.toLowerCase()));
      if (ordered.some((receipt) => !receipt)) {
        throw new StagedPhotoReceiptError(400, "One or more photo upload receipts are invalid or already claimed");
      }
      for (const receipt of ordered as typeof receipts) {
        if (Number(receipt.client_id) !== options.clientId || Number(receipt.actor_id) !== options.actorId) {
          throw new StagedPhotoReceiptError(403, "Photo upload receipt is not available to this user");
        }
        if (receipt.entity_type !== options.entityType) {
          throw new StagedPhotoReceiptError(400, "Photo upload receipt is for a different record type");
        }
        // A cancelled receipt is queued for object cleanup and is never reusable.
        if (receipt.claimed || !receipt.unexpired || receipt.cancelled) {
          throw new StagedPhotoReceiptError(400, "Photo upload receipt is expired or already claimed");
        }
      }

      const claimResult = await tx.execute(sql`
        UPDATE staged_photo_upload_receipts
        SET claimed = true
        WHERE id IN (${idList}) AND claimed = false AND cancelled_at IS NULL
        RETURNING id
      `);
      if ((claimResult.rows ?? []).length !== photoIds.length) {
        throw new StagedPhotoReceiptError(400, "One or more photo upload receipts are invalid or already claimed");
      }
    }

    const record = await createRecord(tx as unknown as TransactionExecutor);
    const entityId = Number(record.id);
    if (!Number.isSafeInteger(entityId) || entityId <= 0) {
      throw new Error("New record did not return a valid ID for photo attachment");
    }

    for (const receipt of receipts) {
      await tx.execute(sql`
        INSERT INTO check_photos (client_id, entity_type, entity_id, object_path, created_by)
        VALUES (
          ${options.clientId}, ${options.entityType}, ${entityId}, ${receipt.object_path}, ${options.actorId}
        )
      `);
    }
    if (photoIds.length) {
      const idList = sql.join(photoIds.map((id) => sql`${id}::uuid`), sql`, `);
      await tx.execute(sql`
        DELETE FROM staged_photo_upload_receipts WHERE id IN (${idList}) AND claimed = true
      `);
    }
    return record;
  });
}

export function newStagedPhotoReceiptId(): string {
  return randomUUID();
}