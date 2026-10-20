/**
 * COSHHTrack, mounted at /coshh-track behind the coshhtrack service:
 *  - COSHH assessments for a substance from the core COSHH register or for a
 *    task: who is at risk, exposure routes, controls, PPE, risk level, what
 *    follow-up is needed, and a review date (12 months by default).
 *  - Checks that follow from them: LEV thorough examinations (14 months by
 *    default), health surveillance, exposure monitoring and staff briefings,
 *    each with a pass/fail result, a next due date and an optional report.
 *
 * Every row belongs to the caller's client (getClientId) and to a site the
 * caller can see: department-scoped users are limited to sites in their
 * department, as on GET /sites. Assessments are written by owners,
 * consultants and managers; checks by anyone but viewers, under the shared
 * record lock (dailyEntryCutoff covers /coshh-track/checks). Deletes are soft
 * (deleted_at) so nothing is lost, and every change is in the audit log.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  coshhAssessmentsTable,
  coshhChecksTable,
  coshhSubstancesTable,
  sitesTable,
  COSHH_ASSESSMENT_STATUSES,
  COSHH_CHECK_TYPES,
  COSHH_EXPOSURE_ROUTES,
  COSHH_PPE,
  COSHH_RISK_LEVELS,
  COSHH_SIGNAL_WORDS,
} from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { requireAuth, denyViewers, getClientId, getActiveDepartmentId, isDepartmentLead } from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { documentFields, resolveDocument, sendDownloadUrl } from "../lib/registerDocuments";
import { getAccountToday } from "../lib/accountClock";
import {
  addMonthsIso,
  COSHH_ASSESSMENT_REVIEW_MONTHS,
  COSHH_DEFAULT_INTERVAL_MONTHS,
  COSHH_DUE_SOON_DAYS,
  getCoshhDueItems,
} from "../lib/coshhTrack";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Invalid date");
const TEXT = (max: number) => z.string().trim().max(max);
const OPTIONAL_TEXT = (max: number) => z.string().trim().max(max).nullish().transform((value) => value || null);

/** Canonical, de-duplicated order for a set of vocabulary keys. */
function canonical<T extends string>(values: readonly T[], vocabulary: readonly T[]): T[] {
  const chosen = new Set(values);
  return vocabulary.filter((key) => chosen.has(key));
}

function parseId(raw: unknown): number | null {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requireClient(req: Request, res: Response): number | null {
  const clientId = getClientId(req);
  if (!clientId) res.status(400).json({ error: "No client context" });
  return clientId;
}

/** Department scoping for a site_id column, as in routes/registers.ts. */
function siteScope(req: Request, clientId: number, column: PgColumn): SQL | undefined {
  const deptId = getActiveDepartmentId(req);
  if (deptId === null) return undefined;
  const visibleSites = db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(deptId)));
  return or(isNull(column), inArray(column, visibleSites));
}

/** The site must belong to this client and be visible to the caller. */
async function canUseSite(req: Request, clientId: number, siteId: number): Promise<boolean> {
  const deptId = getActiveDepartmentId(req);
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(
      eq(sitesTable.id, siteId),
      eq(sitesTable.clientId, clientId),
      deptId === null ? undefined : sitesTableVisibleTo(deptId),
    ))
    .limit(1);
  return !!site;
}

function siteFilter(req: Request, column: PgColumn): SQL | undefined | "invalid" {
  if (req.query.siteId === undefined || req.query.siteId === "") return undefined;
  const siteId = parseId(req.query.siteId);
  return siteId === null ? "invalid" : eq(column, siteId);
}

/**
 * COSHH assessments are written by the people responsible for them: owners,
 * consultants, managers and department leads. Staff record checks.
 */
function assessmentWriters(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  if (user && (user.role === "client_admin" || user.role === "consultant" || isDepartmentLead(user))) return next();
  res.status(403).json({ error: "Only owners and managers can change COSHH assessments" });
}

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const siteId = req.query.siteId === undefined || req.query.siteId === "" ? null : parseId(req.query.siteId);
  if (req.query.siteId !== undefined && req.query.siteId !== "" && siteId === null) {
    return res.status(400).json({ error: "Invalid site" });
  }
  const departmentId = getActiveDepartmentId(req);
  if (siteId !== null && !(await canUseSite(req, clientId, siteId))) return res.status(404).json({ error: "Site not found" });
  const today = await getAccountToday(clientId);
  const items = await getCoshhDueItems(clientId, { siteId, departmentId }, today);
  res.json({
    today,
    dueSoonDays: COSHH_DUE_SOON_DAYS,
    overdue: items.filter((item) => item.status === "overdue").length,
    dueSoon: items.filter((item) => item.status === "due_soon").length,
    missing: items.filter((item) => item.status === "missing").length,
    items,
  });
});

// ── Assessments ───────────────────────────────────────────────────────────────

const AssessmentBody = z.object({
  siteId: z.number().int().positive(),
  substanceId: z.number().int().positive().nullish(),
  task: TEXT(300).min(1, "Describe the task or activity"),
  whoAtRisk: OPTIONAL_TEXT(1000),
  exposureRoutes: z.array(z.enum(COSHH_EXPOSURE_ROUTES)).max(COSHH_EXPOSURE_ROUTES.length).optional().default([]),
  howOften: OPTIONAL_TEXT(500),
  hazardStatements: OPTIONAL_TEXT(2000),
  signalWord: z.enum(COSHH_SIGNAL_WORDS).nullish(),
  healthEffects: OPTIONAL_TEXT(2000),
  exposureLimits: OPTIONAL_TEXT(1000),
  controls: OPTIONAL_TEXT(4000),
  ppe: z.array(z.enum(COSHH_PPE)).max(COSHH_PPE.length).optional().default([]),
  ppeDetails: OPTIONAL_TEXT(1000),
  riskLevel: z.enum(COSHH_RISK_LEVELS),
  healthSurveillanceRequired: z.boolean().optional().default(false),
  monitoringRequired: z.boolean().optional().default(false),
  levRequired: z.boolean().optional().default(false),
  storage: OPTIONAL_TEXT(2000),
  spillProcedure: OPTIONAL_TEXT(2000),
  firstAid: OPTIONAL_TEXT(2000),
  disposal: OPTIONAL_TEXT(2000),
  assessor: OPTIONAL_TEXT(200),
  assessmentDate: DATE,
  // Omitted on create: 12 months after the assessment date (editable).
  reviewDue: DATE.nullish(),
  status: z.enum(COSHH_ASSESSMENT_STATUSES).optional().default("current"),
  notes: OPTIONAL_TEXT(4000),
  // "ai" when the form was pre-filled from a safety data sheet. Such a draft
  // is saved only with checkedAgainstSds, and saving records who checked it.
  draftSource: z.enum(["ai"]).nullish(),
  draftedAt: z.string().datetime({ offset: true }).nullish(),
  checkedAgainstSds: z.boolean().optional().default(false),
  ...documentFields,
});

function withAssessmentStatus<T extends { reviewDue: string | null; status: string }>(row: T, today: string) {
  return { ...row, reviewOverdue: row.status === "current" && !!row.reviewDue && row.reviewDue < today };
}

async function findAssessment(req: Request, clientId: number, id: number) {
  const [row] = await db.select().from(coshhAssessmentsTable)
    .where(and(
      eq(coshhAssessmentsTable.id, id),
      eq(coshhAssessmentsTable.clientId, clientId),
      isNull(coshhAssessmentsTable.deletedAt),
      siteScope(req, clientId, coshhAssessmentsTable.siteId),
    ))
    .limit(1);
  return row ?? null;
}

/** A linked substance must be a live register entry at the same site. */
async function substanceAtSite(clientId: number, substanceId: number, siteId: number): Promise<boolean> {
  const [row] = await db.select({ id: coshhSubstancesTable.id }).from(coshhSubstancesTable)
    .where(and(
      eq(coshhSubstancesTable.id, substanceId),
      eq(coshhSubstancesTable.clientId, clientId),
      eq(coshhSubstancesTable.siteId, siteId),
      isNull(coshhSubstancesTable.deletedAt),
    ))
    .limit(1);
  return !!row;
}

/** Who checked an AI draft and when: the person saving it, after the tick. */
function checkedStamp(req: Request, draftSource: string | null | undefined, draftedAt?: string | null) {
  return draftSource === "ai"
    ? {
      draftSource: "ai",
      ...(draftedAt ? { draftedAt: new Date(draftedAt) } : {}),
      checkedBy: req.currentUser!.id,
      checkedByName: req.currentUser!.name ?? null,
      checkedAt: new Date(),
    }
    : {};
}

const UNCHECKED_DRAFT = "Tick that you have checked this draft against the safety data sheet";

router.get("/assessments", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, coshhAssessmentsTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const today = await getAccountToday(clientId);
  const rows = await db.select().from(coshhAssessmentsTable)
    .where(and(
      eq(coshhAssessmentsTable.clientId, clientId),
      isNull(coshhAssessmentsTable.deletedAt),
      siteScope(req, clientId, coshhAssessmentsTable.siteId),
      site,
    ))
    .orderBy(asc(coshhAssessmentsTable.task), asc(coshhAssessmentsTable.id));
  res.json(rows.map((row) => withAssessmentStatus(row, today)));
});

router.post("/assessments", requireAuth, denyViewers, assessmentWriters, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = AssessmentBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (d.draftSource === "ai" && !d.checkedAgainstSds) return res.status(400).json({ error: UNCHECKED_DRAFT });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  if (d.substanceId && !(await substanceAtSite(clientId, d.substanceId, d.siteId))) {
    return res.status(400).json({ error: "Choose a substance from this site's COSHH register" });
  }
  const document = await resolveDocument(req, res, clientId, d, null);
  if (!document || document === "kept") return;
  const reviewDue = d.reviewDue !== undefined ? d.reviewDue : addMonthsIso(d.assessmentDate, COSHH_ASSESSMENT_REVIEW_MONTHS);
  const [row] = await db.insert(coshhAssessmentsTable).values({
    clientId,
    siteId: d.siteId,
    substanceId: d.substanceId ?? null,
    task: d.task,
    whoAtRisk: d.whoAtRisk,
    exposureRoutes: canonical(d.exposureRoutes, COSHH_EXPOSURE_ROUTES),
    howOften: d.howOften,
    hazardStatements: d.hazardStatements,
    signalWord: d.signalWord ?? null,
    healthEffects: d.healthEffects,
    exposureLimits: d.exposureLimits,
    controls: d.controls,
    ppe: canonical(d.ppe, COSHH_PPE),
    ppeDetails: d.ppeDetails,
    riskLevel: d.riskLevel,
    healthSurveillanceRequired: d.healthSurveillanceRequired,
    monitoringRequired: d.monitoringRequired,
    levRequired: d.levRequired,
    storage: d.storage,
    spillProcedure: d.spillProcedure,
    firstAid: d.firstAid,
    disposal: d.disposal,
    assessor: d.assessor,
    assessmentDate: d.assessmentDate,
    reviewDue,
    status: d.status,
    documentObjectPath: document.objectPath,
    documentFileName: document.fileName,
    documentFileSize: document.fileSize,
    documentMimeType: document.mimeType,
    notes: d.notes,
    ...checkedStamp(req, d.draftSource, d.draftedAt ?? new Date().toISOString()),
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(withAssessmentStatus(row, await getAccountToday(clientId)));
});

router.put("/assessments/:id", requireAuth, denyViewers, assessmentWriters, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = AssessmentBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  const existing = await findAssessment(req, clientId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if ((d.draftSource ?? existing.draftSource) === "ai" && !d.checkedAgainstSds) return res.status(400).json({ error: UNCHECKED_DRAFT });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  if (d.substanceId && !(await substanceAtSite(clientId, d.substanceId, d.siteId))) {
    return res.status(400).json({ error: "Choose a substance from this site's COSHH register" });
  }
  const document = await resolveDocument(req, res, clientId, d, {
    objectPath: existing.documentObjectPath, fileName: existing.documentFileName,
    fileSize: existing.documentFileSize, mimeType: existing.documentMimeType,
  });
  if (!document) return;
  const [row] = await db.update(coshhAssessmentsTable).set({
    siteId: d.siteId,
    substanceId: d.substanceId ?? null,
    task: d.task,
    whoAtRisk: d.whoAtRisk,
    exposureRoutes: canonical(d.exposureRoutes, COSHH_EXPOSURE_ROUTES),
    howOften: d.howOften,
    hazardStatements: d.hazardStatements,
    signalWord: d.signalWord ?? null,
    healthEffects: d.healthEffects,
    exposureLimits: d.exposureLimits,
    controls: d.controls,
    ppe: canonical(d.ppe, COSHH_PPE),
    ppeDetails: d.ppeDetails,
    riskLevel: d.riskLevel,
    healthSurveillanceRequired: d.healthSurveillanceRequired,
    monitoringRequired: d.monitoringRequired,
    levRequired: d.levRequired,
    storage: d.storage,
    spillProcedure: d.spillProcedure,
    firstAid: d.firstAid,
    disposal: d.disposal,
    assessor: d.assessor,
    assessmentDate: d.assessmentDate,
    ...(d.reviewDue !== undefined ? { reviewDue: d.reviewDue } : {}),
    status: d.status,
    ...(document === "kept" ? {} : {
      documentObjectPath: document.objectPath,
      documentFileName: document.fileName,
      documentFileSize: document.fileSize,
      documentMimeType: document.mimeType,
    }),
    notes: d.notes,
    // A saved AI draft is re-stamped by whoever saves it; a hand-written
    // assessment keeps its draft history.
    ...checkedStamp(req, d.draftSource ?? existing.draftSource, existing.draftedAt ? null : d.draftedAt),
    updatedAt: new Date(),
  }).where(and(eq(coshhAssessmentsTable.id, id), eq(coshhAssessmentsTable.clientId, clientId), isNull(coshhAssessmentsTable.deletedAt))).returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(withAssessmentStatus(row, await getAccountToday(clientId)));
});

router.delete("/assessments/:id", requireAuth, denyViewers, assessmentWriters, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findAssessment(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  await db.update(coshhAssessmentsTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(coshhAssessmentsTable.id, id), eq(coshhAssessmentsTable.clientId, clientId)));
  res.status(204).end();
});

router.get("/assessments/:id/document-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const row = await findAssessment(req, clientId, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, row.documentObjectPath, row.documentFileName, clientId, id);
});

// ── Checks (LEV, health surveillance, monitoring, briefings) ─────────────────

const CheckBody = z.object({
  siteId: z.number().int().positive(),
  assessmentId: z.number().int().positive().nullish(),
  checkType: z.enum(COSHH_CHECK_TYPES),
  checkDate: DATE,
  subject: OPTIONAL_TEXT(300),
  carriedOutBy: OPTIONAL_TEXT(300),
  result: z.enum(["pass", "fail"]).optional().default("pass"),
  actionRequired: OPTIONAL_TEXT(2000),
  // Omitted on create: the suggested interval for the check type (editable).
  nextDueDate: DATE.nullish(),
  notes: OPTIONAL_TEXT(4000),
  ...documentFields,
}).refine((d) => d.result !== "fail" || !!d.actionRequired, {
  message: "Say what needs to be done when a check fails",
});

async function findCheck(req: Request, clientId: number, id: number) {
  const [row] = await db.select().from(coshhChecksTable)
    .where(and(
      eq(coshhChecksTable.id, id),
      eq(coshhChecksTable.clientId, clientId),
      isNull(coshhChecksTable.deletedAt),
      siteScope(req, clientId, coshhChecksTable.siteId),
    ))
    .limit(1);
  return row ?? null;
}

/** A linked assessment must be live and at the same site as the check. */
async function assessmentAtSite(req: Request, clientId: number, assessmentId: number, siteId: number): Promise<boolean> {
  const row = await findAssessment(req, clientId, assessmentId);
  return !!row && row.siteId === siteId;
}

router.get("/checks", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const site = siteFilter(req, coshhChecksTable.siteId);
  if (site === "invalid") return res.status(400).json({ error: "Invalid site" });
  const { checkType } = req.query as { checkType?: string };
  const assessmentId = req.query.assessmentId === undefined ? undefined : parseId(req.query.assessmentId);
  if (assessmentId === null) return res.status(400).json({ error: "Invalid assessment" });
  const rows = await db.select().from(coshhChecksTable)
    .where(and(
      eq(coshhChecksTable.clientId, clientId),
      isNull(coshhChecksTable.deletedAt),
      siteScope(req, clientId, coshhChecksTable.siteId),
      site,
      checkType && (COSHH_CHECK_TYPES as readonly string[]).includes(checkType) ? eq(coshhChecksTable.checkType, checkType) : undefined,
      assessmentId ? eq(coshhChecksTable.assessmentId, assessmentId) : undefined,
    ))
    .orderBy(desc(coshhChecksTable.checkDate), desc(coshhChecksTable.id));
  res.json(rows);
});

router.post("/checks", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const parsed = CheckBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  if (d.assessmentId && !(await assessmentAtSite(req, clientId, d.assessmentId, d.siteId))) {
    return res.status(400).json({ error: "Choose an assessment for this site" });
  }
  const document = await resolveDocument(req, res, clientId, d, null);
  if (!document || document === "kept") return;
  const nextDueDate = d.nextDueDate !== undefined
    ? d.nextDueDate
    : addMonthsIso(d.checkDate, COSHH_DEFAULT_INTERVAL_MONTHS[d.checkType]);
  const [row] = await db.insert(coshhChecksTable).values({
    clientId,
    siteId: d.siteId,
    assessmentId: d.assessmentId ?? null,
    checkType: d.checkType,
    checkDate: d.checkDate,
    subject: d.subject,
    carriedOutBy: d.carriedOutBy,
    result: d.result,
    actionRequired: d.actionRequired,
    nextDueDate,
    reportObjectPath: document.objectPath,
    reportFileName: document.fileName,
    reportFileSize: document.fileSize,
    reportMimeType: document.mimeType,
    notes: d.notes,
    createdBy: req.currentUser!.id,
  }).returning();
  res.status(201).json(row);
});

router.put("/checks/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const parsed = CheckBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid data" });
  const d = parsed.data;
  const existing = await findCheck(req, clientId, id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!(await canUseSite(req, clientId, d.siteId))) return res.status(400).json({ error: "Invalid site" });
  if (d.assessmentId && !(await assessmentAtSite(req, clientId, d.assessmentId, d.siteId))) {
    return res.status(400).json({ error: "Choose an assessment for this site" });
  }
  const document = await resolveDocument(req, res, clientId, d, {
    objectPath: existing.reportObjectPath, fileName: existing.reportFileName,
    fileSize: existing.reportFileSize, mimeType: existing.reportMimeType,
  });
  if (!document) return;
  const [row] = await db.update(coshhChecksTable).set({
    siteId: d.siteId,
    assessmentId: d.assessmentId ?? null,
    checkType: d.checkType,
    checkDate: d.checkDate,
    subject: d.subject,
    carriedOutBy: d.carriedOutBy,
    result: d.result,
    actionRequired: d.actionRequired,
    ...(d.nextDueDate !== undefined ? { nextDueDate: d.nextDueDate } : {}),
    ...(document === "kept" ? {} : {
      reportObjectPath: document.objectPath,
      reportFileName: document.fileName,
      reportFileSize: document.fileSize,
      reportMimeType: document.mimeType,
    }),
    notes: d.notes,
    updatedAt: new Date(),
  }).where(and(eq(coshhChecksTable.id, id), eq(coshhChecksTable.clientId, clientId), isNull(coshhChecksTable.deletedAt))).returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/checks/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  if (!(await findCheck(req, clientId, id))) return res.status(404).json({ error: "Not found" });
  await db.update(coshhChecksTable).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(coshhChecksTable.id, id), eq(coshhChecksTable.clientId, clientId)));
  res.status(204).end();
});

router.get("/checks/:id/report-url", requireAuth, async (req, res) => {
  const clientId = requireClient(req, res);
  if (!clientId) return;
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid id" });
  const row = await findCheck(req, clientId, id);
  if (!row) return res.status(404).json({ error: "Not found" });
  return sendDownloadUrl(req, res, row.reportObjectPath, row.reportFileName, clientId, id);
});

export default router;
