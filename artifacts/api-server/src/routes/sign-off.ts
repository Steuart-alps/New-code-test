import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();
const storage = new ObjectStorageService();

// ── Helper: resolve client from sign-off token ────────────────────────────────
async function resolveClient(token: string): Promise<{ id: number; name: string } | null> {
  if (!token || token.length < 8) return null;
  const result = await db.execute(sql`
    SELECT id, name FROM clients WHERE sign_off_token = ${token} LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as any;
  return row ? { id: row.id, name: row.name } : null;
}

// GET /api/sign-off/:token/info
router.get("/:token/info", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });
    res.json({ clientName: client.name });
  } catch (err: any) {
    res.status(500).json({ error: "Server error", detail: err?.message });
  }
});

// GET /api/sign-off/:token/departments
router.get("/:token/departments", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const result = await db.execute(sql`
      SELECT DISTINCT department FROM staff_roster
      WHERE client_id = ${client.id} AND active = true AND department IS NOT NULL
      ORDER BY department ASC
    `);
    res.json((result.rows ?? []).map((r: any) => r.department as string));
  } catch (err: any) {
    res.status(500).json({ error: "Server error", detail: err?.message });
  }
});

// GET /api/sign-off/:token/staff?department=X
router.get("/:token/staff", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const { department } = req.query as { department?: string };

    const result = department
      ? await db.execute(sql`
          SELECT id, name, job_title, department FROM staff_roster
          WHERE client_id = ${client.id} AND active = true AND department = ${department}
          ORDER BY name ASC
        `)
      : await db.execute(sql`
          SELECT id, name, job_title, department FROM staff_roster
          WHERE client_id = ${client.id} AND active = true
          ORDER BY name ASC
        `);

    res.json(result.rows ?? []);
  } catch (err: any) {
    res.status(500).json({ error: "Server error", detail: err?.message });
  }
});

// GET /api/sign-off/:token/documents?department=X&staffId=Y
router.get("/:token/documents", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const { department, staffId } = req.query as { department?: string; staffId?: string };
    const staffIdNum = staffId ? parseInt(staffId) : null;

    // Docs where department matches OR is null (applies to all departments)
    const result = await db.execute(sql`
      SELECT d.id, d.title, d.category, d.description, d.file_name, d.department,
             d.created_at,
             CASE WHEN a.id IS NOT NULL THEN true ELSE false END AS signed,
             a.acknowledged_at, a.signature AS ack_signature
      FROM doc_track_documents d
      LEFT JOIN doc_acknowledgements a
        ON a.document_id = d.id AND a.client_id = ${client.id}
        AND a.staff_roster_id = ${staffIdNum}
      WHERE d.client_id = ${client.id}
        AND d.requires_acknowledgement = true
        AND (
          ${department ? sql`(d.department = ${department} OR d.department IS NULL)` : sql`true`}
        )
      ORDER BY d.created_at DESC
    `);

    res.json(result.rows ?? []);
  } catch (err: any) {
    res.status(500).json({ error: "Server error", detail: err?.message });
  }
});

// GET /api/sign-off/:token/documents/:docId/download
router.get("/:token/documents/:docId/download", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const docId = parseInt(req.params.docId);
    if (isNaN(docId)) return res.status(400).json({ error: "Invalid id" });

    const result = await db.execute(sql`
      SELECT object_path, file_name FROM doc_track_documents
      WHERE id = ${docId} AND client_id = ${client.id} AND requires_acknowledgement = true
      LIMIT 1
    `);
    const row = (result.rows ?? [])[0] as any;
    if (!row) return res.status(404).json({ error: "Not found" });

    const downloadUrl = await storage.getSignedDownloadURL(row.object_path);
    res.json({ downloadUrl, fileName: row.file_name });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate download URL", detail: err?.message });
  }
});

// POST /api/sign-off/:token/acknowledge
const ackSchema = z.object({
  documentId: z.number().int(),
  staffRosterId: z.number().int(),
  staffName: z.string().min(1).max(300),
  signature: z.string().max(500_000).nullable().optional(), // base64 PNG from canvas
  typedName: z.string().max(300).nullable().optional(),
});

router.post("/:token/acknowledge", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const parsed = ackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

    const { documentId, staffRosterId, staffName, signature, typedName } = parsed.data;

    const docResult = await db.execute(sql`
      SELECT id, title, category, site_id FROM doc_track_documents
      WHERE id = ${documentId} AND client_id = ${client.id} AND requires_acknowledgement = true
      LIMIT 1
    `);
    const doc = (docResult.rows ?? [])[0] as any;
    if (!doc) return res.status(404).json({ error: "Document not found" });

    // Idempotent — return 200 if already acknowledged
    const existing = await db.execute(sql`
      SELECT id FROM doc_acknowledgements
      WHERE document_id = ${documentId} AND staff_roster_id = ${staffRosterId}
      LIMIT 1
    `);
    if ((existing.rows ?? []).length > 0) {
      return res.status(200).json({ alreadySigned: true });
    }

    const today = new Date().toISOString().split("T")[0];
    const signatureValue = signature ?? typedName ?? null;

    // Create TrainTrack signoff record
    const trainResult = await db.execute(sql`
      INSERT INTO train_track_records
        (client_id, site_id, record_type, staff_name, document_title,
         document_type, completed_date, notes, signature)
      VALUES
        (${client.id}, ${doc.site_id ?? null}, 'signoff', ${staffName},
         ${doc.title}, ${doc.category}, ${today}::date,
         ${"Document acknowledgement (staff self-sign)"},
         ${signatureValue})
      RETURNING id
    `);
    const trainId = ((trainResult.rows ?? [])[0] as any)?.id ?? null;

    const ackResult = await db.execute(sql`
      INSERT INTO doc_acknowledgements
        (document_id, client_id, staff_roster_id, staff_name, signature, train_track_record_id)
      VALUES
        (${documentId}, ${client.id}, ${staffRosterId}, ${staffName},
         ${signatureValue}, ${trainId})
      RETURNING id, acknowledged_at
    `);

    res.status(201).json((ackResult.rows ?? [])[0]);
  } catch (err: any) {
    res.status(500).json({ error: "Server error", detail: err?.message });
  }
});

export default router;
