import { Router } from "express";
import { db } from "@workspace/db";
import { auditEventsTable, departmentsTable, fixTrackIssueActivityTable, fixTrackIssuesTable, sitesTable, trackActionTemplatesTable, trackActionsTable, trackEvidenceTable } from "@workspace/db/schema";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";
import { missingEvidenceForAction } from "../lib/trackEvidenceRequirements";

const router = Router();
const MODULES = ["daily_am", "daily_pm", "kitchen", "fire", "legionella", "pool", "pat", "pest", "fix", "premises", "doc", "safe", "train", "hot_tub", "tree", "bike", "green", "swim", "incident", "room"] as const;
const severity = z.enum(["monitor", "action_required", "urgent"]);
const nullableText = z.string().trim().max(10_000).nullable().optional();
const drawnSignature = z.string().max(250_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
const scopeFields = {
  siteId: z.number().int().positive().nullable().optional(),
  departmentId: z.number().int().positive().nullable().optional(),
};
const templateFields = {
  module: z.enum(MODULES).nullable().optional(),
  ...scopeFields,
  title: z.string().trim().min(1).max(500),
  instruction: z.string().trim().min(1).max(10_000),
  severity: severity.default("action_required"),
  ownerDefault: nullableText,
  leadTimeDays: z.number().int().min(0).max(3650).default(0),
  sortOrder: z.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true),
};
const templateCreateSchema = z.object(templateFields).strict();
const templatePatchSchema = z.object({
  module: z.enum(MODULES).nullable().optional(), ...scopeFields,
  title: z.string().trim().min(1).max(500).optional(), instruction: z.string().trim().min(1).max(10_000).optional(),
  severity: severity.optional(), ownerDefault: nullableText,
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(), active: z.boolean().optional(),
}).strict();
const oneOffFields = {
  module: z.enum(MODULES),
  title: z.string().trim().min(1).max(500).optional(),
  instruction: nullableText,
  severity: severity.optional(),
  ownerName: nullableText,
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  dueDate: z.string().date().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
  sourceRecordId: z.number().int().positive().nullable().optional(),
  remedialAction: nullableText,
  evidenceReference: nullableText,
  resolutionNotes: nullableText,
};
const createSchema = z.object({ templateId: z.number().int().positive().optional(), status: z.enum(["open", "in_progress"]).default("open"), ...oneOffFields }).strict()
  .superRefine((value, ctx) => {
    if (!value.templateId && (!value.module || !value.title || !value.severity)) ctx.addIssue({ code: "custom", message: "templateId or module, title and severity are required" });
  });
const patchSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(), instruction: nullableText, severity: severity.optional(),
  status: z.enum(["open", "in_progress", "resolved"]).optional(), siteId: z.number().int().positive().nullable().optional(),
  ownerName: nullableText, dueDate: z.string().date().nullable().optional(), remedialAction: nullableText,
  evidenceReference: nullableText, resolutionNotes: nullableText,
  resolverSignature: drawnSignature.optional(),
}).strict();
const fixTrackDecisionSchema = z.object({ create: z.boolean() }).strict();

async function canAccessSite(siteId: number | null | undefined, clientId: number, departmentId: number | null) {
  if (siteId == null) return true;
  const conditions = [eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)];
  if (departmentId != null) conditions.push(or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId))!);
  return !!(await db.select({ id: sitesTable.id }).from(sitesTable).where(and(...conditions)))[0];
}
async function canOwnScope(siteId: number | null | undefined, departmentId: number | null | undefined, clientId: number) {
  if (siteId != null && !await canAccessSite(siteId, clientId, null)) return false;
  if (departmentId != null && !(await db.select({ id: departmentsTable.id }).from(departmentsTable).where(and(eq(departmentsTable.id, departmentId), eq(departmentsTable.clientId, clientId))))[0]) return false;
  if (siteId != null && departmentId != null && !(await db.select({ id: sitesTable.id }).from(sitesTable).where(and(eq(sitesTable.id, siteId), eq(sitesTable.departmentId, departmentId))))[0]) return false;
  return true;
}
async function accessibleSiteIds(clientId: number, departmentId: number | null) {
  if (departmentId == null) return null;
  return (await db.select({ id: sitesTable.id }).from(sitesTable).where(and(eq(sitesTable.clientId, clientId), or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId))))).map(x => x.id);
}
async function scopeDepartmentId(clientId: number, siteId: number | undefined, activeDepartmentId: number | null) {
  if (activeDepartmentId != null || siteId == null) return activeDepartmentId;
  const [site] = await db.select({ departmentId: sitesTable.departmentId }).from(sitesTable).where(and(
    eq(sitesTable.id, siteId),
    eq(sitesTable.clientId, clientId),
  ));
  return site?.departmentId ?? null;
}
function matchingConditions(clientId: number, module: typeof MODULES[number], siteId: number | undefined, departmentId: number | null) {
  const conditions = [eq(trackActionTemplatesTable.clientId, clientId), or(isNull(trackActionTemplatesTable.module), eq(trackActionTemplatesTable.module, module))!, eq(trackActionTemplatesTable.active, true)];
  conditions.push(siteId == null ? isNull(trackActionTemplatesTable.siteId) : or(isNull(trackActionTemplatesTable.siteId), eq(trackActionTemplatesTable.siteId, siteId))!);
  conditions.push(departmentId == null ? isNull(trackActionTemplatesTable.departmentId) : or(isNull(trackActionTemplatesTable.departmentId), eq(trackActionTemplatesTable.departmentId, departmentId))!);
  return conditions;
}
// A module-specific template beats a module-global one at the same site/
// department scope. Site + department remains the most specific combination.
const specificity = sql<number>`(
  CASE WHEN ${trackActionTemplatesTable.module} IS NULL THEN 0 ELSE 1 END +
  CASE WHEN ${trackActionTemplatesTable.siteId} IS NULL THEN 0 ELSE 2 END +
  CASE WHEN ${trackActionTemplatesTable.departmentId} IS NULL THEN 0 ELSE 2 END
)`;

// Active templates suitable for the action form. Restricted users cannot use a
// site they cannot see, and receive only their department/global catalogue.
router.get("/templates/matching", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const query = z.object({ module: z.enum(MODULES), siteId: z.coerce.number().int().positive().optional() }).safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.flatten() });
  const activeDepartmentId = getActiveDepartmentId(req);
  if (!await canAccessSite(query.data.siteId, clientId, activeDepartmentId)) return res.status(403).json({ error: "Forbidden site" });
  const departmentId = await scopeDepartmentId(clientId, query.data.siteId, activeDepartmentId);
  res.json(await db.select().from(trackActionTemplatesTable).where(and(...matchingConditions(clientId, query.data.module, query.data.siteId, departmentId))).orderBy(desc(specificity), asc(trackActionTemplatesTable.sortOrder), asc(trackActionTemplatesTable.id)));
});

router.get("/templates", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  res.json(await db.select().from(trackActionTemplatesTable).where(eq(trackActionTemplatesTable.clientId, clientId)).orderBy(asc(trackActionTemplatesTable.module), asc(trackActionTemplatesTable.sortOrder), asc(trackActionTemplatesTable.id)));
});
router.post("/templates", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); const parsed = templateCreateSchema.safeParse(req.body);
  if (!clientId) return res.status(400).json({ error: "No client context" }); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await db.transaction(async (tx) => {
    const [site] = parsed.data.siteId == null ? [null] : await tx.select({ clientId: sitesTable.clientId, departmentId: sitesTable.departmentId }).from(sitesTable).where(eq(sitesTable.id, parsed.data.siteId)).for("update");
    const [department] = parsed.data.departmentId == null ? [null] : await tx.select({ clientId: departmentsTable.clientId }).from(departmentsTable).where(eq(departmentsTable.id, parsed.data.departmentId)).for("update");
    if ((parsed.data.siteId != null && site?.clientId !== clientId)
      || (parsed.data.departmentId != null && department?.clientId !== clientId)
      || (site && parsed.data.departmentId != null && site.departmentId !== parsed.data.departmentId)) return null;
    const [row] = await tx.insert(trackActionTemplatesTable).values({ ...parsed.data, clientId, siteId: parsed.data.siteId ?? null, departmentId: parsed.data.departmentId ?? null, instruction: parsed.data.instruction, ownerDefault: parsed.data.ownerDefault ?? null }).returning();
    return row;
  });
  if (!result) return res.status(400).json({ error: "Template scope must belong to this client" });
  res.status(201).json(result);
});
router.patch("/templates/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id); const parsed = templatePatchSchema.safeParse(req.body);
  if (!clientId || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid request" }); if (!parsed.success || !Object.keys(parsed.data).length) return res.status(400).json({ error: parsed.success ? "No changes supplied" : parsed.error.flatten() });
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(trackActionTemplatesTable).where(and(eq(trackActionTemplatesTable.id, id), eq(trackActionTemplatesTable.clientId, clientId))).for("update");
    if (!current) return { status: 404 as const, error: "Template not found" };
    const next = { ...current, ...parsed.data };
    const [site] = next.siteId == null ? [null] : await tx.select({ clientId: sitesTable.clientId, departmentId: sitesTable.departmentId }).from(sitesTable).where(eq(sitesTable.id, next.siteId)).for("update");
    const [department] = next.departmentId == null ? [null] : await tx.select({ clientId: departmentsTable.clientId }).from(departmentsTable).where(eq(departmentsTable.id, next.departmentId)).for("update");
    if ((next.siteId != null && site?.clientId !== clientId)
      || (next.departmentId != null && department?.clientId !== clientId)
      || (site && next.departmentId != null && site.departmentId !== next.departmentId)) {
      return { status: 400 as const, error: "Template scope must belong to this client" };
    }
    const [row] = await tx.update(trackActionTemplatesTable).set({ ...parsed.data, updatedAt: new Date() }).where(and(eq(trackActionTemplatesTable.id, id), eq(trackActionTemplatesTable.clientId, clientId))).returning();
    return { status: 200 as const, row };
  });
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  res.json(result.row);
});
router.delete("/templates/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id); if (!clientId || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const [row] = await db.delete(trackActionTemplatesTable).where(and(eq(trackActionTemplatesTable.id, id), eq(trackActionTemplatesTable.clientId, clientId))).returning({ id: trackActionTemplatesTable.id }); if (!row) return res.status(404).json({ error: "Template not found" }); res.status(204).end();
});
router.post("/templates/reorder", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req); const parsed = z.object({ templateIds: z.array(z.number().int().positive()).min(1).max(1000) }).strict().safeParse(req.body);
  if (!clientId || !parsed.success || new Set(parsed.success ? parsed.data.templateIds : []).size !== (parsed.success ? parsed.data.templateIds.length : 0)) return res.status(400).json({ error: "templateIds must be a unique non-empty list" });
  const rows = await db.transaction(async (tx) => {
    const found = await tx.select({ id: trackActionTemplatesTable.id }).from(trackActionTemplatesTable).where(and(eq(trackActionTemplatesTable.clientId, clientId), inArray(trackActionTemplatesTable.id, parsed.data.templateIds))).for("update");
    if (found.length !== parsed.data.templateIds.length) return null;
    for (const [sortOrder, id] of parsed.data.templateIds.entries()) {
      await tx.update(trackActionTemplatesTable).set({ sortOrder, updatedAt: new Date() }).where(and(eq(trackActionTemplatesTable.id, id), eq(trackActionTemplatesTable.clientId, clientId)));
    }
    return tx.select().from(trackActionTemplatesTable).where(and(eq(trackActionTemplatesTable.clientId, clientId), inArray(trackActionTemplatesTable.id, parsed.data.templateIds))).orderBy(asc(trackActionTemplatesTable.sortOrder));
  });
  if (!rows) return res.status(404).json({ error: "Template not found" });
  res.json(rows);
});

router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req); if (!clientId) return res.status(400).json({ error: "No client context" });
  const query = z.object({ module: z.enum(MODULES), siteId: z.coerce.number().int().positive().optional() }).safeParse(req.query); if (!query.success) return res.status(400).json({ error: query.error.flatten() });
  const departmentId = getActiveDepartmentId(req);
  if (!await canAccessSite(query.data.siteId, clientId, departmentId)) return res.status(403).json({ error: "Forbidden site" });
  const siteIds = await accessibleSiteIds(clientId, departmentId); const conditions = [eq(trackActionsTable.clientId, clientId), eq(trackActionsTable.module, query.data.module)];
  if (siteIds) conditions.push(or(isNull(trackActionsTable.siteId), inArray(trackActionsTable.siteId, siteIds))!); if (query.data.siteId) conditions.push(or(isNull(trackActionsTable.siteId), eq(trackActionsTable.siteId, query.data.siteId))!);
  res.json(await db.select().from(trackActionsTable).where(and(...conditions)).orderBy(desc(trackActionsTable.createdAt)));
});
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req); const parsed = createSchema.safeParse(req.body); if (!clientId) return res.status(400).json({ error: "No client context" }); if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const activeDepartmentId = getActiveDepartmentId(req);
  const createValues = (template?: typeof trackActionTemplatesTable.$inferSelect) => {
    const leadTimeDays = template ? template.leadTimeDays : parsed.data.leadTimeDays ?? null;
    const dueDate = template
      ? new Date(Date.now() + template.leadTimeDays * 86400000).toISOString().slice(0, 10)
      : parsed.data.dueDate ?? (leadTimeDays == null ? null : new Date(Date.now() + leadTimeDays * 86400000).toISOString().slice(0, 10));
    return {
      clientId, createdBy: req.currentUser!.id, status: parsed.data.status,
      siteId: parsed.data.siteId ?? null, sourceRecordId: parsed.data.sourceRecordId ?? null,
      templateId: template?.id ?? null, provenance: template ? "template" : "one_off",
      module: parsed.data.module, title: template?.title ?? parsed.data.title!,
      instruction: template?.instruction ?? parsed.data.instruction ?? null,
      severity: template?.severity ?? parsed.data.severity!,
      ownerName: template?.ownerDefault ?? parsed.data.ownerName ?? null,
      leadTimeDays, dueDate, remedialAction: parsed.data.remedialAction ?? null,
      evidenceReference: parsed.data.evidenceReference ?? null, resolutionNotes: parsed.data.resolutionNotes ?? null,
    };
  };
  const result = await db.transaction(async (tx) => {
    let departmentId = activeDepartmentId;
    if (parsed.data.siteId != null) {
      const [site] = await tx.select({
        clientId: sitesTable.clientId,
        departmentId: sitesTable.departmentId,
      }).from(sitesTable).where(eq(sitesTable.id, parsed.data.siteId)).for("update");
      if (!site || site.clientId !== clientId
        || (activeDepartmentId != null && site.departmentId != null && site.departmentId !== activeDepartmentId)) {
        return { status: 403 as const, error: "Forbidden site" };
      }
      if (activeDepartmentId == null) departmentId = site.departmentId;
    }
    if (!parsed.data.templateId) {
      const [created] = await tx.insert(trackActionsTable).values(createValues()).returning();
      return { status: 201 as const, row: created };
    }
    const [template] = await tx.select().from(trackActionTemplatesTable).where(and(
      eq(trackActionTemplatesTable.id, parsed.data.templateId!),
      ...matchingConditions(clientId, parsed.data.module, parsed.data.siteId ?? undefined, departmentId),
    )).for("update");
    if (!template) return { status: 404 as const, error: "Active matching template not found" };
    const [created] = await tx.insert(trackActionsTable).values(createValues(template)).returning();
    return { status: 201 as const, row: created };
  });
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.row);
});
router.post("/:id/fix-track", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id); const parsed = fixTrackDecisionSchema.safeParse(req.body);
  if (!clientId || !Number.isInteger(id) || id <= 0 || !parsed.success) return res.status(400).json({ error: "Invalid request" });
  const departmentId = getActiveDepartmentId(req);
  const result = await db.transaction(async (tx) => {
    const [action] = await tx.select().from(trackActionsTable).where(and(eq(trackActionsTable.id, id), eq(trackActionsTable.clientId, clientId))).for("update");
    if (!action) return { status: 404 as const, error: "Action not found" };
    if (action.module === "green") return { status: 400 as const, error: "GreenTrack actions stay within GreenTrack" };
    if (action.status === "resolved") return { status: 409 as const, error: "Resolved actions cannot be sent to FixTrack" };
    if (action.module === "kitchen" && action.sourceKind?.startsWith("kitchen_temperature_") && parsed.data.create) {
      return { status: 409 as const, error: "Temperature corrective actions must stay in KitchenTrack for manager verification; raise a separate maintenance issue if necessary" };
    }
    if (!await canAccessSite(action.siteId, clientId, departmentId)) return { status: 403 as const, error: "Forbidden site" };
    if (!parsed.data.create) {
      const [row] = await tx.update(trackActionsTable).set({ fixTrackDisposition: "not_needed", updatedAt: new Date() }).where(eq(trackActionsTable.id, action.id)).returning();
      return { status: 200 as const, row };
    }
    if (action.fixTrackIssueId) return { status: 200 as const, row: action };
    const [site] = action.siteId ? await tx.select({ name: sitesTable.name }).from(sitesTable).where(and(eq(sitesTable.id, action.siteId), eq(sitesTable.clientId, clientId))).limit(1) : [];
    const [issue] = await tx.insert(fixTrackIssuesTable).values({
      clientId, siteId: action.siteId, title: action.title, issueType: "general",
      location: site?.name ?? "See originating module action",
      description: [action.instruction, `Originating module: ${action.module}`, `Module action: ${action.id}`].filter(Boolean).join("\n"),
      priority: action.severity === "urgent" ? "urgent" : action.severity === "action_required" ? "high" : "medium",
      status: "reported", reportedBy: req.currentUser!.name, reportedDate: new Date().toISOString().slice(0, 10),
      targetDate: action.dueDate, assignedTo: action.ownerName, createdBy: req.currentUser!.id,
    }).returning();
    await tx.insert(fixTrackIssueActivityTable).values({ clientId, issueId: issue.id, eventType: "status", status: "reported", createdBy: req.currentUser!.id });
    const [row] = await tx.update(trackActionsTable).set({ fixTrackIssueId: issue.id, fixTrackDisposition: "linked", updatedAt: new Date() }).where(and(eq(trackActionsTable.id, action.id), isNull(trackActionsTable.fixTrackIssueId))).returning();
    if (!row) return { status: 409 as const, error: "This action was linked by another user" };
    return { status: 201 as const, row };
  });
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  res.status(result.status).json(result.row);
});
router.patch("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req); const id = Number(req.params.id); const parsed = patchSchema.safeParse(req.body); if (!clientId || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" }); if (!parsed.success || !Object.keys(parsed.data).length) return res.status(400).json({ error: parsed.success ? "No changes supplied" : parsed.error.flatten() });
  if (parsed.data.resolverSignature && parsed.data.status !== "resolved") return res.status(400).json({ error: "A resolver signature can only be submitted with final resolution" });
  const departmentId = getActiveDepartmentId(req);
  const result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(trackActionsTable).where(and(eq(trackActionsTable.id, id), eq(trackActionsTable.clientId, clientId))).for("update");
    if (!current) return { status: 404 as const, error: "Action not found" };
    const siteIds = [...new Set([current.siteId, parsed.data.siteId].filter((value): value is number => value != null))].sort((a, b) => a - b);
    const sites = siteIds.length ? await tx.select({ id: sitesTable.id, clientId: sitesTable.clientId, departmentId: sitesTable.departmentId }).from(sitesTable).where(inArray(sitesTable.id, siteIds)).for("update") : [];
    const canUse = (siteId: number | null | undefined) => siteId == null || sites.some(site => site.id === siteId && site.clientId === clientId && (departmentId == null || site.departmentId == null || site.departmentId === departmentId));
    if (!canUse(current.siteId) || ("siteId" in parsed.data && !canUse(parsed.data.siteId))) return { status: 403 as const, error: "Forbidden site" };
    if (current.sourceKind && "siteId" in parsed.data && parsed.data.siteId !== current.siteId) {
      return { status: 409 as const, error: "The source record controls this action's site" };
    }
    const kitchenFailure = current.module === "kitchen" && current.sourceKind?.startsWith("kitchen_temperature_");
    if (kitchenFailure) {
      if (!["client_admin", "consultant"].includes(req.currentUser!.role)) return { status: 403 as const, error: "A manager must assign, resolve and verify failed-temperature actions" };
      if ("instruction" in parsed.data || "title" in parsed.data || "severity" in parsed.data) return { status: 409 as const, error: "The failed temperature and original control rule are immutable" };
    }
    if (current.status === "resolved") return { status: 409 as const, error: "Resolved actions cannot be edited or reopened" };
    const nextStatus = parsed.data.status ?? current.status; const filled = (v: string | null | undefined) => !!v?.trim();
    if (nextStatus === "resolved" && current.fixTrackIssueId) return { status: 409 as const, error: "Resolve the linked FixTrack issue to complete this action" };
    if (nextStatus === "resolved" && (!filled(parsed.data.remedialAction ?? current.remedialAction) || !filled(parsed.data.evidenceReference ?? current.evidenceReference) || !filled(parsed.data.resolutionNotes ?? current.resolutionNotes) || !parsed.data.resolverSignature)) {
      return { status: 400 as const, error: "remedialAction, evidenceReference, resolutionNotes and a drawn signature are required to resolve an action" };
    }
    if (nextStatus === "resolved") {
      if (kitchenFailure) {
        const proof = await tx.select({ id: trackEvidenceTable.id }).from(trackEvidenceTable).where(and(
          eq(trackEvidenceTable.clientId, clientId), eq(trackEvidenceTable.actionId, current.id),
          eq(trackEvidenceTable.module, "kitchen"), eq(trackEvidenceTable.requirementKey, "temperature_control_restored"),
          eq(trackEvidenceTable.evidenceType, "verification"), ne(trackEvidenceTable.reviewStatus, "rejected"),
        )).for("share");
        if (!proof.length) return { status: 400 as const, error: "Record corrective-action verification evidence before manager sign-off" };
      }
      const missingEvidence = await missingEvidenceForAction(clientId, current);
      if (missingEvidence.length) {
        return {
          status: 400 as const,
          error: "Required inspection evidence is missing or not independently verified",
          missingEvidence: missingEvidence.map(item => ({
            requirementKey: item.requirementKey,
            title: item.title,
            evidenceType: item.evidenceType,
            reviewRequired: item.reviewRequired,
          })),
        };
      }
      if (current.severity === "urgent") {
        const [reviewedEvidence] = await tx.select({ id: trackEvidenceTable.id })
          .from(trackEvidenceTable)
          .where(and(
            eq(trackEvidenceTable.clientId, clientId),
            eq(trackEvidenceTable.actionId, current.id),
            eq(trackEvidenceTable.reviewStatus, "verified"),
          ))
          .limit(1);
        if (!reviewedEvidence) {
          return {
            status: 400 as const,
            error: "Urgent actions require at least one independently reviewed evidence record before resolution",
          };
        }
      }
    }
    const updates: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
    if (nextStatus === "resolved") {
      const resolverName = req.currentUser!.name?.trim();
      if (!resolverName) return { status: 400 as const, error: "Your account must have a name before resolving an action" };
      updates.resolvedBy = req.currentUser!.id;
      updates.resolvedByName = resolverName;
      updates.resolvedAt = new Date();
    }
    const [row] = await tx.update(trackActionsTable).set(updates as any).where(and(eq(trackActionsTable.id, id), eq(trackActionsTable.clientId, clientId), ne(trackActionsTable.status, "resolved"))).returning();
    if (!row) return { status: 409 as const, error: "Resolved actions cannot be edited or reopened" };
    if (kitchenFailure) await tx.insert(auditEventsTable).values({
      clientId, actorId: req.currentUser!.id, entityType: "track_action", entityId: id,
      action: nextStatus === "resolved" ? "manager_verified_and_resolved" : "updated",
      before: current, after: row, metadata: { module: "kitchen" },
    });
    return { status: 200 as const, row };
  });
  if ("error" in result) return res.status(result.status).json({ error: result.error, ...("missingEvidence" in result ? { missingEvidence: result.missingEvidence } : {}) });
  res.json(result.row);
});
export default router;