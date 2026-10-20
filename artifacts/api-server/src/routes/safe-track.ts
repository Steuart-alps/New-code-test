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
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import {
  ObjectContentError,
  ObjectStorageService,
  ObjectNotFoundError,
  ObjectOwnershipError,
  isTenantReservedObjectPath,
} from "../lib/objectStorage";
import { respondObjectStorageDownloadUnavailable, respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { sitesTableVisibleTo } from "../lib/departmentSites";

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function allowedSites(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(deptId)));
}

async function verifySite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return true;
  const [row] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!row;
}

/** True when a department-scoped caller may use this site (or no site). */
async function siteInDepartment(siteId: number | null | undefined, clientId: number, deptId: number | null) {
  if (siteId == null || deptId === null) return true;
  const [row] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId),
      sitesTableVisibleTo(deptId))).limit(1);
  return !!row;
}

/** Another department's record answers exactly like a missing one. */
async function recordInDepartment(table: any, id: number, clientId: number, deptId: number | null) {
  const [existing] = await db.select({ siteId: table.siteId }).from(table)
    .where(and(eq(table.id, id), eq(table.clientId, clientId))).limit(1);
  return !!existing && await siteInDepartment(existing.siteId, clientId, deptId);
}

async function verifyDepartment(departmentId: number | null | undefined, clientId: number) {
  if (departmentId == null) return true;
  const result = await db.execute(sql`SELECT id FROM departments WHERE id = ${departmentId} AND client_id = ${clientId} LIMIT 1`);
  return (result.rows ?? []).length > 0;
}

function deptCondition(table: any, clientId: number, deptId: number | null) {
  if (deptId === null) return [];
  return [or(isNull(table.siteId), inArray(table.siteId, allowedSites(clientId, deptId))) as any];
}

/**
 * Check the attachment is this tenant's upload and an allowed document type
 * by its own bytes (the stored and recorded type come from those bytes, not
 * the browser), then grant the tenant ACL. Returns the content type to record.
 */
async function finalizeSafeTrackDocument(objectPath: string, fileName: string | null | undefined, clientId: number) {
  const storage = new ObjectStorageService();
  const normalizedPath = storage.normalizeObjectEntityPath(objectPath);
  if (!isTenantReservedObjectPath(normalizedPath, clientId)) {
    throw new ObjectOwnershipError("Upload was not reserved for this tenant");
  }
  const contentType = await storage.verifyDocumentUpload(normalizedPath, fileName ?? "");
  await storage.finalizeTenantUpload(normalizedPath, clientId);
  return contentType.split(";")[0];
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

  sub.post("/", requireAuth, denyViewers, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const data = parsed.data as any;
    if (!(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
    if (!(await siteInDepartment(data.siteId, clientId, getActiveDepartmentId(req)))) return res.status(403).json({ error: "Site not accessible" });
    if (!(await verifyDepartment(data.departmentId, clientId))) return res.status(400).json({ error: "Invalid department" });
    if (data.objectPath) {
      try {
        data.mimeType = await finalizeSafeTrackDocument(data.objectPath, data.fileName, clientId);
      } catch (err) {
        const error = err instanceof ObjectNotFoundError ? "Uploaded object not found"
          : err instanceof ObjectContentError || err instanceof ObjectOwnershipError ? err.message
          : "Could not secure uploaded document";
        const status = err instanceof ObjectNotFoundError ? 404 : err instanceof ObjectContentError ? 400 : 403;
        return res.status(status).json({ error });
      }
    }
    const insertRows = await db.insert(table).values({ ...data, clientId, createdBy: req.currentUser?.id ?? null }).returning() as any[];
    const row = insertRows[0];
    res.status(201).json(row);
  });

  sub.put("/:id", requireAuth, denyViewers, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
    const data = parsed.data as any;
    if (!(await recordInDepartment(table, id, clientId, getActiveDepartmentId(req)))) return res.status(404).json({ error: "Not found" });
    if ("siteId" in data && !(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
    if ("siteId" in data && !(await siteInDepartment(data.siteId, clientId, getActiveDepartmentId(req)))) return res.status(403).json({ error: "Site not accessible" });
    if ("departmentId" in data && !(await verifyDepartment(data.departmentId, clientId))) return res.status(400).json({ error: "Invalid department" });
    if (data.objectPath) {
      try {
        data.mimeType = await finalizeSafeTrackDocument(data.objectPath, data.fileName, clientId);
      } catch (err) {
        const error = err instanceof ObjectNotFoundError ? "Uploaded object not found"
          : err instanceof ObjectContentError || err instanceof ObjectOwnershipError ? err.message
          : "Could not secure uploaded document";
        const status = err instanceof ObjectNotFoundError ? 404 : err instanceof ObjectContentError ? 400 : 403;
        return res.status(status).json({ error });
      }
    }
    const [row] = await db.update(table).set({ ...data, updatedAt: new Date() })
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  });

  sub.delete("/:id", requireAuth, denyViewers, async (req, res) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    if (!(await recordInDepartment(table, id, clientId, getActiveDepartmentId(req)))) return res.status(404).json({ error: "Not found" });
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
router.post("/request-upload", requireAuth, denyViewers, async (req, res) => {
  try {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const storage = new ObjectStorageService();
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId);
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    res.json({ uploadUrl, objectPath });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "SafeTrack document upload");
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
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "Document file not found" });
      if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: "Document file is not available for this account" });
      return respondObjectStorageDownloadUnavailable(req, res, err, "SafeTrack document download", {
        route: req.route?.path, recordId: id, clientId,
      });
    }
  };
}

// ── Acknowledgement helpers ───────────────────────────────────────────────────

// The signed-in user's active roster entries, matched by email as DocTrack
// does (staff_roster has no user_id). Callers treat more than one as ambiguous.
async function findOwnRosterEntries(clientId: number, email: string | null | undefined) {
  if (!email?.trim()) return [];
  const result = await db.execute(sql`
    SELECT id, name FROM staff_roster
    WHERE client_id = ${clientId} AND active = true
      AND email IS NOT NULL AND lower(btrim(email)) = lower(${email.trim()})
    LIMIT 2
  `);
  return (result.rows ?? []) as Array<{ id: number; name: string }>;
}

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
    // ?sinceId=<ack id> lets an open dialog poll for new rows without
    // re-downloading every drawn signature. The two-minute overlap covers rows
    // whose transaction started earlier but committed later; callers dedupe by
    // id. An unknown id falls back to the full list.
    const sinceId = parseInt(String(req.query.sinceId ?? ""));
    const since = Number.isInteger(sinceId) && sinceId > 0
      ? sql`AND acknowledged_at >= COALESCE((
          SELECT acknowledged_at - interval '2 minutes' FROM safe_track_acknowledgements
          WHERE id = ${sinceId} AND client_id = ${clientId}
        ), '-infinity'::timestamp)`
      : sql``;
    // acknowledged_by is whoever recorded the row (a manager for bulk sign-off);
    // acknowledged_by_me marks the signed-in user's own acknowledgement.
    const own = await findOwnRosterEntries(clientId, req.currentUser?.email);
    const ownRosterId = own.length === 1 ? Number(own[0].id) : null;
    const userId: number | null = req.currentUser?.id ?? null;
    const result = await db.execute(sql`
      SELECT id, staff_roster_id, staff_name, signature, acknowledged_at, acknowledged_by,
             COALESCE(
               staff_roster_id = ${ownRosterId}::integer
               OR (staff_roster_id IS NULL AND acknowledged_by = ${userId}::integer),
               false
             ) AS acknowledged_by_me
      FROM safe_track_acknowledgements
      WHERE document_id = ${id} AND document_type = ${docType} AND client_id = ${clientId}
      ${since}
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
    // Staff must be this business's active roster entries; the stored name is
    // the roster's, never the client-supplied one.
    const rosterIds = [...new Set(parsed.data.acknowledgements.map((ack) => ack.staffRosterId))];
    const rosterResult = await db.execute(sql`
      SELECT id, name FROM staff_roster
      WHERE client_id = ${clientId} AND active = true
        AND id IN (${sql.join(rosterIds.map((rosterId) => sql`${rosterId}`), sql`, `)})
    `);
    const rosterNames = new Map(((rosterResult.rows ?? []) as Array<{ id: number; name: string }>)
      .map((row) => [Number(row.id), String(row.name)]));
    if (rosterIds.some((rosterId) => !rosterNames.has(rosterId))) {
      return res.status(404).json({ error: "Staff member not found" });
    }
    const acknowledgedBy: number | null = req.currentUser?.id ?? null;
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
          (${clientId}, ${docType}, ${id}, ${ack.staffRosterId}, ${rosterNames.get(ack.staffRosterId)!}, ${ack.signature ?? null}, ${acknowledgedBy})
      `);
      created++;
    }
    res.json({ created });
  };
}

// ── Self-acknowledge (mobile) ─────────────────────────────────────────────────
// POST /safe-track/risk-assessments/:id/self-acknowledge  (and sops / handbook)
// The mobile staff member acknowledges a document for themselves — no staffRosterId needed.
// Identity comes from the session: the user's roster entry (by email, as
// DocTrack resolves it) so managers see it against that staff member; users
// with no roster entry are recorded by their account name.

function selfAckRoute(table: any, docType: string) {
  return async (req: any, res: any) => {
    const clientId = getClientId(req);
    if (!clientId) return res.status(400).json({ error: "No client context" });
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [doc] = await db.select({ id: table.id }).from(table)
      .where(and(eq(table.id, id), eq(table.clientId, clientId))).limit(1);
    if (!doc) return res.status(404).json({ error: "Not found" });

    const userId: number | null = req.currentUser?.id ?? null;
    const signature: string | null = req.body?.signature ?? null;
    const matches = await findOwnRosterEntries(clientId, req.currentUser?.email);
    if (matches.length > 1) return res.status(409).json({ error: "More than one active staff record uses your email. Ask an administrator to resolve this before signing." });
    const roster = matches[0] ?? null;
    const rosterId: number | null = roster ? Number(roster.id) : null;
    const staffName: string = roster ? String(roster.name) : (req.currentUser?.name || req.body?.staffName || "Unknown");

    // Already acknowledged by this staff member (or, without a roster entry, this user)?
    const existing = rosterId !== null
      ? await db.execute(sql`
          SELECT id FROM safe_track_acknowledgements
          WHERE document_id = ${id} AND document_type = ${docType}
            AND client_id = ${clientId} AND staff_roster_id = ${rosterId}
          LIMIT 1
        `)
      : userId
        ? await db.execute(sql`
            SELECT id FROM safe_track_acknowledgements
            WHERE document_id = ${id} AND document_type = ${docType}
              AND client_id = ${clientId} AND staff_roster_id IS NULL AND acknowledged_by = ${userId}
            LIMIT 1
          `)
        : { rows: [] };
    if (existing.rows.length) return res.json({ created: 0, alreadyAcknowledged: true });

    const inserted = await db.execute(sql`
      INSERT INTO safe_track_acknowledgements
        (client_id, document_type, document_id, staff_roster_id, staff_name, signature, acknowledged_by)
      VALUES
        (${clientId}, ${docType}, ${id}, ${rosterId}, ${staffName}, ${signature}, ${userId})
      ON CONFLICT (document_type, document_id, staff_roster_id)
        WHERE staff_roster_id IS NOT NULL
      DO NOTHING
      RETURNING id
    `);
    if (!inserted.rows.length) return res.json({ created: 0, alreadyAcknowledged: true });
    res.json({ created: 1, alreadyAcknowledged: false });
  };
}

// ── Risk Assessments ─────────────────────────────────────────────────────────

const signatureField = z.string().max(500000).nullable().optional();

const raCreate = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  assessedBy: z.string().max(200).nullable().optional(),
  // A cleared <input type="date"> sends "": treat it as no review date.
  reviewDate: z.preprocess((value) => (value === "" ? null : value), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()),
  status: z.enum(["draft", "published", "under_review"]).optional(),
  version: z.string().max(20).optional(),
  siteId: z.number().int().nullable().optional(),
  departmentId: z.number().int().nullable().optional(),
  signature: signatureField,
  requiresAcknowledgement: z.boolean().optional(),
}).merge(fileFields);

router.get("/risk-assessments/:id/download-url",    requireAuth, downloadUrlRoute(safeRiskAssessmentsTable));
router.get("/risk-assessments/:id/acknowledgements", requireAuth, ackListRoute(safeRiskAssessmentsTable, "ra"));
router.post("/risk-assessments/:id/acknowledge",     requireAuth, denyViewers, ackSaveRoute(safeRiskAssessmentsTable, "ra"));
router.post("/risk-assessments/:id/self-acknowledge", requireAuth, selfAckRoute(safeRiskAssessmentsTable, "ra"));
router.use("/risk-assessments", crudFor(safeRiskAssessmentsTable, raCreate, raCreate.partial()));

// ── SOPs ─────────────────────────────────────────────────────────────────────

const sopCreate = z.object({
  title: z.string().min(1).max(500),
  scope: z.string().max(1000).nullable().optional(),
  content: z.string().max(50000).nullable().optional(),
  version: z.string().max(20).optional(),
  // Drizzle timestamp columns need a Date, not the ISO string the web sends.
  publishedAt: z.string().datetime().nullable().optional().transform((value) => (value ? new Date(value) : value)),
  siteId: z.number().int().nullable().optional(),
  departmentId: z.number().int().nullable().optional(),
  signature: signatureField,
  requiresAcknowledgement: z.boolean().optional(),
}).merge(fileFields);

router.get("/sops/:id/download-url",    requireAuth, downloadUrlRoute(safeSopsTable));
router.get("/sops/:id/acknowledgements", requireAuth, ackListRoute(safeSopsTable, "sop"));
router.post("/sops/:id/acknowledge",     requireAuth, denyViewers, ackSaveRoute(safeSopsTable, "sop"));
router.post("/sops/:id/self-acknowledge", requireAuth, selfAckRoute(safeSopsTable, "sop"));
router.use("/sops", crudFor(safeSopsTable, sopCreate, sopCreate.partial()));

// ── Training Records ─────────────────────────────────────────────────────────

const trCreate = z.object({
  staffName: z.string().min(1).max(200),
  trainingType: z.string().min(1).max(300),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  departmentId: z.number().int().nullable().optional(),
});

router.use("/training-records", crudFor(safeTrainingRecordsTable, trCreate, trCreate.partial()));

// ── Inductions ───────────────────────────────────────────────────────────────

const indCreate = z.object({
  staffName: z.string().min(1).max(200),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // JSON checklist (24 sections with free-text comments); the column is text.
  checklist: z.string().max(100000).nullable().optional(),
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
  // Drizzle timestamp columns need a Date, not the ISO string the web sends.
  publishedAt: z.string().datetime().nullable().optional().transform((value) => (value ? new Date(value) : value)),
  siteId: z.number().int().nullable().optional(),
  signature: signatureField,
  requiresAcknowledgement: z.boolean().optional(),
}).merge(fileFields);

router.get("/handbook/:id/download-url",    requireAuth, downloadUrlRoute(safeHandbookTable));
router.get("/handbook/:id/acknowledgements", requireAuth, ackListRoute(safeHandbookTable, "handbook"));
router.post("/handbook/:id/acknowledge",     requireAuth, denyViewers, ackSaveRoute(safeHandbookTable, "handbook"));
router.post("/handbook/:id/self-acknowledge", requireAuth, selfAckRoute(safeHandbookTable, "handbook"));
router.use("/handbook", crudFor(safeHandbookTable, handbookCreate, handbookCreate.partial()));

export default router;
