import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId, denyViewers } from "../middleware/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();
const storage = new ObjectStorageService();

// ── Request presigned upload URL ──────────────────────────────────────────────
// POST /photos/request-upload
router.post("/request-upload", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  z.object({
    entityType: z.string().min(1).max(100),
    entityId: z.number().int().positive(),
    name: z.string().min(1).max(200),
    contentType: z.string().min(1).max(100).refine(t => t.startsWith("image/"), {
      message: "Only image uploads are allowed",
    }),
  }).parse(req.body);

  try {
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    await storage.trySetObjectEntityAclPolicy(uploadUrl, {
      owner: String(clientId),
      visibility: "private",
    });
    res.json({ uploadUrl, objectPath });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate upload URL", detail: err?.message });
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

  const result = await db.execute(sql`
    INSERT INTO check_photos (client_id, entity_type, entity_id, object_path, caption, created_by)
    VALUES (
      ${clientId},
      ${body.entityType},
      ${body.entityId},
      ${body.objectPath},
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

  const result = await db.execute(sql`
    DELETE FROM check_photos
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING id
  `);

  if (!(result as any).rows[0]) return res.status(404).json({ error: "Not found" });
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
router.put("/requirements", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const items = z.array(z.object({
    entityType: z.string().min(1).max(100),
    required: z.boolean(),
    minPhotos: z.number().int().min(1).max(10).default(1),
  })).parse(req.body);

  for (const item of items) {
    await db.execute(sql`
      INSERT INTO photo_requirements (client_id, entity_type, required, min_photos)
      VALUES (${clientId}, ${item.entityType}, ${item.required}, ${item.minPhotos})
      ON CONFLICT (client_id, entity_type)
      DO UPDATE SET
        required   = EXCLUDED.required,
        min_photos = EXCLUDED.min_photos,
        updated_at = now()
    `);
  }

  res.json({ ok: true });
});

export default router;
