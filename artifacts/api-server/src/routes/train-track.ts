import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

export const RECORD_TYPES = ["certificate", "signoff", "internal"] as const;
export type RecordType = typeof RECORD_TYPES[number];

export const CERTIFICATE_TRAINING_TYPES = [
  "Fire Safety Awareness",
  "Food Hygiene (Level 2)",
  "Food Hygiene (Level 3)",
  "Manual Handling",
  "First Aid at Work",
  "Emergency First Aid at Work",
  "COSHH Awareness",
  "Health & Safety Induction",
  "Working at Height",
  "RIDDOR Awareness",
  "Asbestos Awareness",
  "Display Screen Equipment (DSE)",
  "Other",
] as const;

export const DOCUMENT_TYPES = [
  "risk_assessment",
  "sop",
  "policy",
  "procedure",
  "other",
] as const;

const signatureField = z.string().max(500000).nullable().optional(); // base64 PNG

const recordCreate = z.discriminatedUnion("recordType", [
  // External training certificate
  z.object({
    recordType: z.literal("certificate"),
    staffName: z.string().min(1).max(300),
    trainingType: z.string().min(1).max(300),
    provider: z.string().min(1).max(300),
    completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    siteId: z.number().int().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    signature: signatureField,
  }),
  // Document sign-off
  z.object({
    recordType: z.literal("signoff"),
    staffName: z.string().min(1).max(300),
    documentTitle: z.string().min(1).max(500),
    documentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
    completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    siteId: z.number().int().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    signature: signatureField,
  }),
  // Internal training / equipment demo
  z.object({
    recordType: z.literal("internal"),
    staffName: z.string().min(1).max(300),
    trainingType: z.string().min(1).max(300),
    trainer: z.string().min(1).max(300),
    completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    siteId: z.number().int().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    signature: signatureField,
  }),
]);

const recordUpdate = z.object({
  staffName: z.string().min(1).max(300).optional(),
  trainingType: z.string().min(1).max(300).nullable().optional(),
  documentTitle: z.string().min(1).max(500).nullable().optional(),
  documentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
  provider: z.string().min(1).max(300).nullable().optional(),
  trainer: z.string().min(1).max(300).nullable().optional(),
  completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  signature: signatureField,
});

// ── List records ──────────────────────────────────────────────────────────────

router.get("/records", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { recordType, siteId, q } = req.query as any;

  const result = await db.execute(sql`
    SELECT r.id, r.client_id, r.site_id, r.record_type,
           r.staff_name, r.training_type, r.document_title, r.document_type,
           r.provider, r.trainer,
           r.completed_date, r.expiry_date, r.notes,
           r.created_at, r.updated_at,
           s.name AS site_name
    FROM train_track_records r
    LEFT JOIN sites s ON r.site_id = s.id
    WHERE r.client_id = ${clientId}
    ORDER BY r.expiry_date ASC NULLS LAST, r.completed_date DESC, r.staff_name ASC
  `);

  let rows = (result.rows ?? []) as any[];

  if (recordType) rows = rows.filter((r: any) => r.record_type === recordType);
  if (siteId)     rows = rows.filter((r: any) => r.site_id === Number(siteId));
  if (q) {
    const lower = (q as string).toLowerCase();
    rows = rows.filter((r: any) =>
      (r.staff_name as string).toLowerCase().includes(lower) ||
      (r.training_type ?? "").toLowerCase().includes(lower) ||
      (r.document_title ?? "").toLowerCase().includes(lower) ||
      (r.provider ?? "").toLowerCase().includes(lower) ||
      (r.trainer ?? "").toLowerCase().includes(lower)
    );
  }

  res.json(rows);
});

// ── Create record ─────────────────────────────────────────────────────────────

router.post("/records", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = recordCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const d = parsed.data;
  const trainingType = "trainingType" in d ? d.trainingType : null;
  const documentTitle = "documentTitle" in d ? d.documentTitle : null;
  const documentType = "documentType" in d ? (d.documentType ?? null) : null;
  const provider = "provider" in d ? d.provider : null;
  const trainer = "trainer" in d ? d.trainer : null;
  const expiryDate = "expiryDate" in d ? (d.expiryDate ?? null) : null;

  const result = await db.execute(sql`
    INSERT INTO train_track_records
      (client_id, site_id, record_type, staff_name, training_type,
       document_title, document_type, provider, trainer,
       completed_date, expiry_date, notes)
    VALUES
      (${clientId}, ${d.siteId ?? null}, ${d.recordType}, ${d.staffName},
       ${trainingType}, ${documentTitle}, ${documentType},
       ${provider}, ${trainer},
       ${d.completedDate}::date, ${expiryDate}::date, ${d.notes ?? null})
    RETURNING *
  `);

  res.status(201).json((result.rows ?? [])[0]);
});

// ── Update record ─────────────────────────────────────────────────────────────

router.patch("/records/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = recordUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const {
    staffName, trainingType, documentTitle, documentType, provider, trainer,
    completedDate, expiryDate, siteId, notes,
  } = parsed.data;

  const hasExpiry   = expiryDate !== undefined;
  const hasSite     = siteId !== undefined;
  const hasNotes    = notes !== undefined;
  const hasDocType  = documentType !== undefined;
  const hasProvider = provider !== undefined;
  const hasTrainer  = trainer !== undefined;
  const hasDocTitle = documentTitle !== undefined;
  const hasTrainType = trainingType !== undefined;

  await db.execute(sql`
    UPDATE train_track_records
    SET staff_name     = COALESCE(${staffName ?? null}, staff_name),
        training_type  = CASE WHEN ${hasTrainType}::boolean  THEN ${trainingType ?? null}  ELSE training_type  END,
        document_title = CASE WHEN ${hasDocTitle}::boolean   THEN ${documentTitle ?? null} ELSE document_title END,
        document_type  = CASE WHEN ${hasDocType}::boolean    THEN ${documentType ?? null}  ELSE document_type  END,
        provider       = CASE WHEN ${hasProvider}::boolean   THEN ${provider ?? null}      ELSE provider       END,
        trainer        = CASE WHEN ${hasTrainer}::boolean     THEN ${trainer ?? null}       ELSE trainer        END,
        completed_date = CASE WHEN ${completedDate ?? null} IS NOT NULL
                              THEN ${completedDate ?? null}::date ELSE completed_date END,
        expiry_date    = CASE WHEN ${hasExpiry}::boolean  THEN ${expiryDate ?? null}::date  ELSE expiry_date   END,
        site_id        = CASE WHEN ${hasSite}::boolean    THEN ${siteId ?? null}            ELSE site_id       END,
        notes          = CASE WHEN ${hasNotes}::boolean   THEN ${notes ?? null}             ELSE notes         END,
        updated_at     = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);

  const upd = await db.execute(sql`
    SELECT r.*, s.name AS site_name
    FROM train_track_records r
    LEFT JOIN sites s ON r.site_id = s.id
    WHERE r.id = ${id} AND r.client_id = ${clientId}
    LIMIT 1
  `);
  const row = (upd.rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Delete record ─────────────────────────────────────────────────────────────

router.delete("/records/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  await db.execute(sql`
    DELETE FROM train_track_records
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.status(204).end();
});

export default router;
