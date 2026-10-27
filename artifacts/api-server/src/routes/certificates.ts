import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { reminderCycleOf, supersedeStaleReminderCycles } from "../lib/reminderCycles";
import {
  certificatesTable, certificateDefectsTable, contractorsTable, complianceItemsTable, sitesTable, categoriesTable,
} from "@workspace/db/schema";
import { eq, and, or, isNull, inArray } from "drizzle-orm";
import {
  ListCertificatesParams,
  CreateCertificateParams,
  UpdateCertificateParams,
  DeleteCertificateParams,
} from "@workspace/api-zod";
import { z } from "zod";
import {
  requireAuth, requireClientAdmin, canAccessClient, denyViewers, getActiveDepartmentId, getClientId,
} from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { CONTRACTOR_VISIT_TYPES } from "../lib/contractorVisits";
import { AiUnavailableError, claimAiUse, getAiStatus, settleAiUse } from "../lib/aiAllowance";
import { ReportReadingError, UnreadableReportError, reportReadingConfigured } from "../lib/reportReading";
import { CERTIFICATE_READING_MAX_BYTES, readCertificate, type CertificateCheckChoice } from "../lib/certificateReading";
import { appendAuditEvent } from "../lib/audit";
import { getAccountToday } from "../lib/accountClock";
import { getEntitledServices, isEntitled } from "../lib/services";
import { getEffectiveOptionList } from "../lib/formOptions";
import { addMonthsUtc } from "../lib/complianceCompletion";
import {
  ACTION_DEFECT_CODES, CERTIFICATE_OUTCOMES, DEFECT_CODES, createDefect, createRemedialJob, defectsForCertificates,
  fixTrackIssueTypeFor, outcomeMovesDueDate,
} from "../lib/certificateOutcomes";
import { ObjectContentError, ObjectNotFoundError, ObjectOwnershipError, ObjectStorageService } from "../lib/objectStorage";

// Local schemas that coerce ISO date strings (the OpenAPI-generated zod schemas
// use `z.date()` which does NOT coerce strings, breaking JSON request bodies).
const CreateCertificateBody = z.object({
  name: z.string().min(1),
  fileUrl: z.string().nullish(),
  issueDate: z.coerce.date().nullish(),
  expiryDate: z.coerce.date().nullish(),
  notes: z.string().nullish(),
});

const UpdateCertificateBody = CreateCertificateBody.partial();

const DefectBody = z.object({
  code: z.enum(DEFECT_CODES),
  description: z.string().trim().min(1).max(1000),
  location: z.string().trim().max(300).nullish(),
}).strict();
type DefectBodyValue = z.infer<typeof DefectBody>;

// Item certificates also record the outcome and, on creation, their defects.
// With remedialJob (the AI certificate reader), the defects that need work
// share one FixTrack job, so one quote request covers them, and the rest (C3s,
// advice) open no job. needsWork defaults from the code: C1/C2/FI/ID/AR.
const CreateItemCertificateBody = CreateCertificateBody.extend({
  outcome: z.enum(CERTIFICATE_OUTCOMES).optional(),
  defects: z.array(DefectBody.extend({ needsWork: z.boolean().optional() })).max(100).optional(),
  remedialJob: z.boolean().optional(),
  /** The details were read by ComplyTrack's AI and checked by the person saving. */
  readByAi: z.boolean().optional(),
});
type ItemDefectValue = DefectBodyValue & { needsWork?: boolean };
const UpdateItemCertificateBody = CreateCertificateBody.extend({
  outcome: z.enum(CERTIFICATE_OUTCOMES),
}).partial();

const router: IRouter = Router();

type Item = typeof complianceItemsTable.$inferSelect;
type Cert = typeof certificatesTable.$inferSelect;

async function assertItemAccess(req: Request, itemId: number): Promise<Item | null> {
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  const [item] = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, itemId));
  if (!item) return null;
  if (!canAccessClient(req, item.clientId)) return null;
  return item;
}

async function withDefects(clientId: number, certs: Cert[]) {
  const defects = await defectsForCertificates(clientId, certs.map((c) => c.id));
  return certs.map((c) => ({ ...c, defects: defects.get(c.id) ?? [] }));
}

/**
 * A certificate file arrives through the generic presigned upload, which only
 * reserves a tenant path. Registering it on the certificate is what grants the
 * tenant ACL, so the file can be viewed and included in data exports, and a
 * caller cannot attach another tenant's object. Sends the error response and
 * returns false when the file cannot be secured.
 */
async function secureCertificateFile(req: Request, res: any, fileUrl: string, clientId: number): Promise<boolean> {
  try {
    await new ObjectStorageService().finalizeTenantUpload(fileUrl, clientId);
    return true;
  } catch (err) {
    if (err instanceof ObjectOwnershipError) {
      res.status(403).json({ error: "File does not belong to this client" });
    } else if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Uploaded file not found" });
    } else if (err instanceof ObjectContentError) {
      res.status(400).json({ error: err.message });
    } else {
      req.log.error({ err }, "Could not secure certificate file");
      res.status(503).json({ error: "File storage is temporarily unavailable. Please try again later." });
    }
    return false;
  }
}

// ----- Item-scoped certificates -----

router.get("/items/:itemId/certificates", requireAuth, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const item = await assertItemAccess(req, itemId);
  if (!item) return void res.status(404).json({ error: "Compliance item not found" });
  const certs = await db.select().from(certificatesTable).where(eq(certificatesTable.itemId, itemId)).orderBy(certificatesTable.createdAt);
  res.json(await withDefects(item.clientId, certs));
});

const sameDay = (a: Date | null | undefined, b: Date | null | undefined) =>
  !!a && !!b && a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/**
 * Keep the item's due date in step with its certificates. Only satisfactory or
 * legacy not-stated certificates count. "sync" (a counting certificate with an
 * expiry was saved) moves the due date to the latest counting expiry, as
 * before. "recalc" (a counting certificate was deleted or stopped counting)
 * acts only when the item's due date is that certificate's old expiry, i.e.
 * the certificate set it: it falls back to the latest remaining counting
 * expiry, then to the last completion plus the repeat interval, else keeps it.
 */
async function updateItemDueDate(itemId: number, mode: { kind: "sync" } | { kind: "recalc"; previousExpiry: Date | null }) {
  const certs = await db
    .select({ expiryDate: certificatesTable.expiryDate, outcome: certificatesTable.outcome })
    .from(certificatesTable)
    .where(eq(certificatesTable.itemId, itemId));
  const expiries = certs
    .filter((c) => outcomeMovesDueDate(c.outcome))
    .map((c) => c.expiryDate)
    .filter((d): d is Date => d != null);
  const latestCounting = expiries.length ? new Date(Math.max(...expiries.map((d) => d.getTime()))) : null;
  if (mode.kind === "sync" && !latestCounting) return;
  if (mode.kind === "recalc" && !mode.previousExpiry) return;
  await db.transaction(async (tx) => {
    // Lock the item first (the reminder-cycle lock order), then move the due
    // date and retire pending reminders drafted for the old one.
    const [item] = await tx.select({
      clientId: complianceItemsTable.clientId, dueDate: complianceItemsTable.dueDate,
      completedAt: complianceItemsTable.completedAt, frequencyMonths: complianceItemsTable.frequencyMonths,
    }).from(complianceItemsTable).where(eq(complianceItemsTable.id, itemId)).for("update");
    if (!item) return;
    let next: Date | null = latestCounting;
    if (mode.kind === "recalc") {
      if (!sameDay(item.dueDate, mode.previousExpiry)) return;
      if (!next && item.completedAt && item.frequencyMonths && item.frequencyMonths > 0) {
        next = addMonthsUtc(new Date(item.completedAt), item.frequencyMonths);
      }
    }
    if (!next || (item.dueDate && item.dueDate.getTime() === next.getTime())) return;
    const cycleChanged = !item.dueDate || reminderCycleOf(new Date(item.dueDate)) !== reminderCycleOf(next);
    await tx
      .update(complianceItemsTable)
      .set({ dueDate: next, updatedAt: new Date(), ...(cycleChanged ? { notificationSentAt: null } : {}) })
      .where(eq(complianceItemsTable.id, itemId));
    await supersedeStaleReminderCycles(tx, item.clientId, itemId);
  });
}

/** FixTrack availability and the issue type to file defects under. */
async function fixTrackSetup(clientId: number, itemTitle: string) {
  const enabled = isEntitled(await getEntitledServices(clientId), "fixtrack");
  if (!enabled) return { enabled };
  const preferred = fixTrackIssueTypeFor(itemTitle);
  const allowed = await getEffectiveOptionList(clientId, "fixtrack_issue_types");
  return { enabled, issueType: allowed.includes(preferred) || !allowed.includes("general") ? preferred : "general" };
}

/** Record defects (and their FixTrack jobs) for the item's own client. */
async function addDefects(req: Request, item: Item, cert: Cert, defects: ItemDefectValue[], remedialJob = false) {
  if (!defects.length) return [];
  const fixTrack = await fixTrackSetup(item.clientId, item.title);
  const today = await getAccountToday(item.clientId);
  const user = req.currentUser!;
  return db.transaction(async (tx) => {
    let job: number | null | undefined;
    if (remedialJob) {
      const work = defects.filter((d) => d.needsWork ?? ACTION_DEFECT_CODES.includes(d.code));
      job = fixTrack.enabled && work.length ? await createRemedialJob(tx, {
        clientId: item.clientId,
        certificate: { id: cert.id, name: cert.name },
        item: { id: item.id, title: item.title, siteId: item.siteId },
        defects: work,
        issueType: fixTrack.issueType,
        user: { id: user.id, name: user.name ?? null },
        today,
      }) : null;
    }
    const created: Array<{ id: number; fixTrackIssueId: number | null }> = [];
    for (const { needsWork, ...defect } of defects) {
      const inJob = needsWork ?? ACTION_DEFECT_CODES.includes(defect.code);
      created.push(await createDefect(tx, {
        clientId: item.clientId,
        certificate: { id: cert.id, name: cert.name },
        item: { id: item.id, title: item.title, siteId: item.siteId },
        defect,
        fixTrack,
        user: { id: user.id, name: user.name ?? null },
        today,
        ...(remedialJob ? { job: inJob ? job ?? null : null } : {}),
      }));
    }
    return created;
  });
}

router.post("/items/:itemId/certificates", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const parsed = CreateItemCertificateBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid certificate", details: parsed.error.flatten() });
  const item = await assertItemAccess(req, itemId);
  if (!item) return void res.status(404).json({ error: "Compliance item not found" });
  const { defects = [], remedialJob = false, readByAi = false, ...body } = parsed.data;
  if (body.fileUrl && !await secureCertificateFile(req, res, body.fileUrl, item.clientId)) return;
  const [cert] = await db.insert(certificatesTable)
    .values({ ...body, outcome: body.outcome ?? "not_stated", itemId, contractorId: null })
    .returning();
  const created = await addDefects(req, item, cert!, defects, remedialJob);
  if (outcomeMovesDueDate(cert!.outcome)) await updateItemDueDate(itemId, { kind: "sync" });
  await appendAuditEvent(req, {
    clientId: item.clientId, entityType: "compliance_item", entityId: itemId, action: "certificate_added",
    after: cert,
    metadata: {
      certificateId: cert!.id,
      defects: defects.map((d, i) => ({ ...d, fixTrackIssueId: created[i]?.fixTrackIssueId ?? null })),
      ...(readByAi ? { readByAi: true } : {}),
    },
  });
  const [view] = await withDefects(item.clientId, [cert!]);
  res.status(201).json(view);
});

router.put("/items/:itemId/certificates/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const id = Number(req.params.id);
  const parsed = UpdateItemCertificateBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid certificate", details: parsed.error.flatten() });
  const item = await assertItemAccess(req, itemId);
  if (!item) return void res.status(404).json({ error: "Compliance item not found" });
  if (!Number.isInteger(id)) return void res.status(404).json({ error: "Certificate not found" });
  const [before] = await db.select().from(certificatesTable)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.itemId, itemId)));
  if (!before) return void res.status(404).json({ error: "Certificate not found" });
  if (parsed.data.fileUrl && parsed.data.fileUrl !== before.fileUrl
    && !await secureCertificateFile(req, res, parsed.data.fileUrl, item.clientId)) return;
  const [cert] = await db
    .update(certificatesTable)
    .set(parsed.data)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.itemId, itemId)))
    .returning();
  if (!cert) return void res.status(404).json({ error: "Certificate not found" });
  if (outcomeMovesDueDate(cert.outcome) && cert.expiryDate) await updateItemDueDate(itemId, { kind: "sync" });
  else if (outcomeMovesDueDate(before.outcome)) await updateItemDueDate(itemId, { kind: "recalc", previousExpiry: before.expiryDate });
  await appendAuditEvent(req, {
    clientId: item.clientId, entityType: "compliance_item", entityId: itemId, action: "certificate_updated",
    before, after: cert, metadata: { certificateId: id },
  });
  const [view] = await withDefects(item.clientId, [cert]);
  res.json(view);
});

router.delete("/items/:itemId/certificates/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const id = Number(req.params.id);
  const item = await assertItemAccess(req, itemId);
  if (!item) return void res.status(404).json({ error: "Compliance item not found" });
  const [before] = Number.isInteger(id) ? await db.select().from(certificatesTable)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.itemId, itemId))) : [];
  if (!before) return void res.status(204).send();
  const defects = (await defectsForCertificates(item.clientId, [id])).get(id) ?? [];
  // FixTrack jobs raised from its defects stay in FixTrack.
  await db.delete(certificatesTable).where(and(eq(certificatesTable.id, id), eq(certificatesTable.itemId, itemId)));
  if (outcomeMovesDueDate(before.outcome)) await updateItemDueDate(itemId, { kind: "recalc", previousExpiry: before.expiryDate });
  await appendAuditEvent(req, {
    clientId: item.clientId, entityType: "compliance_item", entityId: itemId, action: "certificate_deleted",
    before: { ...before, defects }, metadata: { certificateId: id },
  });
  res.status(204).send();
});

// ----- Defects on an item certificate -----

async function itemCertificate(req: Request, itemId: number, certificateId: number) {
  const item = await assertItemAccess(req, itemId);
  if (!item || !Number.isInteger(certificateId)) return null;
  const [cert] = await db.select().from(certificatesTable)
    .where(and(eq(certificatesTable.id, certificateId), eq(certificatesTable.itemId, itemId)));
  return cert ? { item, cert } : null;
}

async function findDefect(clientId: number, certificateId: number, defectId: number) {
  const defects = (await defectsForCertificates(clientId, [certificateId])).get(certificateId) ?? [];
  return defects.find((d) => d.id === defectId) ?? null;
}

router.post("/items/:itemId/certificates/:id/defects", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const parsed = DefectBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid defect", details: parsed.error.flatten() });
  const found = await itemCertificate(req, Number(req.params.itemId), Number(req.params.id));
  if (!found) return void res.status(404).json({ error: "Certificate not found" });
  const [created] = await addDefects(req, found.item, found.cert, [parsed.data]);
  await appendAuditEvent(req, {
    clientId: found.item.clientId, entityType: "compliance_item", entityId: found.item.id, action: "certificate_defect_added",
    after: { ...parsed.data, id: created!.id, fixTrackIssueId: created!.fixTrackIssueId }, metadata: { certificateId: found.cert.id },
  });
  res.status(201).json(await findDefect(found.item.clientId, found.cert.id, created!.id));
});

// Mark a defect remedied (or not). Only for a defect without a FixTrack job
// (no FixTrack, or its job was deleted): a linked job is closed in FixTrack.
router.patch("/items/:itemId/certificates/:id/defects/:defectId", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const parsed = z.object({ resolved: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid request" });
  const found = await itemCertificate(req, Number(req.params.itemId), Number(req.params.id));
  if (!found) return void res.status(404).json({ error: "Certificate not found" });
  const defectId = Number(req.params.defectId);
  const defect = Number.isInteger(defectId) ? await findDefect(found.item.clientId, found.cert.id, defectId) : null;
  if (!defect) return void res.status(404).json({ error: "Defect not found" });
  if (defect.fixTrackIssueId != null) {
    return void res.status(409).json({
      error: "This defect has a FixTrack job: resolve or close the job in FixTrack",
      code: "DEFECT_HAS_FIXTRACK_JOB",
    });
  }
  await db.update(certificateDefectsTable)
    .set({ resolvedAt: parsed.data.resolved ? new Date() : null })
    .where(and(eq(certificateDefectsTable.id, defectId), eq(certificateDefectsTable.clientId, found.item.clientId)));
  await appendAuditEvent(req, {
    clientId: found.item.clientId, entityType: "compliance_item", entityId: found.item.id,
    action: parsed.data.resolved ? "certificate_defect_resolved" : "certificate_defect_reopened",
    before: defect, metadata: { certificateId: found.cert.id, defectId },
  });
  res.json(await findDefect(found.item.clientId, found.cert.id, defectId));
});

// Remove a defect recorded in error. Its FixTrack job, if any, stays.
router.delete("/items/:itemId/certificates/:id/defects/:defectId", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const found = await itemCertificate(req, Number(req.params.itemId), Number(req.params.id));
  if (!found) return void res.status(404).json({ error: "Certificate not found" });
  const defectId = Number(req.params.defectId);
  const defect = Number.isInteger(defectId) ? await findDefect(found.item.clientId, found.cert.id, defectId) : null;
  if (!defect) return void res.status(404).json({ error: "Defect not found" });
  await db.delete(certificateDefectsTable)
    .where(and(eq(certificateDefectsTable.id, defectId), eq(certificateDefectsTable.clientId, found.item.clientId)));
  await appendAuditEvent(req, {
    clientId: found.item.clientId, entityType: "compliance_item", entityId: found.item.id, action: "certificate_defect_deleted",
    before: defect, metadata: { certificateId: found.cert.id, defectId },
  });
  res.status(204).send();
});

// ----- Reading a certificate with ComplyTrack's AI -----
//
// The browser sends the file; Claude (lib/certificateReading.ts) says which
// check it is for, its dates, outcome and defects. Nothing is saved: the
// person checks and corrects the reading, then saves the certificate through
// POST /items/:itemId/certificates (with remedialJob, so the work that needs
// doing shares one FixTrack job a quote can be asked for). The file is only
// stored when they save it.

/** Held against the AI allowance while a certificate is read; a long EICR costs about this. */
const CERTIFICATE_READING_ESTIMATE_PENCE = 15;

const certificateReadBody = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(200),
  data: z.string().min(1).max(Math.ceil(CERTIFICATE_READING_MAX_BYTES / 3) * 4 + 4),
  itemId: z.number().int().positive().nullable().optional(),
}).strict();

/** The checks the person can file a certificate against, described for Claude. */
async function certificateCheckChoices(req: Request, clientId: number): Promise<CertificateCheckChoice[]> {
  const conditions = [eq(complianceItemsTable.clientId, clientId)];
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    const allowedSites = db.select({ id: sitesTable.id }).from(sitesTable)
      .where(and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(deptId)));
    conditions.push(or(isNull(complianceItemsTable.siteId), inArray(complianceItemsTable.siteId, allowedSites))!);
  }
  const rows = await db.select({
    id: complianceItemsTable.id, title: complianceItemsTable.title, frequencyMonths: complianceItemsTable.frequencyMonths,
    siteName: sitesTable.name, categoryName: categoriesTable.name, contractorName: contractorsTable.name,
  }).from(complianceItemsTable)
    .leftJoin(sitesTable, and(eq(sitesTable.id, complianceItemsTable.siteId), eq(sitesTable.clientId, clientId)))
    .leftJoin(categoriesTable, and(eq(categoriesTable.id, complianceItemsTable.categoryId), eq(categoriesTable.clientId, clientId)))
    .leftJoin(contractorsTable, and(eq(contractorsTable.id, complianceItemsTable.contractorId), eq(contractorsTable.clientId, clientId)))
    .where(and(...conditions))
    .orderBy(complianceItemsTable.title, complianceItemsTable.id);
  const trackOf = new Map(CONTRACTOR_VISIT_TYPES.map((type) => [type.title.trim().toLowerCase(), type.trackLabel]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    track: trackOf.get(row.title.trim().toLowerCase()) ?? row.categoryName ?? null,
    siteName: row.siteName ?? null,
    contractorName: row.contractorName ?? null,
    frequencyMonths: row.frequencyMonths ?? null,
  }));
}

router.get("/certificates/reading", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });
  const [ai, services] = await Promise.all([getAiStatus(clientId), getEntitledServices(clientId)]);
  res.json({ available: reportReadingConfigured(), ai, fixTrack: isEntitled(services, "fixtrack") });
});

router.post("/certificates/read", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });
  if (!reportReadingConfigured()) {
    return void res.status(503).json({ error: "Reading certificates is not switched on yet. Fill the certificate in by hand.", code: "CERTIFICATE_READING_UNAVAILABLE" });
  }
  const parsed = certificateReadBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Choose a PDF, photo or Word certificate (15 MB at most)" });
  const checks = await certificateCheckChoices(req, clientId);
  const itemId = parsed.data.itemId ?? null;
  if (itemId !== null && !checks.some((check) => check.id === itemId)) {
    return void res.status(404).json({ error: "Compliance item not found" });
  }

  let aiUseId: number | null = null;
  try {
    // A file Claude cannot read is turned away before it counts towards the
    // AI allowance (lib/aiAllowance.ts).
    const result = await readCertificate({
      bytes: Buffer.from(parsed.data.data, "base64"), mimeType: parsed.data.mimeType, fileName: parsed.data.fileName,
      today: await getAccountToday(clientId), checks, itemId,
    }, async () => {
      aiUseId = await claimAiUse({
        clientId, userId: req.currentUser?.id ?? null, feature: "certificate_reading",
        estimatePence: CERTIFICATE_READING_ESTIMATE_PENCE, instead: "Fill the certificate in by hand instead.",
      });
    });
    if (aiUseId !== null) await settleAiUse(aiUseId, result.usage, true);
    req.log.info({ clientId, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, defects: result.defects.length }, "Certificate read");
    const { usage: _usage, model: _model, inputTokens: _in, outputTokens: _out, ...reading } = result;
    res.json(reading);
  } catch (err) {
    if (aiUseId !== null) await settleAiUse(aiUseId, err instanceof ReportReadingError ? err.usage ?? null : null, false);
    if (err instanceof AiUnavailableError) return void res.status(err.status).json({ error: err.message, code: err.code });
    if (err instanceof UnreadableReportError) return void res.status(400).json({ error: err.message });
    if (!(err instanceof ReportReadingError)) req.log.error({ err }, "Certificate reading failed");
    res.status(502).json({ error: err instanceof ReportReadingError ? err.message : "ComplyTrack could not read this certificate just now. Try again later, or fill it in by hand." });
  }
});

async function assertContractorAccess(req: Request, contractorId: number) {
  const [contractor] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, contractorId));
  if (!contractor) return null;
  if (!canAccessClient(req, contractor.clientId)) return null;
  return contractor;
}

router.get("/contractors/:contractorId/certificates", requireAuth, async (req, res) => {
  const { contractorId } = ListCertificatesParams.parse({ contractorId: Number(req.params.contractorId) });

  const contractor = await assertContractorAccess(req, contractorId);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  const certs = await db
    .select()
    .from(certificatesTable)
    .where(eq(certificatesTable.contractorId, contractorId))
    .orderBy(certificatesTable.createdAt);
  res.json(certs);
});

router.post("/contractors/:contractorId/certificates", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const { contractorId } = CreateCertificateParams.parse({ contractorId: Number(req.params.contractorId) });
  const body = CreateCertificateBody.parse(req.body);

  const contractor = await assertContractorAccess(req, contractorId);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  const [cert] = await db
    .insert(certificatesTable)
    .values({ ...body, contractorId })
    .returning();
  res.status(201).json(cert);
});

router.put("/contractors/:contractorId/certificates/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const { contractorId, id } = UpdateCertificateParams.parse({
    contractorId: Number(req.params.contractorId),
    id: Number(req.params.id),
  });
  const body = UpdateCertificateBody.parse(req.body);

  const contractor = await assertContractorAccess(req, contractorId);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  const [cert] = await db
    .update(certificatesTable)
    .set(body)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.contractorId, contractorId)))
    .returning();
  if (!cert) {
    res.status(404).json({ error: "Certificate not found" });
    return;
  }
  res.json(cert);
});

router.delete("/contractors/:contractorId/certificates/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const { contractorId, id } = DeleteCertificateParams.parse({
    contractorId: Number(req.params.contractorId),
    id: Number(req.params.id),
  });

  const contractor = await assertContractorAccess(req, contractorId);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  await db
    .delete(certificatesTable)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.contractorId, contractorId)));
  res.status(204).send();
});

export default router;
