import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  safeRiskAssessmentsTable,
  safeSopsTable,
  safeTrainingRecordsTable,
  safeInductionsTable,
  safeCompetencySignoffsTable,
  safeHandbookTable,
  sitesTable,
} from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function allowedSites(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId))));
}

async function verifySite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return true;
  const [row] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!row;
}

function deptCondition(table: any, clientId: number, deptId: number | null) {
  if (deptId === null) return [];
  return [or(isNull(table.siteId), inArray(table.siteId, allowedSites(clientId, deptId))) as any];
}

function crudFor<T extends { clientId: number; siteId?: number | null }>(
  table: any,
  createSchema: z.ZodTypeAny,
  updateSchema: z.ZodTypeAny,
) {
  const sub = Router();

  sub.get("/", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const deptId = getActiveDepartmentId(req);
    const rows = await db.select().from(table)
      .where(and(eq(table.clientId, clientId), ...deptCondition(table, clientId, deptId)))
      .orderBy(desc(table.createdAt));
    res.json(rows);
  });

  sub.post("/", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const data = parsed.data as any;
    if (!(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
    const insertRows = await db.insert(table).values({ ...data, clientId, createdBy: (req.session as any).userId ?? null }).returning() as any[];
    const row = insertRows[0];
    res.status(201).json(row);
  });

  sub.put("/:id", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const data = parsed.data as any;
    if ("siteId" in data && !(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
    const [row] = await db.update(table).set({ ...data, updatedAt: new Date() })
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });

  sub.delete("/:id", requireAuth, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [existing] = await db.select({ id: table.id }).from(table)
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });
    await db.delete(table).where(and(eq(table.id, id), eq(table.clientId, clientId)));
    res.status(204).end();
  });

  return sub;
}

// ── File attachment helpers ───────────────────────────────────────────────────

const fileFields = z.object({
  objectPath: z.string().max(2000).nullable().optional(),
  fileName: z.string().max(500).nullable().optional(),
  fileSize: z.number().int().nullable().optional(),
  mimeType: z.string().max(200).nullable().optional(),
});

// Shared presigned upload URL endpoint
router.post("/request-upload", requireAuth, async (req, res) => {
  try {
    const storage = new ObjectStorageService();
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    res.json({ uploadUrl, objectPath });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate upload URL", detail: err?.message });
  }
});

// Generic download-url handler factory
function downloadUrlRoute(table: any) {
  return async (req: any, res: any) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [row] = await db.select().from(table)
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).limit(1);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!row.objectPath) return res.status(404).json({ error: "No file attached" });
    try {
      const storage = new ObjectStorageService();
      const downloadUrl = await storage.getSignedDownloadURL(row.objectPath);
      res.json({ downloadUrl, fileName: row.fileName });
    } catch (err: any) {
      res.status(500).json({ error: "Could not generate download URL", detail: err?.message });
    }
  };
}

// ── Acknowledgement helpers ───────────────────────────────────────────────────

const ackSaveSchema = z.object({
  acknowledgements: z.array(z.object({
    staffRosterId: z.number().int(),
    staffName: z.string().max(200),
    signature: z.string().max(500).nullable().optional(),
  })).min(1).max(500),
});

function ackListRoute(table: any, docType: string) {
  return async (req: any, res: any) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [doc] = await db.select({ id: table.id }).from(table)
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).limit(1);
    if (!doc) return res.status(404).json({ error: "Not found" });
    const result = await db.execute(sql`
      SELECT id, staff_roster_id, staff_name, signature, acknowledged_at
      FROM safe_track_acknowledgements
      WHERE document_id = ${id} AND document_type = ${docType} AND client_id = ${clientId}
      ORDER BY acknowledged_at ASC
    `);
    res.json(result.rows);
  };
}

function ackSaveRoute(table: any, docType: string) {
  return async (req: any, res: any) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const parsed = ackSaveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const [doc] = await db.select({ id: table.id }).from(table)
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).limit(1);
    if (!doc) return res.status(404).json({ error: "Not found" });
    const acknowledgedBy: number | null = (req.session as any).userId ?? null;
    let created = 0;
    for (const ack of parsed.data.acknowledgements) {
      // Idempotent — skip already acknowledged
      const existing = await db.execute(sql`
        SELECT id FROM safe_track_acknowledgements
        WHERE document_id = ${id} AND document_type = ${docType}
          AND staff_roster_id = ${ack.staffRosterId} AND client_id = ${clientId}
        LIMIT 1
      `);
      if (existing.rows.length) continue;
      await db.execute(sql`
        INSERT INTO safe_track_acknowledgements
          (client_id, document_type, document_id, staff_roster_id, staff_name, signature, acknowledged_by)
        VALUES
          (${clientId}, ${docType}, ${id}, ${ack.staffRosterId}, ${ack.staffName}, ${ack.signature ?? null}, ${acknowledgedBy})
      `);
      created++;
    }
    res.json({ created });
  };
}

// ── Risk Assessments ─────────────────────────────────────────────────────────

const signatureField = z.string().max(500000).nullable().optional();

const raCreate = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  assessedBy: z.string().max(200).nullable().optional(),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(["draft", "published", "under_review"]).optional(),
  version: z.string().max(20).optional(),
  siteId: z.number().int().nullable().optional(),
  signature: signatureField,
  requiresAcknowledgement: z.boolean().optional(),
}).merge(fileFields);

router.get("/risk-assessments/:id/download-url",    requireAuth, downloadUrlRoute(safeRiskAssessmentsTable));
router.get("/risk-assessments/:id/acknowledgements", requireAuth, ackListRoute(safeRiskAssessmentsTable, "ra"));
router.post("/risk-assessments/:id/acknowledge",     requireAuth, ackSaveRoute(safeRiskAssessmentsTable, "ra"));
router.use("/risk-assessments", crudFor(safeRiskAssessmentsTable, raCreate, raCreate.partial()));

// ── SOPs ─────────────────────────────────────────────────────────────────────

const sopCreate = z.object({
  title: z.string().min(1).max(500),
  scope: z.string().max(1000).nullable().optional(),
  content: z.string().max(50000).nullable().optional(),
  version: z.string().max(20).optional(),
  publishedAt: z.string().datetime().nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  signature: signatureField,
  requiresAcknowledgement: z.boolean().optional(),
}).merge(fileFields);

router.get("/sops/:id/download-url",    requireAuth, downloadUrlRoute(safeSopsTable));
router.get("/sops/:id/acknowledgements", requireAuth, ackListRoute(safeSopsTable, "sop"));
router.post("/sops/:id/acknowledge",     requireAuth, ackSaveRoute(safeSopsTable, "sop"));
router.use("/sops", crudFor(safeSopsTable, sopCreate, sopCreate.partial()));

// ── Training Records ─────────────────────────────────────────────────────────

const trCreate = z.object({
  staffName: z.string().min(1).max(200),
  trainingType: z.string().min(1).max(300),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/training-records", crudFor(safeTrainingRecordsTable, trCreate, trCreate.partial()));

// ── Inductions ───────────────────────────────────────────────────────────────

const indCreate = z.object({
  staffName: z.string().min(1).max(200),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  checklist: z.string().max(10000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/inductions", crudFor(safeInductionsTable, indCreate, indCreate.partial()));

// ── Competency Sign-offs ─────────────────────────────────────────────────────

const compCreate = z.object({
  staffName: z.string().min(1).max(200),
  taskName: z.string().min(1).max(300),
  signedOffBy: z.string().min(1).max(200),
  signedOffAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.use("/competency", crudFor(safeCompetencySignoffsTable, compCreate, compCreate.partial()));

// ── Staff Handbook ────────────────────────────────────────────────────────────

const handbookCreate = z.object({
  title: z.string().min(1).max(500),
  section: z.string().max(300).nullable().optional(),
  content: z.string().max(50000).nullable().optional(),
  version: z.string().max(20).optional(),
  publishedAt: z.string().datetime().nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  signature: signatureField,
  requiresAcknowledgement: z.boolean().optional(),
}).merge(fileFields);

router.get("/handbook/:id/download-url",    requireAuth, downloadUrlRoute(safeHandbookTable));
router.get("/handbook/:id/acknowledgements", requireAuth, ackListRoute(safeHandbookTable, "handbook"));
router.post("/handbook/:id/acknowledge",     requireAuth, ackSaveRoute(safeHandbookTable, "handbook"));
router.use("/handbook", crudFor(safeHandbookTable, handbookCreate, handbookCreate.partial()));

export default router;
