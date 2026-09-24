import { Router } from "express";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { sitesTable, trackActionsTable, trackEvidenceRequirementsTable, trackEvidenceTable } from "@workspace/db/schema";
import { appendAuditEvent } from "../lib/audit";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth } from "../middleware/requireAuth";
import { ensureDefaultTrackEvidenceRequirements } from "../lib/trackEvidenceRequirements";

const router = Router();
const MODULES = ["daily_am", "daily_pm", "kitchen", "fire", "legionella", "pool", "pat", "pest", "fix", "premises", "doc", "safe", "train", "hot_tub", "tree", "bike", "green", "swim", "incident", "room"] as const;
const evidenceTypes = ["observation", "photo", "document", "certificate", "test_result", "verification", "other"] as const;
const moduleSchema = z.enum(MODULES);
const scopeSchema = z.object({ module: moduleSchema, siteId: z.number().int().positive().nullable().optional() }).strict();

const createSchema = z.object({
  module: moduleSchema,
  siteId: z.number().int().positive().nullable().optional(),
  sourceKind: z.string().trim().min(1).max(100).nullable().optional(),
  sourceRecordId: z.number().int().positive().nullable().optional(),
  actionId: z.number().int().positive().nullable().optional(),
  requirementKey: z.string().trim().min(1).max(100).nullable().optional(),
  evidenceType: z.enum(evidenceTypes).default("observation"),
  title: z.string().trim().min(1).max(300),
  details: z.string().trim().min(1).max(20_000),
  reference: z.string().trim().max(2_000).nullable().optional(),
  recordedAt: z.string().datetime().optional(),
}).strict();

const verifySchema = z.object({
  status: z.enum(["verified", "rejected"]),
  reviewNotes: z.string().trim().min(1).max(10_000),
}).strict();

async function accessibleSite(siteId: number | null | undefined, clientId: number, departmentId: number | null) {
  if (siteId == null) return true;
  const conditions = [eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)];
  if (departmentId != null) conditions.push(or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId))!);
  return Boolean((await db.select({ id: sitesTable.id }).from(sitesTable).where(and(...conditions)))[0]);
}

async function visibleSiteIds(clientId: number, departmentId: number | null) {
  if (departmentId == null) return null;
  return (await db.select({ id: sitesTable.id }).from(sitesTable).where(and(
    eq(sitesTable.clientId, clientId),
    or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId)),
  ))).map(row => row.id);
}

router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  const parsed = z.object({
    module: moduleSchema,
    siteId: z.coerce.number().int().positive().optional(),
    actionId: z.coerce.number().int().positive().optional(),
  }).safeParse(req.query);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const departmentId = getActiveDepartmentId(req);
  if (!await accessibleSite(parsed.data.siteId, clientId, departmentId)) return res.status(403).json({ error: "Forbidden site" });
  const siteIds = await visibleSiteIds(clientId, departmentId);
  const conditions = [
    eq(trackEvidenceTable.clientId, clientId),
    eq(trackEvidenceTable.module, parsed.data.module),
  ];
  if (siteIds) conditions.push(or(isNull(trackEvidenceTable.siteId), inArray(trackEvidenceTable.siteId, siteIds))!);
  if (parsed.data.siteId != null) conditions.push(eq(trackEvidenceTable.siteId, parsed.data.siteId));
  if (parsed.data.actionId != null) conditions.push(eq(trackEvidenceTable.actionId, parsed.data.actionId));
  res.json(await db.select().from(trackEvidenceTable).where(and(...conditions)).orderBy(desc(trackEvidenceTable.createdAt)));
});

router.get("/requirements", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  const parsed = z.object({
    module: moduleSchema,
    siteId: z.coerce.number().int().positive().optional(),
    actionId: z.coerce.number().int().positive().optional(),
  }).safeParse(req.query);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!await accessibleSite(parsed.data.siteId, clientId, getActiveDepartmentId(req))) return res.status(403).json({ error: "Forbidden site" });
  const requirements = await ensureDefaultTrackEvidenceRequirements(clientId, parsed.data.module);
  const evidenceConditions = [
    eq(trackEvidenceTable.clientId, clientId),
    eq(trackEvidenceTable.module, parsed.data.module),
  ];
  if (parsed.data.siteId != null) evidenceConditions.push(eq(trackEvidenceTable.siteId, parsed.data.siteId));
  if (parsed.data.actionId != null) evidenceConditions.push(eq(trackEvidenceTable.actionId, parsed.data.actionId));
  const evidence = await db.select({
    requirementKey: trackEvidenceTable.requirementKey,
    evidenceType: trackEvidenceTable.evidenceType,
    reviewStatus: trackEvidenceTable.reviewStatus,
  }).from(trackEvidenceTable).where(and(...evidenceConditions));
  res.json(requirements.map(requirement => {
    const matching = evidence.filter(item =>
      item.requirementKey === requirement.requirementKey && item.evidenceType === requirement.evidenceType,
    );
    const verifiedCount = matching.filter(item => item.reviewStatus === "verified").length;
    const recordedCount = matching.filter(item => item.reviewStatus === "recorded").length;
    const rejectedCount = matching.filter(item => item.reviewStatus === "rejected").length;
    const satisfiedCount = requirement.reviewRequired ? verifiedCount : recordedCount + verifiedCount;
    return {
      ...requirement,
      recordedCount,
      verifiedCount,
      rejectedCount,
      satisfied: satisfiedCount >= requirement.minimumCount,
      missingCount: Math.max(0, requirement.minimumCount - satisfiedCount),
    };
  }));
});

router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  const parsed = createSchema.safeParse(req.body);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const departmentId = getActiveDepartmentId(req);
  const result = await db.transaction(async tx => {
    let siteId = parsed.data.siteId ?? null;
    if (!await accessibleSite(siteId, clientId, departmentId)) return { status: 403 as const, error: "Forbidden site" };
    if (parsed.data.actionId != null) {
      const [action] = await tx.select({
        id: trackActionsTable.id,
        module: trackActionsTable.module,
        siteId: trackActionsTable.siteId,
      }).from(trackActionsTable).where(and(
        eq(trackActionsTable.id, parsed.data.actionId),
        eq(trackActionsTable.clientId, clientId),
      )).for("update");
      if (!action || action.module !== parsed.data.module) return { status: 404 as const, error: "Action not found" };
      if (siteId != null && siteId !== action.siteId) return { status: 400 as const, error: "Evidence site must match its action" };
      siteId = action.siteId;
    }
    if (parsed.data.requirementKey != null) {
      if (parsed.data.actionId == null) return { status: 400 as const, error: "Required evidence must be linked to the corrective action being signed off" };
      const requirements = await ensureDefaultTrackEvidenceRequirements(clientId, parsed.data.module);
      const requirement = requirements.find(item => item.requirementKey === parsed.data.requirementKey);
      if (!requirement) return { status: 400 as const, error: "Unknown evidence requirement" };
      if (requirement.evidenceType !== parsed.data.evidenceType) return { status: 400 as const, error: `This requirement expects ${requirement.evidenceType} evidence` };
    }
    const [row] = await tx.insert(trackEvidenceTable).values({
      clientId,
      siteId,
      module: parsed.data.module,
      sourceKind: parsed.data.sourceKind ?? null,
      sourceRecordId: parsed.data.sourceRecordId ?? null,
      actionId: parsed.data.actionId ?? null,
      requirementKey: parsed.data.requirementKey ?? null,
      evidenceType: parsed.data.evidenceType,
      title: parsed.data.title,
      details: parsed.data.details,
      reference: parsed.data.reference ?? null,
      recordedBy: req.currentUser!.id,
      recordedByName: req.currentUser!.name,
      recordedAt: parsed.data.recordedAt ? new Date(parsed.data.recordedAt) : new Date(),
    }).returning();
    return { status: 201 as const, row };
  });
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  await appendAuditEvent(req, {
    clientId,
    entityType: "track_evidence",
    entityId: result.row.id,
    action: "created",
    after: result.row,
  });
  res.status(201).json(result.row);
});

// Evidence content is immutable. Only its independent review outcome can change.
router.post("/:id/review", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  const parsed = verifySchema.safeParse(req.body);
  if (!clientId || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid evidence id" });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await db.transaction(async tx => {
    const [current] = await tx.select().from(trackEvidenceTable).where(and(
      eq(trackEvidenceTable.id, id),
      eq(trackEvidenceTable.clientId, clientId),
    )).for("update");
    if (!current) return { status: 404 as const, error: "Evidence not found" };
    if (current.reviewStatus !== "recorded") return { status: 409 as const, error: "Evidence has already been reviewed" };
    if (current.recordedBy === req.currentUser!.id) return { status: 400 as const, error: "Evidence must be reviewed by another authenticated user" };
    if (!await accessibleSite(current.siteId, clientId, getActiveDepartmentId(req))) return { status: 403 as const, error: "Forbidden site" };
    const [row] = await tx.update(trackEvidenceTable).set({
      reviewStatus: parsed.data.status,
      reviewedBy: req.currentUser!.id,
      reviewedByName: req.currentUser!.name,
      reviewedAt: new Date(),
      reviewNotes: parsed.data.reviewNotes,
    }).where(and(eq(trackEvidenceTable.id, id), eq(trackEvidenceTable.clientId, clientId), eq(trackEvidenceTable.reviewStatus, "recorded"))).returning();
    if (!row) return { status: 409 as const, error: "Evidence has already been reviewed" };
    return { status: 200 as const, row, before: current };
  });
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  await appendAuditEvent(req, {
    clientId,
    entityType: "track_evidence",
    entityId: id,
    action: "reviewed",
    before: result.before,
    after: result.row,
  });
  res.json(result.row);
});

export default router;