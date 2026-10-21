import { Router, type Request } from "express";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { db } from "@workspace/db";
import {
  inspectionReportTypeEnum, inspectionReportsTable, sitesTable, trackActionsTable, usersTable,
  type InspectionReport, type InspectionReportDraftAction,
} from "@workspace/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth, requireRole } from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { getAccountToday } from "../lib/accountClock";
import { getEntitledServices, isEntitled } from "../lib/services";
import { TRACK_MODULES } from "../lib/trackModules";
import { INSPECTION_REPORT_SOURCE_PREFIX } from "../lib/trackEvidenceRequirements";
import { TRACK_ACTION_MODULES } from "./track-actions";
import {
  canReadReportType, readReportForActions, REPORT_READS_PER_REPORT, ReportReadingError, reportReadingConfigured,
  reportReadingMonthlyLimit, UnreadableReportError,
} from "../lib/reportReading";
import {
  isTenantReservedObjectPath, ObjectContentError, ObjectNotFoundError, ObjectOwnershipError, ObjectStorageService,
} from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";
import { createDownloadMeter } from "../lib/downloadUsage";
import { hasTenantAttachmentReference } from "../lib/attachmentReferences";
import { sendReportActionPlanEmails } from "../lib/reportActionEmails";
import { resolveAssigneeChange } from "../lib/assignees";

/**
 * Uploaded audit and inspection reports (ALPS audits, Care Inspectorate, EHO,
 * fire officer...) turned into track actions. A person checks the suggested
 * or typed list and confirms it; only then are track_actions rows created,
 * each pointing back here (source_kind 'inspection_report:...'). Owners, Managers
 * and consultants only; Managers see reports for their own sites and
 * business-wide ones.
 */
const router = Router();
const storage = new ObjectStorageService();
const canManageReports = requireRole("consultant", "client_admin", "client_manager");

export const REPORT_TYPE_LABELS: Record<(typeof inspectionReportTypeEnum)[number], string> = {
  alps_audit: "ALPS audit",
  care_inspectorate: "Care Inspectorate report",
  eho: "Environmental Health (EHO) report",
  fire_officer: "Fire officer report",
  hse: "HSE inspection",
  insurer: "Insurer survey",
  other: "Other report",
};
/** Who an action can be assigned to: Owners and Managers (including Maintenance managers). */
const ASSIGNABLE_ROLES = ["client_admin", "client_manager"] as const;

const severity = z.enum(["monitor", "action_required", "urgent"]);
const draftActionSchema = z.object({
  title: z.string().trim().min(1).max(500),
  instruction: z.string().trim().max(10_000).nullable().optional(),
  module: z.enum(TRACK_ACTION_MODULES),
  severity,
  siteId: z.number().int().positive().nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
  assignedUserId: z.number().int().positive().nullable().optional(),
  reportReference: z.string().trim().max(200).nullable().optional(),
  draftSource: z.enum(["ai", "manual"]).default("manual"),
}).strict();
const draftListSchema = z.object({ actions: z.array(draftActionSchema).max(200) }).strict();
const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  reportType: z.enum(inspectionReportTypeEnum),
  reportDate: z.string().date().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
  objectPath: z.string().min(1).max(500),
  fileName: z.string().trim().min(1).max(255),
}).strict();

/** Track actions confirmed from uploaded reports. */
const fromReport = sql`${trackActionsTable.sourceKind} LIKE ${INSPECTION_REPORT_SOURCE_PREFIX + "%"}`;

function reportId(req: Request) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Sites the caller may use: every site for Owners/consultants, else their department's. */
async function visibleSites(clientId: number, departmentId: number | null) {
  const conditions = [eq(sitesTable.clientId, clientId)];
  if (departmentId != null) conditions.push(sitesTableVisibleTo(departmentId));
  return db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable).where(and(...conditions)).orderBy(asc(sitesTable.name));
}

/** The report, if it belongs to this business and the caller's sites. Others answer as missing. */
async function loadReport(clientId: number, id: number, departmentId: number | null): Promise<InspectionReport | null> {
  const [report] = await db.select().from(inspectionReportsTable)
    .where(and(eq(inspectionReportsTable.id, id), eq(inspectionReportsTable.clientId, clientId)));
  if (!report) return null;
  if (departmentId != null && report.siteId != null) {
    const sites = await visibleSites(clientId, departmentId);
    if (!sites.some((site) => site.id === report.siteId)) return null;
  }
  return report;
}

async function moduleChoices(clientId: number) {
  const services = await getEntitledServices(clientId);
  const actionModules = new Set<string>(TRACK_ACTION_MODULES);
  return TRACK_MODULES
    .filter((module) => actionModules.has(module.key) && module.services.some((key) => isEntitled(services, key)))
    .map((module) => ({ key: module.key, label: module.label }));
}

async function assignees(clientId: number) {
  return db.select({
    id: usersTable.id, name: usersTable.name, role: usersTable.role, isMaintenanceManager: usersTable.isMaintenanceManager,
  }).from(usersTable).where(and(
    eq(usersTable.clientId, clientId), eq(usersTable.active, true), inArray(usersTable.role, [...ASSIGNABLE_ROLES]),
  )).orderBy(asc(usersTable.name));
}

function monthStart(today: string) {
  return new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
}

/** Readings this calendar month (each reading counts, including re-reads). */
async function aiReadsThisMonth(clientId: number, today: string) {
  const [row] = await db.select({ count: sql<number>`coalesce(sum(${inspectionReportsTable.aiReadCount}), 0)::int` }).from(inspectionReportsTable).where(and(
    eq(inspectionReportsTable.clientId, clientId), gte(inspectionReportsTable.aiRequestedAt, monthStart(today)),
  ));
  return Number(row?.count ?? 0);
}

/**
 * Check every action of a list against this business: a track it can use,
 * a site the caller can see, and an Owner or Manager of the business who
 * can see that site as the assignee. Returns the reason for the first problem, or the assignees' names.
 */
async function checkDraftActions(clientId: number, departmentId: number | null, actions: z.infer<typeof draftActionSchema>[]) {
  const [sites, people, modules] = await Promise.all([visibleSites(clientId, departmentId), assignees(clientId), moduleChoices(clientId)]);
  const siteIds = new Set(sites.map((site) => site.id));
  const moduleKeys = new Set(modules.map((module) => module.key));
  const names = new Map(people.map((person) => [person.id, person.name]));
  for (const [index, action] of actions.entries()) {
    const which = `Action ${index + 1}`;
    if (!moduleKeys.has(action.module)) return { error: `${which}: this business does not use that track` };
    if (action.siteId != null && !siteIds.has(action.siteId)) return { error: `${which}: site not found` };
    if (action.assignedUserId != null && !names.has(action.assignedUserId)) return { error: `${which}: assign it to an Owner or Manager of this business` };
    if (action.assignedUserId != null) {
      // The shared assignment rules (lib/assignees.ts): the person must be able to see the action's site.
      const assignee = await resolveAssigneeChange(clientId, action.siteId ?? null, { assigneeUserId: action.assignedUserId });
      if (!assignee.ok) return { error: `${which}: ${assignee.error}` };
    }
  }
  return { names };
}

function toDraft(action: z.infer<typeof draftActionSchema>): InspectionReportDraftAction {
  return {
    title: action.title, instruction: action.instruction?.trim() || null, module: action.module,
    severity: action.severity, siteId: action.siteId ?? null, dueDate: action.dueDate ?? null,
    assignedUserId: action.assignedUserId ?? null, reportReference: action.reportReference?.trim() || null,
    draftSource: action.draftSource,
  };
}

// What the upload and checking screens need: tracks, sites, people, and
// whether ComplyTrack can read reports (ANTHROPIC_API_KEY set) this month.
router.get("/inspection-reports/options", requireAuth, canManageReports, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const departmentId = getActiveDepartmentId(req);
  const today = await getAccountToday(clientId);
  const [modules, sites, people, used] = await Promise.all([
    moduleChoices(clientId), visibleSites(clientId, departmentId), assignees(clientId), aiReadsThisMonth(clientId, today),
  ]);
  const limit = reportReadingMonthlyLimit();
  res.json({
    reportTypes: inspectionReportTypeEnum.map((key) => ({ key, label: REPORT_TYPE_LABELS[key] })),
    modules, sites, assignees: people,
    reading: { available: reportReadingConfigured(), monthlyLimit: limit, usedThisMonth: used },
  });
});

router.get("/inspection-reports", requireAuth, canManageReports, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const departmentId = getActiveDepartmentId(req);
  const conditions = [eq(inspectionReportsTable.clientId, clientId)];
  if (departmentId != null) {
    const siteIds = (await visibleSites(clientId, departmentId)).map((site) => site.id);
    conditions.push(siteIds.length
      ? or(isNull(inspectionReportsTable.siteId), inArray(inspectionReportsTable.siteId, siteIds))!
      : isNull(inspectionReportsTable.siteId));
  }
  const reports = await db.select({
    id: inspectionReportsTable.id, siteId: inspectionReportsTable.siteId, reportType: inspectionReportsTable.reportType,
    title: inspectionReportsTable.title, reportDate: inspectionReportsTable.reportDate, fileName: inspectionReportsTable.fileName,
    aiStatus: inspectionReportsTable.aiStatus, uploadedByName: inspectionReportsTable.uploadedByName, createdAt: inspectionReportsTable.createdAt,
    draftCount: sql<number>`jsonb_array_length(${inspectionReportsTable.draftActions})::int`,
    actionCount: sql<number>`(SELECT count(*)::int FROM track_actions a WHERE a.client_id = inspection_reports.client_id AND a.source_kind LIKE ${INSPECTION_REPORT_SOURCE_PREFIX + "%"} AND a.source_record_id = inspection_reports.id)`,
    openCount: sql<number>`(SELECT count(*)::int FROM track_actions a WHERE a.client_id = inspection_reports.client_id AND a.source_kind LIKE ${INSPECTION_REPORT_SOURCE_PREFIX + "%"} AND a.source_record_id = inspection_reports.id AND a.status <> 'resolved')`,
  }).from(inspectionReportsTable).where(and(...conditions)).orderBy(desc(inspectionReportsTable.createdAt));
  res.json(reports);
});

// Register an uploaded report (presigned via /storage/uploads/request-url).
router.post("/inspection-reports", requireAuth, denyViewers, canManageReports, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const departmentId = getActiveDepartmentId(req);
  if (parsed.data.siteId != null && !(await visibleSites(clientId, departmentId)).some((site) => site.id === parsed.data.siteId)) {
    return res.status(403).json({ error: "Forbidden site" });
  }
  let mimeType: string;
  let fileSize: number | null = null;
  const objectPath = storage.normalizeObjectEntityPath(parsed.data.objectPath);
  try {
    if (!isTenantReservedObjectPath(objectPath, clientId)) throw new ObjectOwnershipError("Upload was not reserved for this tenant");
    mimeType = (await storage.verifyDocumentUpload(objectPath, parsed.data.fileName)).split(";")[0];
    await storage.finalizeTenantUpload(objectPath, clientId);
    const [metadata] = await (await storage.getObjectEntityFile(objectPath)).getMetadata();
    const size = Number(metadata.size);
    fileSize = Number.isSafeInteger(size) ? size : null;
  } catch (err) {
    if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: "Upload does not belong to this business" });
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "Uploaded file not found" });
    if (err instanceof ObjectContentError) return res.status(400).json({ error: err.message });
    req.log.error({ err }, "Could not finalize inspection report upload");
    return res.status(400).json({ error: "Uploaded file could not be verified" });
  }
  const [report] = await db.insert(inspectionReportsTable).values({
    clientId, siteId: parsed.data.siteId ?? null, reportType: parsed.data.reportType, title: parsed.data.title,
    reportDate: parsed.data.reportDate ?? null, objectPath, fileName: parsed.data.fileName, fileSize, mimeType,
    uploadedBy: req.currentUser!.id, uploadedByName: req.currentUser!.name,
  }).returning();
  res.status(201).json({ ...report, readable: canReadReportType(report.mimeType) });
});

router.get("/inspection-reports/:id", requireAuth, canManageReports, async (req, res) => {
  const clientId = getClientId(req); const id = reportId(req);
  if (!clientId || !id) return res.status(400).json({ error: "Invalid request" });
  const report = await loadReport(clientId, id, getActiveDepartmentId(req));
  if (!report) return res.status(404).json({ error: "Report not found" });
  const actions = await db.select().from(trackActionsTable).where(and(
    eq(trackActionsTable.clientId, clientId), fromReport, eq(trackActionsTable.sourceRecordId, id),
  )).orderBy(asc(trackActionsTable.id));
  // Due dates moved after confirming, from the audit log (who, when, from and to).
  const moves = actions.length ? (await db.execute(sql`
    SELECT a.row_id, a.changed_at, u.name AS changed_by_name,
      a.diff->'due_date'->>'before' AS due_from, a.diff->'due_date'->>'after' AS due_to
    FROM audit_log a LEFT JOIN users u ON u.id = a.changed_by
    WHERE a.client_id = ${clientId} AND a.table_name = 'track_actions' AND a.action = 'update'
      AND a.row_id IN (${sql.join(actions.map((action) => sql`${action.id}`), sql`, `)}) AND a.diff ? 'due_date'
    ORDER BY a.changed_at, a.id
  `)).rows as Array<{ row_id: number; changed_at: Date | string; changed_by_name: string | null; due_from: string | null; due_to: string | null }> : [];
  const { objectPath: _objectPath, ...visible } = report;
  res.json({
    ...visible, readable: canReadReportType(report.mimeType),
    actions: actions.map((action) => ({
      ...action,
      dueDateChanges: moves.filter((move) => Number(move.row_id) === action.id).map((move) => ({
        changedAt: new Date(move.changed_at).toISOString(), changedByName: move.changed_by_name ?? null,
        from: move.due_from?.slice(0, 10) ?? null, to: move.due_to?.slice(0, 10) ?? null,
      })),
    })),
  });
});

// Ask ComplyTrack to read the report and suggest actions. The suggestions
// replace the list being checked; nothing is created until it is confirmed.
router.post("/inspection-reports/:id/read", requireAuth, denyViewers, canManageReports, async (req, res) => {
  const clientId = getClientId(req); const id = reportId(req);
  if (!clientId || !id) return res.status(400).json({ error: "Invalid request" });
  if (!reportReadingConfigured()) return res.status(503).json({ error: "Reading reports is not switched on yet. Type the actions in instead.", code: "REPORT_READING_UNAVAILABLE" });
  const departmentId = getActiveDepartmentId(req);
  const report = await loadReport(clientId, id, departmentId);
  if (!report) return res.status(404).json({ error: "Report not found" });
  if (!canReadReportType(report.mimeType)) return res.status(400).json({ error: "ComplyTrack can read PDF, Word (.docx) and photo reports. Save this one as a PDF, or type the actions in." });
  const today = await getAccountToday(clientId);
  const limit = reportReadingMonthlyLimit();
  if (limit > 0 && await aiReadsThisMonth(clientId, today) >= limit) {
    return res.status(429).json({ error: `This business has had ${limit} reports read this month, the most allowed. Type the actions in, or ask ALPS.`, code: "REPORT_READING_LIMIT" });
  }
  if (report.aiReadCount >= REPORT_READS_PER_REPORT) {
    return res.status(429).json({ error: `This report has already been read ${REPORT_READS_PER_REPORT} times. Edit the list or type the actions in.`, code: "REPORT_READING_LIMIT" });
  }
  // A month's count restarts with this reading when the report was last read in an earlier month.
  const [claimed] = await db.update(inspectionReportsTable).set({
    aiRequestedAt: new Date(), aiStatus: "reading", aiError: null, updatedAt: new Date(),
    aiReadCount: sql`CASE WHEN ${inspectionReportsTable.aiRequestedAt} >= ${monthStart(today)} THEN ${inspectionReportsTable.aiReadCount} + 1 ELSE 1 END`,
  }).where(and(
    eq(inspectionReportsTable.id, id), eq(inspectionReportsTable.clientId, clientId),
    sql`(${inspectionReportsTable.aiStatus} <> 'reading' OR ${inspectionReportsTable.aiRequestedAt} < now() - interval '10 minutes')`,
  )).returning({ id: inspectionReportsTable.id });
  if (!claimed) return res.status(409).json({ error: "This report is already being read. Wait a minute and refresh." });

  try {
    const [bytes] = await (await storage.getObjectEntityFile(report.objectPath)).download();
    const [modules, sites] = await Promise.all([moduleChoices(clientId), visibleSites(clientId, departmentId)]);
    const result = await readReportForActions({
      bytes, mimeType: report.mimeType ?? "", reportTypeLabel: REPORT_TYPE_LABELS[report.reportType] ?? "Report",
      reportTitle: report.title, reportDate: report.reportDate, today, modules, sites, defaultSiteId: report.siteId,
    });
    const draft: InspectionReportDraftAction[] = result.actions.map((action) => ({
      title: action.title, instruction: action.instruction || null, module: action.module, severity: action.severity,
      siteId: action.siteId, dueDate: action.dueDate, assignedUserId: null, reportReference: action.reportReference, draftSource: "ai",
    }));
    const [row] = await db.update(inspectionReportsTable).set({
      draftActions: draft, aiStatus: "done", aiSummary: result.summary || null, aiModel: result.model,
      aiInputTokens: result.inputTokens, aiOutputTokens: result.outputTokens, updatedAt: new Date(),
    }).where(and(eq(inspectionReportsTable.id, id), eq(inspectionReportsTable.clientId, clientId))).returning();
    req.log.info({ reportId: id, clientId, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, "Inspection report read");
    res.json({ aiSummary: row.aiSummary, draftActions: row.draftActions });
  } catch (err) {
    const message = err instanceof ReportReadingError ? err.message
      : "ComplyTrack could not read this report just now. Try again later, or type the actions in.";
    if (!(err instanceof UnreadableReportError)) req.log.error({ err, reportId: id }, "Inspection report reading failed");
    await db.update(inspectionReportsTable).set({ aiStatus: "failed", aiError: message, updatedAt: new Date() })
      .where(and(eq(inspectionReportsTable.id, id), eq(inspectionReportsTable.clientId, clientId)));
    res.status(err instanceof UnreadableReportError ? 400 : 502).json({ error: message });
  }
});

// Save the list being checked, so a person can come back to it.
router.put("/inspection-reports/:id/draft", requireAuth, denyViewers, canManageReports, async (req, res) => {
  const clientId = getClientId(req); const id = reportId(req);
  if (!clientId || !id) return res.status(400).json({ error: "Invalid request" });
  const parsed = draftListSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const departmentId = getActiveDepartmentId(req);
  if (!await loadReport(clientId, id, departmentId)) return res.status(404).json({ error: "Report not found" });
  const checked = await checkDraftActions(clientId, departmentId, parsed.data.actions);
  if ("error" in checked) return res.status(400).json({ error: checked.error });
  const [row] = await db.update(inspectionReportsTable).set({ draftActions: parsed.data.actions.map(toDraft), updatedAt: new Date() })
    .where(and(eq(inspectionReportsTable.id, id), eq(inspectionReportsTable.clientId, clientId))).returning();
  res.json({ draftActions: row.draftActions });
});

// Create the checked actions. Each becomes an open track action linked to
// the report, marked AI-drafted or typed, and who confirmed it.
router.post("/inspection-reports/:id/confirm", requireAuth, denyViewers, canManageReports, async (req, res) => {
  const clientId = getClientId(req); const id = reportId(req);
  if (!clientId || !id) return res.status(400).json({ error: "Invalid request" });
  const parsed = draftListSchema.safeParse(req.body);
  if (!parsed.success || !parsed.data.actions.length) return res.status(400).json({ error: parsed.success ? "Add at least one action" : parsed.error.flatten() });
  const confirmer = req.currentUser!.name?.trim();
  if (!confirmer) return res.status(400).json({ error: "Your account must have a name before confirming actions" });
  const departmentId = getActiveDepartmentId(req);
  const report = await loadReport(clientId, id, departmentId);
  if (!report) return res.status(404).json({ error: "Report not found" });
  const checked = await checkDraftActions(clientId, departmentId, parsed.data.actions);
  if ("error" in checked) return res.status(400).json({ error: checked.error });

  const created = await db.transaction(async (tx) => {
    // One confirmation at a time per report, so a double click cannot create a list twice.
    const [locked] = await tx.select({ id: inspectionReportsTable.id, updatedAt: inspectionReportsTable.updatedAt }).from(inspectionReportsTable)
      .where(and(eq(inspectionReportsTable.id, id), eq(inspectionReportsTable.clientId, clientId))).for("update");
    if (!locked) return null;
    const rows = await tx.insert(trackActionsTable).values(parsed.data.actions.map((action) => ({
      clientId, siteId: action.siteId ?? null, module: action.module,
      sourceKind: `${INSPECTION_REPORT_SOURCE_PREFIX}${randomUUID()}`, sourceRecordId: id, provenance: "one_off",
      title: action.title,
      instruction: [action.instruction?.trim(), action.reportReference?.trim() ? `Report reference: ${action.reportReference.trim()}` : null].filter(Boolean).join("\n\n") || null,
      severity: action.severity,
      // The assigned person gets the action's reminders (lib/personalReminders.ts).
      assigneeUserId: action.assignedUserId ?? null,
      ownerName: action.assignedUserId != null ? checked.names.get(action.assignedUserId) ?? null : null,
      dueDate: action.dueDate ?? null, status: "open", createdBy: req.currentUser!.id,
      draftSource: action.draftSource, confirmedByName: confirmer,
    }))).returning();
    await tx.update(inspectionReportsTable).set({ draftActions: [], updatedAt: new Date() }).where(eq(inspectionReportsTable.id, id));
    return rows;
  });
  if (!created) return res.status(404).json({ error: "Report not found" });
  // Same day: the Owners and Managers get the action plan, with a button to assign each action.
  const emailedTo = await sendReportActionPlanEmails({
    clientId, reportId: id, reportTitle: report.title, reportTypeLabel: REPORT_TYPE_LABELS[report.reportType],
    reportDate: report.reportDate, summary: report.aiSummary, confirmedByUserId: req.currentUser!.id, confirmedBy: confirmer,
    actions: created.map((action) => ({
      id: action.id, title: action.title, severity: action.severity as "urgent" | "action_required" | "monitor",
      siteId: action.siteId, module: action.module, dueDate: action.dueDate, ownerName: action.ownerName,
    })),
  });
  res.status(201).json({ actions: created, emailedTo });
});

router.get("/inspection-reports/:id/file", requireAuth, canManageReports, async (req, res) => {
  const clientId = getClientId(req); const id = reportId(req);
  if (!clientId || !id) return res.status(400).json({ error: "Invalid request" });
  const report = await loadReport(clientId, id, getActiveDepartmentId(req));
  if (!report) return res.status(404).json({ error: "Report not found" });
  try {
    const file = await storage.getObjectEntityFile(report.objectPath);
    await storage.assertTenantObjectOwnership(file, clientId);
    if (!await storage.canAccessObjectEntity({ userId: String(clientId), objectFile: file, requestedPermission: ObjectPermission.READ })) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const response = await storage.downloadObject(file, 0);
    const safeName = (report.fileName ?? `report-${report.id}`).replace(/[^a-zA-Z0-9._\- ]/g, "_");
    res.status(response.status);
    response.headers.forEach((value, key) => { if (key.toLowerCase() !== "content-disposition") res.setHeader(key, value); });
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    if (!response.body) return res.end();
    const stream = Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>);
    const meter = createDownloadMeter(clientId);
    stream.on("data", (chunk) => meter.add(chunk));
    const commit = () => { void meter.commit().catch((error) => req.log.error({ err: error }, "Could not record download usage")); };
    stream.once("end", commit);
    stream.once("close", commit);
    stream.pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "File not found in storage" });
    req.log.error({ err }, "Error streaming inspection report");
    res.status(500).json({ error: "Failed to download report" });
  }
});

// A report uploaded by mistake can be removed until actions are created from it.
router.delete("/inspection-reports/:id", requireAuth, denyViewers, canManageReports, async (req, res) => {
  const clientId = getClientId(req); const id = reportId(req);
  if (!clientId || !id) return res.status(400).json({ error: "Invalid request" });
  const report = await loadReport(clientId, id, getActiveDepartmentId(req));
  if (!report) return res.status(404).json({ error: "Report not found" });
  const removed = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ id: inspectionReportsTable.id }).from(inspectionReportsTable)
      .where(and(eq(inspectionReportsTable.id, id), eq(inspectionReportsTable.clientId, clientId))).for("update");
    if (!locked) return "missing" as const;
    const [linked] = await tx.select({ id: trackActionsTable.id }).from(trackActionsTable).where(and(
      eq(trackActionsTable.clientId, clientId), fromReport, eq(trackActionsTable.sourceRecordId, id),
    )).limit(1);
    if (linked) return "linked" as const;
    await tx.delete(inspectionReportsTable).where(eq(inspectionReportsTable.id, id));
    return await hasTenantAttachmentReference(tx, clientId, report.objectPath) ? "kept_file" as const : "deleted" as const;
  });
  if (removed === "missing") return res.status(404).json({ error: "Report not found" });
  if (removed === "linked") return res.status(409).json({ error: "Actions have been created from this report, so it is kept as their evidence" });
  if (removed === "deleted") await storage.deleteTenantObject(report.objectPath, clientId).catch((err) => req.log.warn({ err, reportId: id }, "Could not delete inspection report file"));
  res.status(204).end();
});

export default router;
