import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sitesTable, trackControlProfilesTable, auditEventsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { getActiveDepartmentId, getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";

type Unit = "frequencyDays" | "frequencyHours";
type Plan = Record<string, any>;

export function approvedFrequencies(
  raw: unknown, checkTypes: readonly string[], unit: Unit,
): Record<string, number> | null {
  const plan = raw as Plan | null;
  if (!plan || !plan.approvedAt || plan.reviewRequired ||
      !plan.riskAssessmentReference?.trim() || !plan.writtenSchemeReference?.trim() ||
      !plan.competentPerson?.trim()) return null;
  const frequencies = plan[unit];
  if (!frequencies || checkTypes.some(type =>
    !Number.isInteger(frequencies[type]) || frequencies[type] < 1 || frequencies[type] > (unit === "frequencyHours" ? 87600 : 3650)
  )) return null;
  return frequencies;
}

/**
 * Profiles are deliberately scoped to a site and to a track. A manager can
 * flag a material change without erasing the prior scheme; no due state is
 * calculated again until the revised plan has been approved.
 */
export function createMonitoringPlanRouter(module: string, checkTypes: readonly string[], unit: Unit) {
  const router = Router();
  const schema = z.object({
    action: z.enum(["approve", "flag_change"]),
    riskAssessmentReference: z.string().trim().min(1).max(2000).optional(),
    writtenSchemeReference: z.string().trim().min(1).max(2000).optional(),
    competentPerson: z.string().trim().min(1).max(500).optional(),
    materialChangeNote: z.string().trim().max(2000).optional(),
    frequencies: z.record(z.string(), z.number().int().min(1).max(unit === "frequencyHours" ? 87600 : 3650)).optional(),
  }).strict();

  async function siteContext(req: any) {
    const clientId = getClientId(req);
    const raw = req.query.siteId;
    if (!clientId || typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) ||
        !Number.isSafeInteger(Number(raw))) return { error: 400 as const };
    const siteId = Number(raw);
    const [site] = await db.select({ departmentId: sitesTable.departmentId }).from(sitesTable)
      .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
    if (!site) return { error: 404 as const };
    const deptId = getActiveDepartmentId(req);
    if (deptId !== null && site.departmentId !== null && site.departmentId !== deptId) return { error: 403 as const };
    return { clientId, siteId };
  }

  router.get("/", requireAuth, async (req, res) => {
    const context = await siteContext(req);
    if (context.error) return res.status(context.error).json({ error: "Site not accessible" });
    const [row] = await db.select({ profile: trackControlProfilesTable.profile }).from(trackControlProfilesTable)
      .where(and(eq(trackControlProfilesTable.clientId, context.clientId),
        eq(trackControlProfilesTable.siteId, context.siteId), eq(trackControlProfilesTable.module, module))).limit(1);
    const profile = (row?.profile ?? {}) as Plan;
    res.json({ profile, approved: approvedFrequencies(profile, checkTypes, unit) !== null });
  });

  router.put("/", requireAuth, requireClientAdmin, async (req, res) => {
    const context = await siteContext(req);
    if (context.error) return res.status(context.error).json({ error: "Site not accessible" });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const input = parsed.data;
    if (input.action === "flag_change" && !input.materialChangeNote) {
      return res.status(400).json({ error: "Describe the material change needing review" });
    }
    if (input.action === "approve" && (
      !input.riskAssessmentReference || !input.writtenSchemeReference || !input.competentPerson ||
      !input.frequencies || Object.keys(input.frequencies).some(key => !checkTypes.includes(key)) ||
      checkTypes.some(key => input.frequencies?.[key] == null)
    )) return res.status(400).json({ error: "Record all scheme references, competent person and check frequencies before approval" });

    const after = await db.transaction(async tx => {
      const [previous] = await tx.select({ profile: trackControlProfilesTable.profile }).from(trackControlProfilesTable)
        .where(and(eq(trackControlProfilesTable.clientId, context.clientId),
          eq(trackControlProfilesTable.siteId, context.siteId), eq(trackControlProfilesTable.module, module))).limit(1);
      const before = (previous?.profile ?? {}) as Plan;
      const profile = input.action === "flag_change"
        ? { ...before, reviewRequired: true, materialChangeNote: input.materialChangeNote, approvedAt: null, approvedBy: null }
        : {
            ...before, riskAssessmentReference: input.riskAssessmentReference,
            writtenSchemeReference: input.writtenSchemeReference, competentPerson: input.competentPerson,
            [unit]: input.frequencies, reviewRequired: false, materialChangeNote: null,
            approvedAt: new Date().toISOString(), approvedBy: req.currentUser?.id ?? null,
          };
      await tx.insert(trackControlProfilesTable).values({
        clientId: context.clientId, siteId: context.siteId, module, profile,
      }).onConflictDoUpdate({
        target: [trackControlProfilesTable.clientId, trackControlProfilesTable.siteId, trackControlProfilesTable.module],
        set: { profile, updatedAt: new Date() },
      });
      await tx.insert(auditEventsTable).values({
        clientId: context.clientId, actorId: req.currentUser?.id ?? null,
        entityType: `${module}_monitoring_plan`, entityId: context.siteId,
        action: input.action === "approve" ? "approved" : "review_required", before, after: profile,
      });
      return profile;
    });
    res.json({ profile: after, approved: approvedFrequencies(after, checkTypes, unit) !== null });
  });
  return router;
}