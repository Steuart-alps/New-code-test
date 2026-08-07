import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();
const storage = new ObjectStorageService();

export const CATEGORIES = ["risk_assessment", "sop", "handbook", "policy", "procedure", "other"] as const;

const docCreate = z.object({
  title: z.string().min(1).max(500),
  category: z.enum(CATEGORIES),
  description: z.string().max(5000).nullable().optional(),
  fileName: z.string().min(1).max(500),
  fileSize: z.number().int().positive().nullable().optional(),
  mimeType: z.string().min(1).max(200),
  objectPath: z.string().min(1).max(2000),
  siteId: z.number().int().nullable().optional(),
  uploadedBy: z.string().max(200).nullable().optional(),
  requiresAcknowledgement: z.boolean().optional(),
  department: z.string().max(200).nullable().optional(),
});

const docUpdate = z.object({
  title: z.string().min(1).max(500).optional(),
  category: z.enum(CATEGORIES).optional(),
  description: z.string().max(5000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  requiresAcknowledgement: z.boolean().optional(),
  department: z.string().max(200).nullable().optional(),
});

// ── List documents ────────────────────────────────────────────────────────────

router.get("/documents", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { category, siteId, q } = req.query as any;

  const result = await db.execute(sql`
    SELECT d.id, d.client_id, d.site_id, d.title, d.category, d.description,
           d.file_name, d.file_size, d.mime_type, d.object_path, d.uploaded_by,
           d.requires_acknowledgement, d.department, d.created_at, d.updated_at,
           s.name AS site_name
    FROM doc_track_documents d
    LEFT JOIN sites s ON d.site_id = s.id
    WHERE d.client_id = ${clientId}
    ORDER BY d.created_at DESC
  `);

  let rows = (result.rows ?? []) as any[];
  if (category) rows = rows.filter((r: any) => r.category === category);
  if (siteId) rows = rows.filter((r: any) => r.site_id === Number(siteId));
  if (q) {
    const lower = (q as string).toLowerCase();
    rows = rows.filter((r: any) => (r.title as string).toLowerCase().includes(lower));
  }

  res.json(rows);
});

// ── Create document record ────────────────────────────────────────────────────

router.post("/documents", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = docCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { title, category, description, fileName, fileSize, mimeType, objectPath, siteId, uploadedBy, requiresAcknowledgement, department } = parsed.data;
  const createdBy = (req.session as any).userId ?? null;

  const result = await db.execute(sql`
    INSERT INTO doc_track_documents
      (client_id, site_id, title, category, description, file_name, file_size,
       mime_type, object_path, uploaded_by, created_by, requires_acknowledgement, department)
    VALUES
      (${clientId}, ${siteId ?? null}, ${title}, ${category}, ${description ?? null},
       ${fileName}, ${fileSize ?? null}, ${mimeType}, ${objectPath},
       ${uploadedBy ?? null}, ${createdBy}, ${requiresAcknowledgement ?? false},
       ${department ?? null})
    RETURNING *
  `);

  res.status(201).json((result.rows ?? [])[0]);
});

// ── Update document metadata ───────────────────────────────────────────────────

router.patch("/documents/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = docUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { title, category, description, siteId, requiresAcknowledgement, department } = parsed.data;
  const hasDesc = description !== undefined;
  const hasSite = siteId !== undefined;
  const hasAck  = requiresAcknowledgement !== undefined;
  const hasDept = department !== undefined;

  await db.execute(sql`
    UPDATE doc_track_documents
    SET title                    = COALESCE(${title ?? null}, title),
        category                 = COALESCE(${category ?? null}, category),
        description              = CASE WHEN ${hasDesc}::boolean THEN ${description ?? null} ELSE description END,
        site_id                  = CASE WHEN ${hasSite}::boolean THEN ${siteId ?? null} ELSE site_id END,
        requires_acknowledgement = CASE WHEN ${hasAck}::boolean  THEN ${requiresAcknowledgement ?? false} ELSE requires_acknowledgement END,
        department               = CASE WHEN ${hasDept}::boolean THEN ${department ?? null} ELSE department END,
        updated_at               = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);

  const result = await db.execute(sql`
    SELECT d.*, s.name AS site_name
    FROM doc_track_documents d
    LEFT JOIN sites s ON d.site_id = s.id
    WHERE d.id = ${id} AND d.client_id = ${clientId}
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Delete document ───────────────────────────────────────────────────────────

router.delete("/documents/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  await db.execute(sql`
    DELETE FROM doc_track_documents
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.status(204).end();
});

// ── List acknowledgements for a document ─────────────────────────────────────

router.get("/documents/:id/acknowledgements", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const docId = parseInt(req.params.id as string);
  if (isNaN(docId)) return res.status(400).json({ error: "Invalid id" });

  // Verify document belongs to this client
  const docCheck = await db.execute(sql`
    SELECT id FROM doc_track_documents WHERE id = ${docId} AND client_id = ${clientId} LIMIT 1
  `);
  if (!(docCheck.rows ?? [])[0]) return res.status(404).json({ error: "Not found" });

  const result = await db.execute(sql`
    SELECT a.id, a.document_id, a.staff_roster_id, a.staff_name, a.signature,
           a.acknowledged_at, a.train_track_record_id,
           u.name AS acknowledged_by_name
    FROM doc_acknowledgements a
    LEFT JOIN users u ON a.acknowledged_by = u.id
    WHERE a.document_id = ${docId} AND a.client_id = ${clientId}
    ORDER BY a.staff_name ASC
  `);

  res.json(result.rows ?? []);
});

// ── Record acknowledgements ───────────────────────────────────────────────────

const ackCreate = z.object({
  acknowledgements: z.array(z.object({
    staffRosterId: z.number().int(),
    staffName: z.string().min(1).max(300),
    signature: z.string().max(300).nullable().optional(),
  })).min(1),
});

router.post("/documents/:id/acknowledge", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const docId = parseInt(req.params.id as string);
  if (isNaN(docId)) return res.status(400).json({ error: "Invalid id" });

  const parsed = ackCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  // Verify document belongs to this client
  const docResult = await db.execute(sql`
    SELECT id, title, category, site_id FROM doc_track_documents
    WHERE id = ${docId} AND client_id = ${clientId}
    LIMIT 1
  `);
  const doc = (docResult.rows ?? [])[0] as any;
  if (!doc) return res.status(404).json({ error: "Not found" });

  const userId = (req.session as any).userId ?? null;
  const today = new Date().toISOString().split("T")[0];
  const created: any[] = [];

  for (const ack of parsed.data.acknowledgements) {
    // Skip if already acknowledged
    const existing = await db.execute(sql`
      SELECT id FROM doc_acknowledgements
      WHERE document_id = ${docId} AND staff_roster_id = ${ack.staffRosterId}
      LIMIT 1
    `);
    if ((existing.rows ?? []).length > 0) continue;

    // Create TrainTrack signoff record
    const trainResult = await db.execute(sql`
      INSERT INTO train_track_records
        (client_id, site_id, record_type, staff_name, document_title,
         document_type, completed_date, notes, signature)
      VALUES
        (${clientId}, ${doc.site_id ?? null}, 'signoff', ${ack.staffName},
         ${doc.title}, ${doc.category}, ${today}::date,
         ${'Document acknowledgement via DocTrack'},
         ${ack.signature ?? null})
      RETURNING id
    `);
    const trainId = ((trainResult.rows ?? [])[0] as any)?.id ?? null;

    // Create acknowledgement record
    const ackResult = await db.execute(sql`
      INSERT INTO doc_acknowledgements
        (document_id, client_id, staff_roster_id, staff_name, signature,
         acknowledged_by, train_track_record_id)
      VALUES
        (${docId}, ${clientId}, ${ack.staffRosterId}, ${ack.staffName},
         ${ack.signature ?? null}, ${userId}, ${trainId})
      RETURNING *
    `);
    if ((ackResult.rows ?? [])[0]) created.push((ackResult.rows ?? [])[0]);
  }

  res.status(201).json({ created: created.length, records: created });
});

// ── Get sign-off link token ───────────────────────────────────────────────────

router.get("/sign-off-info", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const result = await db.execute(sql`
    SELECT sign_off_token FROM clients WHERE id = ${clientId} LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as any;
  if (!row?.sign_off_token) return res.status(404).json({ error: "No sign-off token found" });

  res.json({ token: row.sign_off_token });
});

// ── Request presigned upload URL ──────────────────────────────────────────────

router.post("/documents/request-upload", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  z.object({
    name: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
  }).parse(req.body); // validate — name/contentType not used server-side

  try {
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    res.json({ uploadUrl, objectPath });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate upload URL", detail: err?.message });
  }
});

// ── Get signed download URL ───────────────────────────────────────────────────

router.get("/documents/:id/download-url", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const result = await db.execute(sql`
    SELECT object_path, file_name FROM doc_track_documents
    WHERE id = ${id} AND client_id = ${clientId}
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as any;
  if (!row) return res.status(404).json({ error: "Not found" });

  try {
    const downloadUrl = await storage.getSignedDownloadURL(row.object_path);
    res.json({ downloadUrl, fileName: row.file_name });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate download URL", detail: err?.message });
  }
});

export default router;
