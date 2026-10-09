import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireAuth, getClientId, denyViewers, requireClientAdmin } from "../middleware/requireAuth";
import { requireAnyService, requireService } from "../lib/services";
import {
  AllowedUploadType,
  ObjectContentError,
  ObjectGenerationError,
  ObjectStorageService,
  ObjectNotFoundError,
  ObjectOwnershipError,
  isTenantReservedObjectPath,
} from "../lib/objectStorage";
import { respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { hasTenantAttachmentReference } from "../lib/attachmentReferences";
import {
  isStagedPhotoEntityType,
  lockPhotoRequirement,
  STAGED_PHOTO_ENTITY_TYPES,
} from "../lib/stagedPhotoReceipts";

const router = Router();
const storage = new ObjectStorageService();
const ALLOWED_PHOTO_TYPES: ReadonlySet<AllowedUploadType> = new Set(["image/jpeg", "image/png"]);
const STAGED_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(STAGED_PHOTO_ENTITY_TYPES);

/**
 * check_photos is intentionally polymorphic, but it must not be an arbitrary
 * (entity_type, entity_id) store.  Keeping this allow-list next to the upload
 * endpoint means a photo can only be attached after its actual record has been
 * found within the active tenant.
 */
export const PHOTO_ENTITY_TABLES = {
  fire_safety_check: "fire_safety_checks",
  pool_check: "pool_checks",
  bike_hire: "bike_hire_records",
  bike_check: "bike_checks",
  bike_service: "bike_services",
  daily_checklist: "daily_checklists",
  daily_checklist_pm: "daily_checklists",
  food_safety_record: "food_safety_records",
  food_safety_check: "food_safety_records",
  legionella_check: "legionella_checks",
  hot_tub_check: "hot_tub_checks",
  incident: "incidents",
  pat_test: "pat_tests",
  pest_visit: "pest_visits",
  training_record: "train_track_records",
  tree_inspection: "tree_inspections",
  green_pre_use_check: "green_pre_use_checks",
  green_service: "green_service_records",
  green_defect: "green_defects",
  swim_session: "swim_sessions",
  swim_surveillance_check: "swim_surveillance_checks",
  swim_first_aid_check: "swim_first_aid_checks",
  swim_incident: "swim_incidents",
  safe_risk_assessment: "safe_risk_assessments",
  safe_sop: "safe_sops",
  safe_handbook: "safe_handbook",
  safe_training_record: "safe_training_records",
  safe_induction: "safe_inductions",
} as const;

export type PhotoEntityType = keyof typeof PHOTO_ENTITY_TABLES;

export function isSupportedPhotoEntityType(entityType: string): entityType is PhotoEntityType {
  return Object.prototype.hasOwnProperty.call(PHOTO_ENTITY_TABLES, entityType);
}

const stagedPhotoEntitlement: RequestHandler = (req, res, next) => {
  const entityType = req.body?.entityType;
  if (typeof entityType !== "string" || !STAGED_ENTITY_TYPE_SET.has(entityType)) {
    return res.status(400).json({ error: "Unsupported staged photo entity type" });
  }
  if (entityType.startsWith("green_")) return requireService("greentrack")(req, res, next);
  return requireAnyService("swimtrack", "aquatrack")(req, res, next);
};

const greenServiceCreationRole: RequestHandler = (req, res, next) => {
  if (req.body?.entityType === "green_service") return requireClientAdmin(req, res, next);
  next();
};

function photoStorageError(err: unknown): { status: number; error: string } {
  const error = err instanceof ObjectNotFoundError ? "Uploaded object not found"
    : err instanceof ObjectContentError ? "Photo contents must be a valid JPEG or PNG"
    : err instanceof ObjectGenerationError ? err.message
    : err instanceof ObjectOwnershipError ? err.message : "Could not secure uploaded photo";
  const status = err instanceof ObjectNotFoundError ? 404
    : err instanceof ObjectContentError ? 400
    : err instanceof ObjectGenerationError ? 409 : 403;
  return { status, error };
}

function isPostgresUniqueViolation(err: any): boolean {
  return err?.code === "23505";
}

async function requireOwnedPhotoEntity(
  entityType: string,
  entityId: number,
  clientId: number,
): Promise<boolean> {
  if (!isSupportedPhotoEntityType(entityType)) return false;
  // table names come only from the constant above, never the request.
  const table = sql.raw(PHOTO_ENTITY_TABLES[entityType]);
  const result = await db.execute(sql`
    SELECT id FROM ${table} WHERE id = ${entityId} AND client_id = ${clientId} LIMIT 1
  `);
  return Boolean((result as any).rows[0]);
}

async function rejectUnownedPhotoEntity(
  res: any,
  entityType: string,
  entityId: number,
  clientId: number,
): Promise<boolean> {
  if (!isSupportedPhotoEntityType(entityType)) {
    res.status(400).json({ error: "Unsupported photo entity type" });
    return true;
  }
  if (!await requireOwnedPhotoEntity(entityType, entityId, clientId)) {
    // Do not disclose whether this is a missing ID or another tenant's ID.
    res.status(404).json({ error: "Record not found" });
    return true;
  }
  return false;
}

// ── Request presigned upload URL ──────────────────────────────────────────────
// POST /photos/request-upload
router.post(
  "/request-staged-upload",
  requireAuth,
  denyViewers,
  stagedPhotoEntitlement,
  greenServiceCreationRole,
  async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });

    const body = z.object({
      entityType: z.string().min(1).max(100),
      name: z.string().min(1).max(200),
      contentType: z.enum(["image/jpeg", "image/png"], {
        message: "Photos must be JPEG or PNG",
      }),
    }).parse(req.body);
    if (!isStagedPhotoEntityType(body.entityType)) {
      return res.status(400).json({ error: "Unsupported staged photo entity type" });
    }

    try {
      const uploadUrl = await storage.getObjectEntityUploadURL(clientId, body.contentType);
      const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
      if (!isTenantReservedObjectPath(objectPath, clientId)) {
        throw new ObjectOwnershipError("Upload was not reserved for this tenant");
      }
      return res.json({ uploadUrl, objectPath });
    } catch (err) {
      return respondObjectStorageUnavailable(req, res, err, "photo upload");
    }
  },
);

// Verify and pin the upload before creating a short-lived server-issued receipt.
router.post(
  "/staged",
  requireAuth,
  denyViewers,
  stagedPhotoEntitlement,
  greenServiceCreationRole,
  async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const body = z.object({
      entityType: z.string().min(1).max(100),
      objectPath: z.string().min(1).max(500),
    }).parse(req.body);
    if (!isStagedPhotoEntityType(body.entityType)) {
      return res.status(400).json({ error: "Unsupported staged photo entity type" });
    }

    let normalizedPath: string;
    let finalized: { objectPath: string; contentType: AllowedUploadType };
    try {
      normalizedPath = storage.normalizeObjectEntityPath(body.objectPath);
      if (!isTenantReservedObjectPath(normalizedPath, clientId)) {
        throw new ObjectOwnershipError("Upload was not reserved for this tenant");
      }
      finalized = await storage.finalizeVerifiedTenantUpload(
        normalizedPath,
        clientId,
        ALLOWED_PHOTO_TYPES,
      );
    } catch (err) {
      await storage.discardTenantUpload(body.objectPath, clientId).catch(() => {});
      const mapped = photoStorageError(err);
      return res.status(mapped.status).json({ error: mapped.error });
    }

    const id = randomUUID();
    try {
      await db.execute(sql`
        INSERT INTO staged_photo_upload_receipts
          (id, client_id, entity_type, actor_id, object_path, expires_at)
        VALUES (
          ${id}::uuid, ${clientId}, ${body.entityType}, ${req.currentUser!.id},
          ${finalized.objectPath}, now() + interval '30 minutes'
        )
      `);
      return res.status(201).json({ id, objectPath: finalized.objectPath });
    } catch (err) {
      await storage.deleteTenantObject(finalized.objectPath, clientId).catch(() => {});
      return res.status(isPostgresUniqueViolation(err) ? 409 : 500).json({
        error: isPostgresUniqueViolation(err)
          ? "This photo upload has already been staged"
          : "Could not save staged photo receipt",
      });
    }
  },
);

router.post("/request-upload", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const body = z.object({
    entityType: z.string().min(1).max(100),
    entityId: z.number().int().positive(),
    name: z.string().min(1).max(200),
    contentType: z.enum(["image/jpeg", "image/png"], {
      message: "Photos must be JPEG or PNG",
    }),
  }).parse(req.body);

  if (await rejectUnownedPhotoEntity(res, body.entityType, body.entityId, clientId)) return;

  try {
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId, body.contentType);
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    res.json({ uploadUrl, objectPath });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "photo upload");
  }
});

// ── Save photo record after upload ────────────────────────────────────────────
// POST /photos
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const body = z.object({
    entityType: z.string().min(1).max(100),
    entityId: z.number().int().positive(),
    objectPath: z.string().min(1).max(500),
    caption: z.string().max(500).optional(),
  }).parse(req.body);
  if (await rejectUnownedPhotoEntity(res, body.entityType, body.entityId, clientId)) return;
  let objectPath: string;
  try {
    const normalizedPath = storage.normalizeObjectEntityPath(body.objectPath);
    if (!isTenantReservedObjectPath(normalizedPath, clientId)) {
      throw new ObjectOwnershipError("Upload was not reserved for this tenant");
    }
    // This storage primitive pins generation + metageneration, fully validates
    // the image, and copies exactly those bytes to a fresh immutable key before
    // applying the ACL. A still-live staging PUT cannot replace attached data.
    const finalized = await storage.finalizeVerifiedTenantUpload(
      normalizedPath,
      clientId,
      ALLOWED_PHOTO_TYPES,
    );
    objectPath = finalized.objectPath;
  } catch (err) {
    // Rejected uploads are still unfinalised. Best-effort deletion prevents
    // invalid bytes from accumulating; a foreign path is refused by this call.
    await storage.discardTenantUpload(body.objectPath, clientId).catch(() => {});
    const error = err instanceof ObjectNotFoundError ? "Uploaded object not found"
      : err instanceof ObjectContentError ? "Photo contents must be a valid JPEG or PNG"
      : err instanceof ObjectGenerationError ? err.message
      : err instanceof ObjectOwnershipError ? err.message : "Could not secure uploaded photo";
    return res.status(err instanceof ObjectNotFoundError ? 404
      : err instanceof ObjectContentError ? 400
      : err instanceof ObjectGenerationError ? 409 : 403).json({ error });
  }

  const result = await db.execute(sql`
    INSERT INTO check_photos (client_id, entity_type, entity_id, object_path, caption, created_by)
    VALUES (
      ${clientId},
      ${body.entityType},
      ${body.entityId},
      ${objectPath},
      ${body.caption ?? null},
      ${(req as any).user?.id ?? null}
    )
    RETURNING *
  `);

  res.status(201).json((result as any).rows[0]);
});

// ── List photos for a record ──────────────────────────────────────────────────
// GET /photos?entityType=&entityId=
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { entityType, entityId } = z.object({
    entityType: z.string().min(1),
    entityId: z.coerce.number().int().positive(),
  }).parse(req.query);
  if (await rejectUnownedPhotoEntity(res, entityType, entityId, clientId)) return;

  const result = await db.execute(sql`
    SELECT * FROM check_photos
    WHERE client_id = ${clientId}
      AND entity_type = ${entityType}
      AND entity_id = ${entityId}
    ORDER BY created_at ASC
  `);

  res.json((result as any).rows);
});

// ── Delete a photo ────────────────────────────────────────────────────────────
// DELETE /photos/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const deletion = await db.transaction(async (tx) => {
    const photo = await tx.execute(sql`
      SELECT object_path FROM check_photos
      WHERE id = ${id} AND client_id = ${clientId}
      FOR UPDATE
    `);
    const row = (photo as any).rows[0] as { object_path: string } | undefined;
    if (!row) return null;

    // Serialise lifecycle decisions for this tenant/path. Other attachment
    // deletion flows can use the same shared reference service and lock key.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`${clientId}:${row.object_path}`}))
    `);
    await tx.execute(sql`
      DELETE FROM check_photos WHERE id = ${id} AND client_id = ${clientId}
    `);
    const referenced = await hasTenantAttachmentReference(tx as any, clientId, row.object_path);
    return { objectPath: row.object_path, referenced };
  });
  if (!deletion) return res.status(404).json({ error: "Not found" });

  // A deleted parent can leave a polymorphic photo row behind. It is important
  // that users can still delete that row and its tenant-owned object, rather
  // than being blocked by parent validation as listing is.
  if (!deletion.referenced) {
    await storage.deleteTenantObject(deletion.objectPath, clientId).catch((err) => {
      if (!(err instanceof ObjectNotFoundError)) console.warn(`Photo object deletion failed for ${id}`, err);
    });
  }
  res.json({ ok: true });
});

// ── Photo requirements ────────────────────────────────────────────────────────
// GET /photos/requirements
router.get("/requirements", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const result = await db.execute(sql`
    SELECT * FROM photo_requirements WHERE client_id = ${clientId}
    ORDER BY entity_type
  `);

  res.json((result as any).rows);
});

// PUT /photos/requirements — upsert all at once
router.put("/requirements", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const items = z.array(z.object({
    entityType: z.string().min(1).max(100),
    required: z.boolean(),
    minPhotos: z.number().int().min(1).max(10).default(1),
  })).parse(req.body);

  await db.transaction(async (tx) => {
    for (const entityType of [...new Set(items.map((item) => item.entityType))].sort()) {
      await lockPhotoRequirement(tx as any, clientId, entityType);
    }
    for (const item of items) {
      await tx.execute(sql`
        INSERT INTO photo_requirements (client_id, entity_type, required, min_photos)
        VALUES (${clientId}, ${item.entityType}, ${item.required}, ${item.minPhotos})
        ON CONFLICT (client_id, entity_type)
        DO UPDATE SET
          required   = EXCLUDED.required,
          min_photos = EXCLUDED.min_photos,
          updated_at = now()
      `);
    }
  });

  res.json({ ok: true });
});

export default router;
