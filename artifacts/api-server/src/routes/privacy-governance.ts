import { Router, type Request, type Response } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditEventsTable,
  privacyBreachesTable,
  privacyProcessingActivitiesTable,
  privacyProcessorsTable,
  privacyProgramsTable,
  privacyRetentionSchedulesTable,
  privacyRetentionVerificationsTable,
  privacyRightsRequestsTable,
} from "@workspace/db/schema";
import { getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";

const router = Router();
router.use(requireAuth);

const dateInput = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Enter a valid date and time");
const nullableDate = dateInput.nullable();
const optionalText = z.string().trim().max(10_000).nullable();
const requiredText = z.string().trim().min(1).max(10_000);
const actorContext = (req: Request) => ({
  clientId: getClientId(req),
  actorId: req.currentUser!.id,
});

function dateValue(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function addCalendarMonth(value: Date): Date {
  const result = new Date(value);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

function sendValidationError(res: Response, error: z.ZodError) {
  return res.status(400).json({
    error: "Privacy record validation failed",
    details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  });
}

async function writeAudit(
  tx: any,
  clientId: number,
  actorId: number,
  entityType: string,
  entityId: number,
  action: string,
  metadata: Record<string, string | number | boolean | null> = {},
) {
  await tx.insert(auditEventsTable).values({
    clientId,
    actorId,
    entityType,
    entityId,
    action,
    // Privacy request subjects and free-text evidence stay out of the general
    // audit stream. The source records themselves remain manager-only.
    metadata: { ...metadata },
  });
}

const ProgramBody = z.object({
  customerRole: z.enum(["controller", "joint_controller", "processor", "mixed"]),
  controllerName: optionalText,
  controllerContact: optionalText,
  dpoContact: optionalText,
  noticeUrl: z.string().trim().url().nullable(),
  noticeVersion: optionalText,
  noticeReviewedAt: nullableDate,
  processorAgreementStatus: z.enum(["not_assessed", "in_place", "pending", "not_required"]),
  processorAgreementReviewedAt: nullableDate,
  responsibilitiesNotes: optionalText,
  privacyOwner: optionalText,
});

const ActivityBody = z.object({
  kind: z.literal("activity"),
  name: requiredText,
  purpose: requiredText,
  dataSubjects: requiredText,
  dataCategories: requiredText,
  article6Basis: z.enum(["consent", "contract", "legal_obligation", "vital_interests", "public_task", "legitimate_interests", "other"]),
  article6Rationale: optionalText,
  specialCategoryData: z.boolean(),
  article9Condition: optionalText,
  article9Rationale: optionalText,
  recipients: optionalText,
  transferDetails: optionalText,
  retentionCriteria: requiredText,
  securityMeasures: optionalText,
  dpiaClassification: z.enum(["not_screened", "not_required", "required", "in_progress", "completed"]),
  dpiaRationale: optionalText,
  dpiaCompletedAt: nullableDate,
  owner: optionalText,
  reviewDueAt: nullableDate,
  active: z.boolean(),
}).superRefine((body, ctx) => {
  if (body.specialCategoryData && !body.article9Condition?.trim()) {
    ctx.addIssue({ code: "custom", path: ["article9Condition"], message: "Record the Article 9 condition when special-category data is involved" });
  }
  if (body.dpiaClassification === "not_required" && !body.dpiaRationale?.trim()) {
    ctx.addIssue({ code: "custom", path: ["dpiaRationale"], message: "Record the reason for this DPIA decision" });
  }
});

const RightsRequestBody = z.object({
  kind: z.literal("rights_request"),
  requestType: z.enum(["access", "rectification", "erasure", "restriction", "portability", "objection", "other"]),
  subjectName: requiredText,
  subjectContact: optionalText,
  scopeDescription: requiredText,
  receivedAt: dateInput,
  extendedDueAt: nullableDate,
  extensionReason: optionalText,
  identityStatus: z.enum(["not_started", "in_progress", "verified", "failed"]),
  identityMethod: optionalText,
  identityEvidence: optionalText,
  status: z.enum(["received", "in_progress", "waiting_for_information", "completed", "refused", "withdrawn"]),
  decision: z.enum(["granted", "partially_granted", "refused", "not_applicable"]).nullable(),
  decisionRationale: optionalText,
  responseSentAt: nullableDate,
  responseEvidence: optionalText,
}).superRefine((body, ctx) => {
  if (body.identityStatus === "verified" && (!body.identityMethod?.trim() || !body.identityEvidence?.trim())) {
    ctx.addIssue({ code: "custom", path: ["identityEvidence"], message: "Record how identity was verified and the evidence reference (do not upload identity documents)" });
  }
  if (Boolean(body.extendedDueAt) !== Boolean(body.extensionReason?.trim())) {
    ctx.addIssue({ code: "custom", path: ["extensionReason"], message: "Enter both an extended deadline and its reason" });
  }
  if (body.extendedDueAt && Date.parse(body.extendedDueAt) <= addCalendarMonth(new Date(body.receivedAt)).getTime()) {
    ctx.addIssue({ code: "custom", path: ["extendedDueAt"], message: "The extended deadline must be after the initial one-month deadline" });
  }
  if (body.responseSentAt && !body.responseEvidence?.trim()) {
    ctx.addIssue({ code: "custom", path: ["responseEvidence"], message: "Record what was sent or where delivery evidence is held" });
  }
  if ((body.decision === "refused" || body.decision === "partially_granted") && !body.decisionRationale?.trim()) {
    ctx.addIssue({ code: "custom", path: ["decisionRationale"], message: "Record the reason for a refusal or partial response" });
  }
});

const RetentionBody = z.object({
  kind: z.literal("retention"),
  recordCategory: requiredText,
  scopeDescription: requiredText,
  retentionPeriod: requiredText,
  retentionTrigger: requiredText,
  justification: requiredText,
  legalHoldActive: z.boolean(),
  legalHoldReason: optionalText,
  deletionException: z.boolean(),
  deletionExceptionReason: optionalText,
  reviewDueAt: nullableDate,
  active: z.boolean(),
}).superRefine((body, ctx) => {
  if (body.legalHoldActive && !body.legalHoldReason?.trim()) {
    ctx.addIssue({ code: "custom", path: ["legalHoldReason"], message: "Record why the legal hold applies" });
  }
  if (body.deletionException && !body.deletionExceptionReason?.trim()) {
    ctx.addIssue({ code: "custom", path: ["deletionExceptionReason"], message: "Record the deletion exception and its basis" });
  }
});

const ProcessorBody = z.object({
  kind: z.literal("processor"),
  organizationName: requiredText,
  role: z.enum(["processor", "subprocessor"]),
  parentProcessor: optionalText,
  serviceDescription: requiredText,
  dataCategories: requiredText,
  processingCountries: requiredText,
  transferMechanism: z.enum(["not_assessed", "no_restricted_transfer", "adequacy", "uk_idta", "eu_scc", "uk_addendum", "other"]),
  transferSafeguards: optionalText,
  transferAssessment: optionalText,
  agreementStatus: z.enum(["not_assessed", "in_place", "pending", "not_required"]),
  agreementReviewedAt: nullableDate,
  transferReviewedAt: nullableDate,
  reviewDueAt: nullableDate,
  active: z.boolean(),
}).superRefine((body, ctx) => {
  if (body.role === "subprocessor" && !body.parentProcessor?.trim()) {
    ctx.addIssue({ code: "custom", path: ["parentProcessor"], message: "Name the processor that appointed this subprocessor" });
  }
  if (body.transferMechanism === "other" && !body.transferSafeguards?.trim()) {
    ctx.addIssue({ code: "custom", path: ["transferSafeguards"], message: "Describe the transfer safeguards or assessment" });
  }
});

const BreachBody = z.object({
  kind: z.literal("breach"),
  discoveredAt: dateInput,
  occurredFrom: nullableDate,
  occurredTo: nullableDate,
  description: requiredText,
  dataCategories: requiredText,
  affectedSubjectsEstimate: z.number().int().min(0).nullable(),
  affectedRecordsEstimate: z.number().int().min(0).nullable(),
  riskLevel: z.enum(["under_assessment", "unlikely", "risk", "high_risk"]),
  assessmentStatus: z.enum(["assessing", "contained", "closed"]),
  assessmentRationale: optionalText,
  containmentSteps: optionalText,
  authorityNotificationRequired: z.boolean().nullable(),
  authorityNotifiedAt: nullableDate,
  authorityNotificationReference: optionalText,
  individualNotificationRequired: z.boolean().nullable(),
  individualNotificationDueAt: nullableDate,
  individualsNotifiedAt: nullableDate,
  evidence: optionalText,
}).superRefine((body, ctx) => {
  if (body.authorityNotifiedAt && body.authorityNotificationRequired !== true) {
    ctx.addIssue({ code: "custom", path: ["authorityNotificationRequired"], message: "Mark the authority notification as required when recording that it was sent" });
  }
  if (body.individualsNotifiedAt && body.individualNotificationRequired !== true) {
    ctx.addIssue({ code: "custom", path: ["individualNotificationRequired"], message: "Mark individual notification as required when recording that it was sent" });
  }
});

const RecordBody = z.union([ActivityBody, RightsRequestBody, RetentionBody, ProcessorBody, BreachBody]);
const VerificationBody = z.object({
  outcome: z.enum(["deletion_verified", "legal_hold_confirmed", "exception_confirmed"]),
  recordsReviewed: requiredText,
  verificationMethod: requiredText,
  evidence: requiredText,
});

router.get("/privacy-governance", requireClientAdmin, async (req, res) => {
  const { clientId } = actorContext(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const [programRows, activities, rightsRequests, retentionSchedules, retentionVerifications, processors, breaches] = await Promise.all([
    db.select().from(privacyProgramsTable).where(eq(privacyProgramsTable.clientId, clientId)).limit(1),
    db.select().from(privacyProcessingActivitiesTable).where(eq(privacyProcessingActivitiesTable.clientId, clientId)).orderBy(desc(privacyProcessingActivitiesTable.updatedAt)).limit(500),
    db.select().from(privacyRightsRequestsTable).where(eq(privacyRightsRequestsTable.clientId, clientId)).orderBy(asc(privacyRightsRequestsTable.dueAt)).limit(500),
    db.select().from(privacyRetentionSchedulesTable).where(eq(privacyRetentionSchedulesTable.clientId, clientId)).orderBy(desc(privacyRetentionSchedulesTable.updatedAt)).limit(500),
    db.select().from(privacyRetentionVerificationsTable).where(eq(privacyRetentionVerificationsTable.clientId, clientId)).orderBy(desc(privacyRetentionVerificationsTable.verifiedAt)).limit(500),
    db.select().from(privacyProcessorsTable).where(eq(privacyProcessorsTable.clientId, clientId)).orderBy(desc(privacyProcessorsTable.updatedAt)).limit(500),
    db.select().from(privacyBreachesTable).where(eq(privacyBreachesTable.clientId, clientId)).orderBy(desc(privacyBreachesTable.discoveredAt)).limit(500),
  ]);

  res.json({
    program: programRows[0] ?? null,
    activities: activities.map((row) => ({ ...row, kind: "activity" })),
    rightsRequests: rightsRequests.map((row) => ({ ...row, kind: "rights_request" })),
    retentionSchedules: retentionSchedules.map((row) => ({ ...row, kind: "retention" })),
    retentionVerifications,
    processors: processors.map((row) => ({ ...row, kind: "processor" })),
    breaches: breaches.map((row) => ({ ...row, kind: "breach" })),
  });
});

router.put("/privacy-governance/program", requireClientAdmin, async (req, res) => {
  const { clientId, actorId } = actorContext(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = ProgramBody.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  const body = parsed.data;
  const values = {
    customerRole: body.customerRole,
    controllerName: body.controllerName,
    controllerContact: body.controllerContact,
    dpoContact: body.dpoContact,
    noticeUrl: body.noticeUrl,
    noticeVersion: body.noticeVersion,
    noticeReviewedAt: dateValue(body.noticeReviewedAt),
    processorAgreementStatus: body.processorAgreementStatus,
    processorAgreementReviewedAt: dateValue(body.processorAgreementReviewedAt),
    responsibilitiesNotes: body.responsibilitiesNotes,
    privacyOwner: body.privacyOwner,
    updatedBy: actorId,
    updatedAt: new Date(),
  };

  const saved = await db.transaction(async (tx) => {
    const rows = await tx.insert(privacyProgramsTable)
      .values({ clientId, ...values })
      .onConflictDoUpdate({ target: privacyProgramsTable.clientId, set: values })
      .returning();
    await writeAudit(tx, clientId, actorId, "privacy_program", rows[0].id, "updated", { section: "responsibilities_and_notice" });
    return rows[0];
  });
  res.json(saved);
});

router.post("/privacy-governance/records", requireClientAdmin, async (req, res) => {
  const { clientId, actorId } = actorContext(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = RecordBody.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  const body = parsed.data;

  const record = await db.transaction(async (tx) => {
    let row: any;
    let entityType = body.kind;
    switch (body.kind) {
      case "activity":
        {
          const { kind: _kind, ...fields } = body;
        row = (await tx.insert(privacyProcessingActivitiesTable).values({
          clientId, ...fields,
          dpiaCompletedAt: dateValue(fields.dpiaCompletedAt),
          reviewDueAt: dateValue(fields.reviewDueAt),
          createdBy: actorId, updatedBy: actorId,
        }).returning())[0];
        break;
        }
      case "rights_request": {
        const receivedAt = new Date(body.receivedAt);
        row = (await tx.insert(privacyRightsRequestsTable).values({
          clientId,
          requestType: body.requestType,
          subjectName: body.subjectName,
          subjectContact: body.subjectContact,
          scopeDescription: body.scopeDescription,
          receivedAt,
          dueAt: addCalendarMonth(receivedAt),
          extendedDueAt: dateValue(body.extendedDueAt),
          extensionReason: body.extensionReason,
          identityStatus: body.identityStatus,
          identityMethod: body.identityMethod,
          identityEvidence: body.identityEvidence,
          identityVerifiedAt: body.identityStatus === "verified" ? new Date() : null,
          identityVerifiedBy: body.identityStatus === "verified" ? actorId : null,
          status: body.status,
          decision: body.decision,
          decisionRationale: body.decisionRationale,
          decidedAt: body.decision ? new Date() : null,
          decidedBy: body.decision ? actorId : null,
          responseSentAt: dateValue(body.responseSentAt),
          responseEvidence: body.responseEvidence,
          createdBy: actorId,
          updatedBy: actorId,
        }).returning())[0];
        break;
      }
      case "retention":
        {
          const { kind: _kind, ...fields } = body;
        row = (await tx.insert(privacyRetentionSchedulesTable).values({
          clientId, ...fields,
          createdBy: actorId, updatedBy: actorId,
          reviewDueAt: dateValue(fields.reviewDueAt),
        }).returning())[0];
        break;
        }
      case "processor":
        {
          const { kind: _kind, ...fields } = body;
        row = (await tx.insert(privacyProcessorsTable).values({
          clientId, ...fields,
          agreementReviewedAt: dateValue(fields.agreementReviewedAt),
          transferReviewedAt: dateValue(fields.transferReviewedAt),
          reviewDueAt: dateValue(fields.reviewDueAt),
          createdBy: actorId, updatedBy: actorId,
        }).returning())[0];
        break;
        }
      case "breach": {
        const discoveredAt = new Date(body.discoveredAt);
        row = (await tx.insert(privacyBreachesTable).values({
          clientId,
          discoveredAt,
          occurredFrom: dateValue(body.occurredFrom),
          occurredTo: dateValue(body.occurredTo),
          description: body.description,
          dataCategories: body.dataCategories,
          affectedSubjectsEstimate: body.affectedSubjectsEstimate,
          affectedRecordsEstimate: body.affectedRecordsEstimate,
          riskLevel: body.riskLevel,
          assessmentStatus: body.assessmentStatus,
          assessmentRationale: body.assessmentRationale,
          containmentSteps: body.containmentSteps,
          authorityNotificationRequired: body.authorityNotificationRequired,
          authorityNotificationDueAt: new Date(discoveredAt.getTime() + 72 * 60 * 60 * 1000),
          authorityNotifiedAt: dateValue(body.authorityNotifiedAt),
          authorityNotificationReference: body.authorityNotificationReference,
          individualNotificationRequired: body.individualNotificationRequired,
          individualNotificationDueAt: dateValue(body.individualNotificationDueAt),
          individualsNotifiedAt: dateValue(body.individualsNotifiedAt),
          evidence: body.evidence,
          assessedAt: body.riskLevel === "under_assessment" ? null : new Date(),
          assessedBy: body.riskLevel === "under_assessment" ? null : actorId,
          closedAt: body.assessmentStatus === "closed" ? new Date() : null,
          createdBy: actorId,
          updatedBy: actorId,
        }).returning())[0];
        break;
      }
    }
    await writeAudit(tx, clientId, actorId, `privacy_${entityType}`, row.id, "created", { kind: entityType });
    return { ...row, kind: entityType };
  });
  res.status(201).json(record);
});

router.put("/privacy-governance/records/:kind/:id", requireClientAdmin, async (req, res) => {
  const { clientId, actorId } = actorContext(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = Number(req.params.id);
  const kind = String(req.params.kind);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid record id" });
  const parsed = RecordBody.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  const body = parsed.data;
  if (body.kind !== kind) return res.status(400).json({ error: "Record kind does not match the URL" });

  const result = await db.transaction(async (tx) => {
    let row: any;
    switch (body.kind) {
      case "activity":
        row = (await tx.update(privacyProcessingActivitiesTable).set({
          name: body.name,
          purpose: body.purpose,
          dataSubjects: body.dataSubjects,
          dataCategories: body.dataCategories,
          article6Basis: body.article6Basis,
          article6Rationale: body.article6Rationale,
          specialCategoryData: body.specialCategoryData,
          article9Condition: body.article9Condition,
          article9Rationale: body.article9Rationale,
          recipients: body.recipients,
          transferDetails: body.transferDetails,
          retentionCriteria: body.retentionCriteria,
          securityMeasures: body.securityMeasures,
          dpiaClassification: body.dpiaClassification,
          dpiaRationale: body.dpiaRationale,
          dpiaCompletedAt: dateValue(body.dpiaCompletedAt),
          owner: body.owner,
          reviewDueAt: dateValue(body.reviewDueAt),
          active: body.active,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(and(eq(privacyProcessingActivitiesTable.clientId, clientId), eq(privacyProcessingActivitiesTable.id, id))).returning())[0];
        break;
      case "rights_request": {
        const existing = (await tx.select().from(privacyRightsRequestsTable).where(and(
          eq(privacyRightsRequestsTable.clientId, clientId),
          eq(privacyRightsRequestsTable.id, id),
        )).limit(1))[0];
        if (!existing) return null;
        const receivedAt = new Date(body.receivedAt);
        const receivedChanged = receivedAt.getTime() !== existing.receivedAt.getTime();
        row = (await tx.update(privacyRightsRequestsTable).set({
          requestType: body.requestType,
          subjectName: body.subjectName,
          subjectContact: body.subjectContact,
          scopeDescription: body.scopeDescription,
          receivedAt,
          dueAt: receivedChanged ? addCalendarMonth(receivedAt) : existing.dueAt,
          extendedDueAt: dateValue(body.extendedDueAt),
          extensionReason: body.extensionReason,
          identityStatus: body.identityStatus,
          identityMethod: body.identityMethod,
          identityEvidence: body.identityEvidence,
          identityVerifiedAt: body.identityStatus === "verified" ? existing.identityVerifiedAt ?? new Date() : null,
          identityVerifiedBy: body.identityStatus === "verified" ? existing.identityVerifiedBy ?? actorId : null,
          status: body.status,
          decision: body.decision,
          decisionRationale: body.decisionRationale,
          decidedAt: body.decision ? existing.decidedAt ?? new Date() : null,
          decidedBy: body.decision ? existing.decidedBy ?? actorId : null,
          responseSentAt: dateValue(body.responseSentAt),
          responseEvidence: body.responseEvidence,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(and(eq(privacyRightsRequestsTable.clientId, clientId), eq(privacyRightsRequestsTable.id, id))).returning())[0];
        break;
      }
      case "retention":
        row = (await tx.update(privacyRetentionSchedulesTable).set({
          recordCategory: body.recordCategory,
          scopeDescription: body.scopeDescription,
          retentionPeriod: body.retentionPeriod,
          retentionTrigger: body.retentionTrigger,
          justification: body.justification,
          legalHoldActive: body.legalHoldActive,
          legalHoldReason: body.legalHoldReason,
          deletionException: body.deletionException,
          deletionExceptionReason: body.deletionExceptionReason,
          reviewDueAt: dateValue(body.reviewDueAt),
          active: body.active,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(and(eq(privacyRetentionSchedulesTable.clientId, clientId), eq(privacyRetentionSchedulesTable.id, id))).returning())[0];
        break;
      case "processor":
        row = (await tx.update(privacyProcessorsTable).set({
          organizationName: body.organizationName,
          role: body.role,
          parentProcessor: body.parentProcessor,
          serviceDescription: body.serviceDescription,
          dataCategories: body.dataCategories,
          processingCountries: body.processingCountries,
          transferMechanism: body.transferMechanism,
          transferSafeguards: body.transferSafeguards,
          transferAssessment: body.transferAssessment,
          agreementStatus: body.agreementStatus,
          agreementReviewedAt: dateValue(body.agreementReviewedAt),
          transferReviewedAt: dateValue(body.transferReviewedAt),
          reviewDueAt: dateValue(body.reviewDueAt),
          active: body.active,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(and(eq(privacyProcessorsTable.clientId, clientId), eq(privacyProcessorsTable.id, id))).returning())[0];
        break;
      case "breach": {
        const discoveredAt = new Date(body.discoveredAt);
        const existing = (await tx.select().from(privacyBreachesTable).where(and(
          eq(privacyBreachesTable.clientId, clientId),
          eq(privacyBreachesTable.id, id),
        )).limit(1))[0];
        if (!existing) return null;
        const discoveredChanged = discoveredAt.getTime() !== existing.discoveredAt.getTime();
        row = (await tx.update(privacyBreachesTable).set({
          discoveredAt,
          occurredFrom: dateValue(body.occurredFrom),
          occurredTo: dateValue(body.occurredTo),
          description: body.description,
          dataCategories: body.dataCategories,
          affectedSubjectsEstimate: body.affectedSubjectsEstimate,
          affectedRecordsEstimate: body.affectedRecordsEstimate,
          riskLevel: body.riskLevel,
          assessmentStatus: body.assessmentStatus,
          assessmentRationale: body.assessmentRationale,
          containmentSteps: body.containmentSteps,
          authorityNotificationRequired: body.authorityNotificationRequired,
          authorityNotificationDueAt: discoveredChanged ? new Date(discoveredAt.getTime() + 72 * 60 * 60 * 1000) : existing.authorityNotificationDueAt,
          authorityNotifiedAt: dateValue(body.authorityNotifiedAt),
          authorityNotificationReference: body.authorityNotificationReference,
          individualNotificationRequired: body.individualNotificationRequired,
          individualNotificationDueAt: dateValue(body.individualNotificationDueAt),
          individualsNotifiedAt: dateValue(body.individualsNotifiedAt),
          evidence: body.evidence,
          assessedAt: body.riskLevel === "under_assessment" ? null : existing.assessedAt ?? new Date(),
          assessedBy: body.riskLevel === "under_assessment" ? null : existing.assessedBy ?? actorId,
          closedAt: body.assessmentStatus === "closed" ? existing.closedAt ?? new Date() : null,
          updatedBy: actorId,
          updatedAt: new Date(),
        }).where(and(eq(privacyBreachesTable.clientId, clientId), eq(privacyBreachesTable.id, id))).returning())[0];
        break;
      }
    }
    if (!row) return null;
    await writeAudit(tx, clientId, actorId, `privacy_${body.kind}`, id, "updated", { kind: body.kind });
    return { ...row, kind: body.kind };
  });

  if (!result) return res.status(404).json({ error: "Privacy record not found" });
  res.json(result);
});

router.post("/privacy-governance/retention-schedules/:id/verifications", requireClientAdmin, async (req, res) => {
  const { clientId, actorId } = actorContext(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const scheduleId = Number(req.params.id);
  if (!Number.isInteger(scheduleId) || scheduleId < 1) return res.status(400).json({ error: "Invalid retention schedule id" });
  const parsed = VerificationBody.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  const created = await db.transaction(async (tx) => {
    const schedule = (await tx.select().from(privacyRetentionSchedulesTable).where(and(
      eq(privacyRetentionSchedulesTable.clientId, clientId),
      eq(privacyRetentionSchedulesTable.id, scheduleId),
    )).limit(1))[0];
    if (!schedule) return { notFound: true as const };
    if (parsed.data.outcome === "deletion_verified" && (schedule.legalHoldActive || schedule.deletionException)) {
      return { conflict: true as const };
    }
    const row = (await tx.insert(privacyRetentionVerificationsTable).values({
      clientId,
      scheduleId,
      ...parsed.data,
      verifiedBy: actorId,
    }).returning())[0];
    await writeAudit(tx, clientId, actorId, "privacy_retention_verification", row.id, "created", {
      outcome: row.outcome,
      scheduleId,
    });
    return { row };
  });

  if ("notFound" in created) return res.status(404).json({ error: "Retention schedule not found" });
  if ("conflict" in created) return res.status(409).json({ error: "Deletion cannot be verified while a legal hold or deletion exception is active" });
  res.status(201).json(created.row);
});

export default router;