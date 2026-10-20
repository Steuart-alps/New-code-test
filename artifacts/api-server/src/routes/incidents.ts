import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  incidentsTable, incidentRiddorEventsTable, sitesTable, appSettingsTable, usersTable,
  INCIDENT_STATUSES, INCIDENT_SEVERITIES, EMPLOYMENT_TYPES, RIDDOR_CATEGORIES,
} from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEffectiveOptionList } from "../lib/formOptions";
import { appendAuditEvent } from "../lib/audit";
import { clientEntryFrom, clientEntryIdSchema, isUniqueViolation, respondToStoredEntry } from "../lib/clientEntryReplay";
import { isReportableRiddorCategory, withRiddorDeadline } from "../lib/riddor";
import { canReadHealthData, RIDDOR_RECEIPT_TYPES } from "../lib/riddorReceipts";
import { siteVisibleToDepartment, sitesTableVisibleTo, visibleSiteIdsSql } from "../lib/departmentSites";
import {
  ObjectStorageService, ObjectNotFoundError, ObjectOwnershipError, ObjectContentError, ObjectGenerationError,
  type AllowedUploadType,
} from "../lib/objectStorage";
import { respondObjectStorageDownloadUnavailable, respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";

const router = Router();
const storage = new ObjectStorageService();

/**
 * The HSE receipt for a submission being recorded: a fresh upload (staging
 * path from /incidents/riddor-receipts/request-upload) or one of this
 * incident's existing attachments.
 */
const submissionReceiptSchema = z.union([
  z.object({ objectPath: z.string().min(1).max(2000), fileName: z.string().trim().min(1).max(255) }).strict(),
  z.object({ attachmentId: z.number().int().positive() }).strict(),
]);

const createSchema = z.object({
  // Incident type is validated against the client's effective option list.
  // Severity remains fixed because serious/fatal values drive summary metrics.
  incidentType: z.string().min(1).max(60).default("accident"),
  severity: z.enum(INCIDENT_SEVERITIES).default("minor"),
  status: z.enum(INCIDENT_STATUSES).default("open"),
  incidentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  incidentTime: z.string().max(10).nullable().optional(),
  location: z.string().min(1).max(500),
  description: z.string().min(1).max(10000),
  involvedName: z.string().min(1).max(200),
  involvedJobTitle: z.string().max(200).nullable().optional(),
  involvedEmploymentType: z.enum(EMPLOYMENT_TYPES).default("employee"),
  injuriesSustained: z.string().max(5000).nullable().optional(),
  firstAidGiven: z.boolean().default(false),
  firstAiderName: z.string().max(200).nullable().optional(),
  witnesses: z.string().max(2000).nullable().optional(),
  riddorReportable: z.boolean().default(false),
  riddorCategory: z.enum(RIDDOR_CATEGORIES).nullable().optional(),
  reportedToHse: z.boolean().default(false),
  hseReference: z.string().max(200).nullable().optional(),
  hseReportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  immediateActions: z.string().max(5000).nullable().optional(),
  investigationFindings: z.string().max(10000).nullable().optional(),
  correctiveActions: z.string().max(5000).nullable().optional(),
  reportedBy: z.string().min(1).max(200),
  siteId: z.number().int().nullable().optional(),
  riddorRationale: z.string().max(5000).nullable().optional(),
  submittedAt: z.string().datetime({ offset: true }).nullable().optional(),
  submissionEvidence: z.string().max(5000).nullable().optional(),
  submissionReceipt: submissionReceiptSchema.optional(),
});

// Creation constrains new values to the same bounds as an option-list item.
// Do not apply that upper bound to an update, though: an old record may
// legitimately contain a value from before option lists (or their length
// limit) were introduced. The route below permits that value only when it is
// exactly the value already stored; every changed value is still checked
// against the current, tenant-scoped option list.
const updateSchema = createSchema.partial().extend({
  incidentType: z.string().min(1).optional(),
});
// Creation only: the mobile outbox's device entry ID (see clientEntryReplay).
const postSchema = createSchema.extend({ clientEntryId: clientEntryIdSchema.optional() });

function allowedSites(clientId: number, deptId: number) {
  return db.select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      sitesTableVisibleTo(deptId),
    ));
}

function validateRiddorRecord(data: {
  riddorReportable?: boolean; riddorCategory?: string | null; reportedToHse?: boolean; riddorRationale?: string | null;
  hseReference?: string | null; hseReportDate?: string | null; submittedAt?: string | null;
  submissionEvidence?: string | null; hasReceipt?: boolean;
}, requireSubmission = true) {
  if (!data.riddorRationale?.trim()) {
    return "Record the rationale for the RIDDOR decision";
  }
  if (data.reportedToHse && !data.riddorReportable) return "Only a reportable incident can be marked submitted to HSE";
  if (data.riddorCategory && isReportableRiddorCategory(data.riddorCategory as any) !== !!data.riddorReportable)
    return data.riddorReportable
      ? "Over-3-day injuries are recorded, not reported: untick RIDDOR reportable or choose another category"
      : "This RIDDOR category is reportable: tick RIDDOR reportable or choose another category";
  if (!data.reportedToHse && (data.submittedAt !== undefined && data.submittedAt !== null ||
    data.submissionEvidence !== undefined && data.submissionEvidence !== null && !!data.submissionEvidence.trim() ||
    data.hasReceipt))
    return "Submission time and evidence require a reported HSE submission";
  if (data.reportedToHse) {
    if (!data.hseReference?.trim()) return "An HSE submission reference is required";
    if (!data.hseReportDate) return "The HSE submission date is required";
  }
  if (data.reportedToHse && requireSubmission) {
    if (!data.submittedAt) return "The HSE submission time is required";
    if (!data.submissionEvidence?.trim() && !data.hasReceipt)
      return "Record the submission evidence or its secure location, or attach the HSE receipt";
  }
  return null;
}

/**
 * Injury details are health data: staff who are not managers (see
 * canReadHealthData) and viewers see the incident with injuriesSustained = null.
 */
function redactHealthData<T extends { injuriesSustained?: string | null }>(req: Parameters<typeof canReadHealthData>[0], row: T): T {
  return canReadHealthData(req) ? row : { ...row, injuriesSustained: null };
}

async function canAccessSite(clientId: number, siteId: number | null | undefined, deptId: number | null) {
  if (siteId == null) return true;
  const [site] = await db.select({ id: sitesTable.id, departmentId: sitesTable.departmentId }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  if (!site) return false;
  return siteVisibleToDepartment(site, deptId);
}

type SubmissionReceipt = z.infer<typeof submissionReceiptSchema>;
type BoundReceipt = {
  receiptObjectPath: string; receiptFileName: string; receiptContentType: string | null;
  receiptSource: "upload" | "incident_attachment";
};

/**
 * Checks that a receipt may go on the event being recorded. Sends the error
 * response and returns false when it may not.
 */
function receiptAllowed(req: Parameters<typeof canReadHealthData>[0], res: any, receipt: SubmissionReceipt | undefined, recordsSubmission: boolean): boolean {
  if (!receipt) return true;
  if (!recordsSubmission) {
    res.status(400).json({ error: "An HSE receipt can only be attached when recording an HSE submission" });
    return false;
  }
  if (!canReadHealthData(req)) {
    res.status(403).json({ error: "Only managers can attach an HSE receipt" });
    return false;
  }
  return true;
}

/**
 * Resolves the receipt to bind to a submission event. A fresh upload is
 * verified (PDF, JPEG or PNG) and copied to an immutable tenant-owned key; an
 * existing attachment must belong to this incident. Sends the error response
 * and returns null on failure.
 */
async function resolveReceipt(
  req: any, res: any, clientId: number, incidentId: number | null, receipt: SubmissionReceipt,
): Promise<BoundReceipt | null> {
  if ("attachmentId" in receipt) {
    if (incidentId === null) {
      res.status(400).json({ error: "Upload the HSE receipt, or save the incident first and pick one of its attachments" });
      return null;
    }
    const found = await db.execute(sql`
      SELECT id, object_path, caption FROM check_photos
      WHERE id = ${receipt.attachmentId} AND client_id = ${clientId}
        AND entity_type = 'incident' AND entity_id = ${incidentId}
      LIMIT 1
    `);
    const photo = found.rows[0] as { id: number; object_path: string; caption: string | null } | undefined;
    if (!photo) {
      res.status(404).json({ error: "That attachment is not on this incident" });
      return null;
    }
    const contentType = /\.png$/i.test(photo.object_path) ? "image/png"
      : /\.jpe?g$/i.test(photo.object_path) ? "image/jpeg" : null;
    return {
      receiptObjectPath: photo.object_path,
      receiptFileName: photo.caption?.trim() || `Incident attachment ${photo.id}`,
      receiptContentType: contentType,
      receiptSource: "incident_attachment",
    };
  }
  try {
    const finalized = await storage.finalizeVerifiedTenantUpload(receipt.objectPath, clientId, RIDDOR_RECEIPT_TYPES);
    return {
      receiptObjectPath: finalized.objectPath, receiptFileName: receipt.fileName,
      receiptContentType: finalized.contentType, receiptSource: "upload",
    };
  } catch (err) {
    // Rejected uploads never received a tenant ACL; remove them best-effort.
    await storage.discardTenantUpload(receipt.objectPath, clientId).catch(() => {});
    if (!(err instanceof ObjectNotFoundError || err instanceof ObjectOwnershipError
      || err instanceof ObjectContentError || err instanceof ObjectGenerationError)) {
      req.log?.error({ err }, "Could not finalise HSE receipt upload");
    }
    const error = err instanceof ObjectNotFoundError ? "Uploaded receipt not found"
      : err instanceof ObjectContentError ? "The HSE receipt must be a PDF, JPEG or PNG"
      : err instanceof ObjectGenerationError ? err.message
      : err instanceof ObjectOwnershipError ? err.message : "Could not secure the uploaded receipt";
    res.status(err instanceof ObjectNotFoundError ? 404
      : err instanceof ObjectContentError ? 400
      : err instanceof ObjectGenerationError ? 409 : 403).json({ error });
    return null;
  }
}

class ReceiptAttachmentGone extends Error {}

/**
 * Binding a picked attachment takes the same per-file lock as photo deletion
 * (routes/photos.ts), so the file can't be deleted between the pick and the
 * event insert: either the delete sees this event's reference, or this save
 * sees the attachment gone.
 */
async function lockPickedAttachment(tx: { execute: typeof db.execute }, clientId: number, incidentId: number, receipt: BoundReceipt | null) {
  if (receipt?.receiptSource !== "incident_attachment") return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${clientId}:${receipt.receiptObjectPath}`}))`);
  const still = await tx.execute(sql`
    SELECT 1 FROM check_photos
    WHERE client_id = ${clientId} AND entity_type = 'incident' AND entity_id = ${incidentId}
      AND object_path = ${receipt.receiptObjectPath}
    LIMIT 1
  `);
  if (!still.rows.length) throw new ReceiptAttachmentGone();
}

/** A fresh upload that ended up bound to nothing is removed again. */
async function discardUnboundReceipt(clientId: number, receipt: BoundReceipt | null) {
  if (receipt?.receiptSource !== "upload") return;
  await storage.deleteTenantObject(receipt.receiptObjectPath, clientId).catch(() => {});
}

// GET /api/incidents
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { status, severity, incidentType, siteId, riddorOnly } = req.query as Record<string, string>;
  const conditions: any[] = [eq(incidentsTable.clientId, clientId)];

  if (status && (INCIDENT_STATUSES as readonly string[]).includes(status))
    conditions.push(eq(incidentsTable.status, status));
  if (severity && (INCIDENT_SEVERITIES as readonly string[]).includes(severity))
    conditions.push(eq(incidentsTable.severity, severity));
  if (incidentType)
    conditions.push(eq(incidentsTable.incidentType, incidentType));
  if (siteId && !isNaN(parseInt(siteId)))
    conditions.push(eq(incidentsTable.siteId, parseInt(siteId)));
  if (riddorOnly === "true")
    conditions.push(eq(incidentsTable.riddorReportable, true));

  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(incidentsTable.siteId), inArray(incidentsTable.siteId, allowedSites(clientId, deptId))) as any,
    );
  }

  const rows = await db.select().from(incidentsTable)
    .where(and(...conditions))
    .orderBy(desc(incidentsTable.incidentDate), desc(incidentsTable.id));

  res.json(rows.map((row) => withRiddorDeadline(redactHealthData(req, row))));
});

// GET /api/incidents/summary
router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const deptId = getActiveDepartmentId(req);
  const deptClause = deptId !== null ? sql`
    AND (site_id IS NULL OR site_id IN (${visibleSiteIdsSql(clientId, deptId)}))` : sql``;
  const result = await db.execute(sql`
    SELECT
      COUNT(*)::int                                                           AS total,
      COUNT(*) FILTER (WHERE status = 'open')::int                           AS open_count,
      COUNT(*) FILTER (WHERE status = 'under_investigation')::int            AS investigating_count,
      COUNT(*) FILTER (WHERE riddor_reportable = true)::int                  AS riddor_count,
      COUNT(*) FILTER (WHERE riddor_reportable = true AND reported_to_hse = false)::int AS riddor_outstanding,
      COUNT(*) FILTER (WHERE incident_date >= date_trunc('month', now()))::int AS this_month,
      COUNT(*) FILTER (WHERE severity IN ('serious','fatal'))::int           AS serious_count
    FROM incidents
    WHERE client_id = ${clientId} ${deptClause}
  `);

  const row = ((result.rows ?? [])[0] ?? {}) as Record<string, number>;
  res.json({
    total:              row.total              ?? 0,
    openCount:          row.open_count         ?? 0,
    investigatingCount: row.investigating_count ?? 0,
    riddorCount:        row.riddor_count        ?? 0,
    riddorOutstanding:  row.riddor_outstanding  ?? 0,
    thisMonth:          row.this_month          ?? 0,
    seriousCount:       row.serious_count       ?? 0,
  });
});

// POST /api/incidents
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", issues: parsed.error.issues });
  const data = parsed.data;

  const allowedTypes = await getEffectiveOptionList(clientId, "incident_types");
  if (!allowedTypes.includes(data.incidentType)) return res.status(400).json({ error: "Invalid incident type" });

  if (!await canAccessSite(clientId, data.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Invalid or inaccessible site" });

  const riddorError = validateRiddorRecord({ ...data, hasReceipt: !!data.submissionReceipt });
  if (riddorError) return res.status(400).json({ error: riddorError });
  if (!receiptAllowed(req, res, data.submissionReceipt, data.reportedToHse)) return;
  const { riddorRationale, submittedAt, submissionEvidence, submissionReceipt, clientEntryId: _entryId, ...incidentData } = data;
  const actor = (req as any).currentUser;
  const entry = clientEntryFrom(data);
  const storedEntry = async () => entry && (await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.clientId, clientId), eq(incidentsTable.clientEntryId, entry.id)))
    .limit(1))[0];
  const present = (row: typeof incidentsTable.$inferSelect) => withRiddorDeadline(redactHealthData(req, row));
  const prior = await storedEntry();
  if (entry && prior) return respondToStoredEntry(res, prior, actor.id, entry, present);
  const receipt = submissionReceipt ? await resolveReceipt(req, res, clientId, null, submissionReceipt) : null;
  if (submissionReceipt && !receipt) return;
  const decisionAt = new Date();
  let inserted;
  try {
    inserted = await db.transaction(async (tx) => {
      const [incident] = await tx.insert(incidentsTable).values({
        clientId, ...incidentData, createdBy: actor?.id ?? null,
        clientEntryId: entry?.id ?? null, clientEntryHash: entry?.hash ?? null,
      }).returning();
      await tx.insert(incidentRiddorEventsTable).values({
        clientId, incidentId: incident.id, eventType: incident.reportedToHse ? "submission" : "decision", actorId: actor?.id ?? null,
        decisionMaker: actor?.name ?? actor?.email ?? null, decisionAt,
        riddorReportable: incident.riddorReportable, riddorCategory: incident.riddorCategory, reportedToHse: incident.reportedToHse,
        rationale: riddorRationale?.trim() ?? null, hseReference: incident.hseReference, hseReportDate: incident.hseReportDate,
        submittedAt: submittedAt ? new Date(submittedAt) : null, submissionEvidence: submissionEvidence?.trim() || null,
        ...receipt,
      });
      return incident;
    });
  } catch (err) {
    await discardUnboundReceipt(clientId, receipt);
    // A concurrent replay of the same device entry won the insert.
    const raced = entry && isUniqueViolation(err) ? await storedEntry() : undefined;
    if (entry && raced) return respondToStoredEntry(res, raced, actor.id, entry, present);
    throw err;
  }
  await appendAuditEvent(req, { clientId, entityType: "incident", entityId: inserted.id, action: "created", after: inserted });

  res.status(201).json(withRiddorDeadline(inserted));
});

// PUT /api/incidents/:id
router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, existing.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Forbidden" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  // Allow a value that is unchanged from the stored record even if it is no
  // longer in the client's effective list (so editing other fields doesn't
  // force changing a now-removed type); reject only NEW values not in the list.
  if (parsed.data.incidentType !== undefined && parsed.data.incidentType !== existing.incidentType) {
    const allowedTypes = await getEffectiveOptionList(clientId, "incident_types");
    if (!allowedTypes.includes(parsed.data.incidentType)) return res.status(400).json({ error: "Invalid incident type" });
  }
  if ("siteId" in parsed.data && !await canAccessSite(clientId, parsed.data.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Invalid or inaccessible site" });
  const { riddorRationale, submittedAt, submissionEvidence, submissionReceipt, ...updateData } = parsed.data;
  // Staff who can't read injury details get them back as null; saving the
  // form must not wipe what a manager recorded (adding details is allowed).
  if (!canReadHealthData(req) && !updateData.injuriesSustained?.trim()) delete updateData.injuriesSustained;
  const riddorChanged = ["riddorReportable", "riddorCategory", "reportedToHse", "hseReference", "hseReportDate"]
    .some(k => k in updateData && (updateData as any)[k] !== (existing as any)[k]);
  const hasRiddorRecord = riddorChanged || !!riddorRationale?.trim() || !!submittedAt || !!submissionEvidence?.trim()
    || !!submissionReceipt;
  if ((updateData.reportedToHse ?? existing.reportedToHse) && !(updateData.riddorReportable ?? existing.riddorReportable))
    return res.status(400).json({ error: "Only a reportable incident can be marked submitted to HSE" });
  // An unchanged legacy combination is left alone; any change must be consistent.
  if (riddorChanged) {
    const category = updateData.riddorCategory === undefined ? existing.riddorCategory : updateData.riddorCategory;
    const reportable = updateData.riddorReportable ?? existing.riddorReportable;
    if (category && isReportableRiddorCategory(category as any) !== reportable)
      return res.status(400).json({ error: reportable
        ? "Over-3-day injuries are recorded, not reported: untick RIDDOR reportable or choose another category"
        : "This RIDDOR category is reportable: tick RIDDOR reportable or choose another category" });
  }
  const newSubmission = (updateData.reportedToHse ?? existing.reportedToHse) &&
    (!existing.reportedToHse || (updateData.hseReference !== undefined && updateData.hseReference !== existing.hseReference) ||
      (updateData.hseReportDate !== undefined && updateData.hseReportDate !== existing.hseReportDate));
  if ((submittedAt !== undefined || submissionEvidence !== undefined) && !newSubmission)
    return res.status(400).json({ error: "Submission time and evidence require a new or corrected HSE submission" });
  if (!receiptAllowed(req, res, submissionReceipt, !!newSubmission)) return;
  if (hasRiddorRecord) {
    const riddorError = validateRiddorRecord({
      riddorReportable: updateData.riddorReportable ?? existing.riddorReportable,
      reportedToHse: updateData.reportedToHse ?? existing.reportedToHse,
      riddorRationale,
      hseReference: updateData.hseReference === undefined ? existing.hseReference : updateData.hseReference,
      hseReportDate: updateData.hseReportDate === undefined ? existing.hseReportDate : updateData.hseReportDate,
      submittedAt,
      submissionEvidence,
      hasReceipt: !!submissionReceipt,
    }, newSubmission);
    if (riddorError) return res.status(400).json({ error: riddorError });
  }
  const receipt = submissionReceipt ? await resolveReceipt(req, res, clientId, id, submissionReceipt) : null;
  if (submissionReceipt && !receipt) return;
  const actor = (req as any).currentUser;
  const decisionAt = new Date();
  const updated = await db.transaction(async (tx) => {
    if (updateData.status === "closed") {
      await tx.execute(sql`SELECT id FROM incidents WHERE id = ${id} AND client_id = ${clientId} FOR UPDATE`);
      const pending = await tx.execute(sql`
        SELECT 1 FROM compliance_actions
        WHERE client_id = ${clientId} AND source_track = 'IncidentTrack'
          AND source_record_id = ${String(id)} AND status <> 'verified' LIMIT 1
      `);
      if (pending.rows.length) return null;
    }
    const [incident] = await tx.update(incidentsTable)
      .set({ ...updateData, updatedAt: new Date() })
      .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).returning();
    if (!incident) return null;
    if (hasRiddorRecord) {
      await lockPickedAttachment(tx as any, clientId, id, receipt);
      await tx.insert(incidentRiddorEventsTable).values({
        clientId, incidentId: id, eventType: newSubmission ? "submission" : "decision",
        actorId: actor?.id ?? null, decisionMaker: actor?.name ?? actor?.email ?? null, decisionAt,
        riddorReportable: incident.riddorReportable, riddorCategory: incident.riddorCategory, reportedToHse: incident.reportedToHse, rationale: riddorRationale?.trim() ?? null,
        hseReference: incident.hseReference, hseReportDate: incident.hseReportDate,
        submittedAt: submittedAt ? new Date(submittedAt) : null, submissionEvidence: submissionEvidence?.trim() || null,
        ...receipt,
      });
    }
    return incident;
  }).catch(async (err) => {
    await discardUnboundReceipt(clientId, receipt);
    if (err instanceof ReceiptAttachmentGone) return "receipt_gone" as const;
    throw err;
  });
  if (updated === "receipt_gone") return res.status(409).json({ error: "That attachment was removed; pick or upload the receipt again" });
  if (!updated) await discardUnboundReceipt(clientId, receipt);
  if (!updated) return res.status(409).json({ error: "Linked corrective actions changed; reload before closing this incident" });
  await appendAuditEvent(req, { clientId, entityType: "incident", entityId: id, action: "updated", before: existing, after: updated });
  res.json(withRiddorDeadline(redactHealthData(req, updated)));
});

// DELETE /api/incidents/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, existing.siteId, getActiveDepartmentId(req)))
    return res.status(403).json({ error: "Forbidden" });

  // Incidents have a statutory decision/submission trail. Do not allow an API
  // delete to silently destroy that trail; retain the record for export/audit.
  return res.status(409).json({ error: "Incident records with compliance history cannot be deleted" });
});

// Decision/submission events are intentionally insert-only. Current incident
// fields remain available for existing consumers, while this endpoint retains
// the legally useful sequence of assessments and HSE references.
router.get("/:id/riddor-history", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId || !Number.isInteger(id)) return res.status(400).json({ error: "Invalid request" });
  const [incident] = await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!incident) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, incident.siteId, getActiveDepartmentId(req))) return res.status(403).json({ error: "Forbidden" });
  res.json(await db.select({
    id: incidentRiddorEventsTable.id,
    eventType: incidentRiddorEventsTable.eventType,
    riddorReportable: incidentRiddorEventsTable.riddorReportable,
    riddorCategory: incidentRiddorEventsTable.riddorCategory,
    reportedToHse: incidentRiddorEventsTable.reportedToHse,
    rationale: incidentRiddorEventsTable.rationale,
    hseReference: incidentRiddorEventsTable.hseReference,
    hseReportDate: incidentRiddorEventsTable.hseReportDate,
    decisionMaker: incidentRiddorEventsTable.decisionMaker,
    decisionAt: incidentRiddorEventsTable.decisionAt,
    submittedAt: incidentRiddorEventsTable.submittedAt,
    submissionEvidence: incidentRiddorEventsTable.submissionEvidence,
    receiptFileName: incidentRiddorEventsTable.receiptFileName,
    receiptContentType: incidentRiddorEventsTable.receiptContentType,
    receiptSource: incidentRiddorEventsTable.receiptSource,
    createdAt: incidentRiddorEventsTable.createdAt,
    actorName: usersTable.name,
    actorEmail: usersTable.email,
  }).from(incidentRiddorEventsTable)
    .leftJoin(usersTable, eq(incidentRiddorEventsTable.actorId, usersTable.id))
    .where(and(eq(incidentRiddorEventsTable.clientId, clientId), eq(incidentRiddorEventsTable.incidentId, id)))
    .orderBy(desc(incidentRiddorEventsTable.createdAt), desc(incidentRiddorEventsTable.id)));
});

// Presigned upload for an HSE receipt. The file is verified and bound to its
// submission event when the incident is saved (see resolveReceipt).
router.post("/riddor-receipts/request-upload", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!canReadHealthData(req)) return res.status(403).json({ error: "Only managers can attach an HSE receipt" });
  const parsed = z.object({ contentType: z.string().max(100) }).safeParse(req.body);
  const contentType = parsed.success ? parsed.data.contentType.toLowerCase() : "";
  if (!RIDDOR_RECEIPT_TYPES.has(contentType as AllowedUploadType)) {
    return res.status(400).json({ error: "Upload the HSE receipt as a PDF, JPEG or PNG" });
  }
  try {
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId, contentType);
    res.json({ uploadUrl, objectPath: storage.normalizeObjectEntityPath(uploadUrl) });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "HSE receipt upload");
  }
});

// Short-lived download link for the receipt bound to one submission event.
// Tenant, then the incident's site/department, then manager-only (the receipt
// repeats the injury details reported to HSE).
router.get("/:id/riddor-history/:eventId/receipt", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  const eventId = Number(req.params.eventId);
  if (!clientId || !Number.isInteger(id) || !Number.isInteger(eventId)) return res.status(400).json({ error: "Invalid request" });
  const [incident] = await db.select({ siteId: incidentsTable.siteId }).from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!incident) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, incident.siteId, getActiveDepartmentId(req))) return res.status(403).json({ error: "Forbidden" });
  if (!canReadHealthData(req)) return res.status(403).json({ error: "Only managers can download HSE receipts" });
  const [event] = await db.select({
    objectPath: incidentRiddorEventsTable.receiptObjectPath,
    fileName: incidentRiddorEventsTable.receiptFileName,
  }).from(incidentRiddorEventsTable)
    .where(and(
      eq(incidentRiddorEventsTable.id, eventId),
      eq(incidentRiddorEventsTable.clientId, clientId),
      eq(incidentRiddorEventsTable.incidentId, id),
    )).limit(1);
  if (!event?.objectPath) return res.status(404).json({ error: "No HSE receipt on this event" });
  try {
    const downloadUrl = await storage.getSignedDownloadURL(event.objectPath, 900, RIDDOR_RECEIPT_TYPES, clientId);
    return res.json({ downloadUrl, fileName: event.fileName });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "Receipt file not found" });
    if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: "Receipt is not available for this account" });
    if (err instanceof ObjectContentError) return res.status(409).json({ error: "Receipt failed its content check" });
    return respondObjectStorageDownloadUnavailable(req, res, err, "HSE receipt download", { incidentId: id, eventId, clientId });
  }
});

// The incident file includes the live, tenant-scoped status of each linked
// corrective action. Verification remains controlled by Compliance Hub.
router.get("/:id/actions", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId || !Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid request" });
  const [incident] = await db.select().from(incidentsTable)
    .where(and(eq(incidentsTable.id, id), eq(incidentsTable.clientId, clientId))).limit(1);
  if (!incident) return res.status(404).json({ error: "Not found" });
  if (!await canAccessSite(clientId, incident.siteId, getActiveDepartmentId(req))) return res.status(403).json({ error: "Forbidden" });
  const result = await db.execute(sql`
    SELECT id, title, status, owner_name AS "ownerName", corrective_action AS "correctiveAction",
      evidence_reference AS "evidenceReference", verification_notes AS "verificationNotes",
      verified_at AS "verifiedAt", verified_by AS "verifiedBy"
    FROM compliance_actions
    WHERE client_id = ${clientId} AND source_track = 'IncidentTrack'
      AND source_record_id = ${String(id)}
    ORDER BY created_at, id
  `);
  res.json(result.rows);
});

// ── Template config ───────────────────────────────────────────────────────────
const INCIDENT_CONFIG_KEYS = [
  "incident_locations",          // JSON: string[]
  "incident_departments",        // JSON: string[]
  "incident_default_reporter",
  "incident_show_investigation", // "true"|"false"
] as const;

const INCIDENT_DEFAULT_CONFIG = {
  incident_locations: "",
  incident_departments: "",
  incident_default_reporter: "",
  incident_show_investigation: "true",
};

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...INCIDENT_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (INCIDENT_CONFIG_KEYS.includes(row.key as (typeof INCIDENT_CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }
  res.json(config);
});

router.put("/config", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const updates = req.body as Record<string, string>;
  for (const key of INCIDENT_CONFIG_KEYS) {
    if (key in updates) {
      const existing = await db.select({ id: appSettingsTable.clientId }).from(appSettingsTable)
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key))).limit(1);
      if (existing.length > 0) {
        await db.update(appSettingsTable).set({ value: updates[key], updatedAt: new Date() })
          .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
      } else {
        await db.insert(appSettingsTable).values({ clientId, key, value: updates[key] });
      }
    }
  }
  res.json({ ok: true });
});

export default router;
