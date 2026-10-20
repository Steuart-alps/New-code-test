import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { complianceItemsTable, contractorsTable, sitesTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { appendAuditEvent } from "../lib/audit";
import { supersedeStaleReminderCycles } from "../lib/reminderCycles";
import {
  entitledVisitTypes, linkedVisitChecks, syncContractorVisitChecks, trackDueDates,
} from "../lib/contractorVisits";

/**
 * Contractor visits kept on the tracks, one row per visit type and site, with
 * the contractor who gets the reminder (lib/contractorVisits.ts).
 */
const router = Router();

const day = (value: Date | string | null | undefined) => (value == null ? null : new Date(value).toISOString().slice(0, 10));

router.get("/contractor-visits", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  await syncContractorVisitChecks(clientId);
  const departmentId = getActiveDepartmentId(req);
  const [types, sites, contractors] = await Promise.all([
    entitledVisitTypes(clientId),
    db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable).where(and(
      eq(sitesTable.clientId, clientId),
      departmentId === null ? undefined : sitesTableVisibleTo(departmentId),
    )).orderBy(sitesTable.name, sitesTable.id),
    db.select({ id: contractorsTable.id, name: contractorsTable.name, company: contractorsTable.company, email: contractorsTable.email })
      .from(contractorsTable).where(eq(contractorsTable.clientId, clientId)).orderBy(contractorsTable.name),
  ]);
  const [due, linked] = await Promise.all([trackDueDates(clientId, types), linkedVisitChecks(clientId, types)]);
  const checkFor = new Map(linked.map((link) => [`${link.type.key}@${link.siteId}`, link.check]));
  const contractorById = new Map(contractors.map((contractor) => [contractor.id, contractor]));

  const visits = types.flatMap((type) => sites.map((site) => {
    const check = checkFor.get(`${type.key}@${site.id}`);
    const contractor = check?.contractorId != null ? contractorById.get(check.contractorId) : undefined;
    return {
      visitKey: type.key,
      siteId: site.id,
      siteName: site.name,
      trackDueDate: due.get(type.key)?.get(site.id) ?? null,
      checkId: check?.id ?? null,
      checkSiteId: check ? check.siteId : null,
      dueDate: day(check?.dueDate),
      status: check?.status ?? null,
      contractorId: contractor?.id ?? null,
      contractorName: contractor ? [contractor.name, contractor.company].filter(Boolean).join(", ") : null,
      reminderSentAt: check?.notificationSentAt ? new Date(check.notificationSentAt).toISOString() : null,
    };
  }));

  res.json({
    types: types.map(({ key, module, trackLabel, title, label, description, dueFrom }) =>
      ({ key, module, trackLabel, title, label, description, dueFrom })),
    visits,
  });
});

const VisitBody = z.object({
  visitKey: z.string().min(1),
  siteId: z.number().int().positive(),
  contractorId: z.number().int().positive().nullable(),
  /** Only for a visit the track gives no date for: water sampling, or a
   *  site with nothing recorded on the track yet. */
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

/**
 * Choose the contractor reminded about a visit at a site. The visit's
 * compliance check is created the first time, due on the track's date.
 */
router.put("/contractor-visits", requireAuth, requireClientAdmin, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const body = VisitBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const { visitKey, siteId, contractorId } = body.data;

  const type = (await entitledVisitTypes(clientId)).find((candidate) => candidate.key === visitKey);
  if (!type) return res.status(400).json({ error: "Unknown visit for this business's tracks" });
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  if (!site) return res.status(400).json({ error: "Invalid siteId for this client" });
  if (contractorId != null) {
    const [contractor] = await db.select({ id: contractorsTable.id }).from(contractorsTable)
      .where(and(eq(contractorsTable.id, contractorId), eq(contractorsTable.clientId, clientId))).limit(1);
    if (!contractor) return res.status(400).json({ error: "Invalid contractorId" });
  }
  // The check keeps its own date for a visit its track gives no date for:
  // water sampling, or a site with nothing recorded on the track yet.
  const trackDue = (await trackDueDates(clientId, [type])).get(type.key)?.get(siteId);
  const ownDueDate = (type.dueFrom === "check" || !trackDue) && body.data.dueDate !== undefined
    ? (body.data.dueDate ? new Date(`${body.data.dueDate}T00:00:00Z`) : null)
    : undefined;

  const existing = (await linkedVisitChecks(clientId, [type])).find((link) => link.siteId === siteId)?.check;
  if (existing) {
    const changes = {
      contractorId,
      ...(ownDueDate !== undefined ? { dueDate: ownDueDate } : {}),
      ...(ownDueDate !== undefined && day(ownDueDate) !== day(existing.dueDate) ? { notificationSentAt: null } : {}),
      updatedAt: new Date(),
    };
    let after: typeof existing | undefined;
    await db.transaction(async (tx) => {
      [after] = await tx.update(complianceItemsTable).set(changes)
        .where(and(eq(complianceItemsTable.id, existing.id), eq(complianceItemsTable.clientId, clientId))).returning();
      await supersedeStaleReminderCycles(tx, clientId, existing.id);
    });
    await appendAuditEvent(req, {
      clientId, entityType: "compliance_item", entityId: existing.id, action: "updated",
      before: existing, after, metadata: { contractorVisit: visitKey },
    });
  } else if (contractorId != null || ownDueDate) {
    const [created] = await db.insert(complianceItemsTable).values({
      clientId, siteId, contractorId, title: type.title, description: type.description,
      priority: "high", frequencyMonths: type.frequencyMonths, dueDate: ownDueDate ?? null,
    }).returning();
    await appendAuditEvent(req, {
      clientId, entityType: "compliance_item", entityId: created.id, action: "created",
      after: created, metadata: { contractorVisit: visitKey },
    });
  }
  // A new check takes the track's due date straight away.
  await syncContractorVisitChecks(clientId, [visitKey]);
  res.json({ ok: true });
});

export default router;
