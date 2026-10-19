import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { reminderCycleOf, supersedeStaleReminderCycles } from "../lib/reminderCycles";
import { complianceItemsTable, sitesTable, categoriesTable, contractorsTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray } from "drizzle-orm";
import {
  CreateComplianceItemBody,
  UpdateComplianceItemBody,
  UpdateComplianceItemStatusBody,
  GetComplianceItemParams,
  UpdateComplianceItemParams,
  DeleteComplianceItemParams,
  UpdateComplianceItemStatusParams,
  ListComplianceItemsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireClientAdmin, getClientId, canAccessClient, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { filterName } from "../lib/contentFilter";
import { appendAuditEvent } from "../lib/audit";
import { completionFields, completionDateFromDay } from "../lib/complianceCompletion";
import { NO_ACTION, itemActionState, itemActionStates, type ItemActionState } from "../lib/certificateOutcomes";
import { getAccountToday } from "../lib/accountClock";
import { recordTrackCheckFromTask } from "../lib/trackTaskLink";
import { z } from "zod";

const router: IRouter = Router();

/**
 * Coerce ISO date-time strings on the request body into Date objects.
 * The OpenAPI spec types these as `string` (so the wire format is JSON-safe),
 * but the generated zod validators are `z.date()`. This bridge keeps both
 * happy without regenerating with coerce-dates.
 */
function coerceDates<T extends Record<string, unknown>>(body: T, fields: (keyof T)[]): T {
  const out: Record<string, unknown> = { ...body };
  for (const f of fields) {
    const v = out[f as string];
    if (typeof v === "string" && v.length > 0) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) out[f as string] = d;
    }
  }
  return out as T;
}
const DATE_FIELDS = ["dueDate", "completedAt", "notificationSentAt"] as const;

/** A real calendar date, not before 2000 (completion dates are entered by hand). */
const CompletedDay = z.preprocess(
  // An ISO date-time is read as its calendar date.
  (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10) : v),
  z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => v >= "2000-01-01" && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
      && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, "Invalid date")
    .nullish(),
);

function buildItemResponse(
  item: typeof complianceItemsTable.$inferSelect,
  site: typeof sitesTable.$inferSelect | null,
  category: typeof categoriesTable.$inferSelect | null,
  contractor: typeof contractorsTable.$inferSelect | null,
  action: ItemActionState = NO_ACTION,
) {
  // Scheduling-link credentials (raw legacy token or digest) never leave the server.
  const { scheduleToken: _token, scheduleTokenHash: _digest, ...visible } = item;
  return {
    ...visible,
    // Certificate outcome state (lib/certificateOutcomes.ts): an unsatisfactory
    // newest certificate or open C1/C2/FI/ID/AR defects mean "needs action"
    // whatever the due date says.
    needsAction: action.needsAction,
    needsActionReason: action.needsActionReason,
    openDefectCount: action.openDefectCount,
    siteName: site?.name ?? null,
    categoryName: category?.name ?? null,
    categoryColor: category?.color ?? null,
    contractorName: contractor?.name ?? null,
    contractorEmail: contractor?.email ?? null,
  };
}

router.get("/compliance-items", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const query = ListComplianceItemsQueryParams.parse(req.query);

  const conditions = [eq(complianceItemsTable.clientId, clientId)];
  if (query.status) conditions.push(eq(complianceItemsTable.status, query.status));
  if (query.priority) conditions.push(eq(complianceItemsTable.priority, query.priority));
  if (query.siteId) conditions.push(eq(complianceItemsTable.siteId, query.siteId));
  if (query.contractorId) conditions.push(eq(complianceItemsTable.contractorId, query.contractorId));

  // Department scoping: staff/viewers with a department only see items for
  // sites in their department (or items not linked to any site).
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    const allowedSites = db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(and(
        eq(sitesTable.clientId, clientId),
        or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
      ));
    conditions.push(
      or(isNull(complianceItemsTable.siteId), inArray(complianceItemsTable.siteId, allowedSites)) as any,
    );
  }

  const items = await db
    .select({
      item: complianceItemsTable,
      site: sitesTable,
      category: categoriesTable,
      contractor: contractorsTable,
    })
    .from(complianceItemsTable)
    .leftJoin(sitesTable, eq(complianceItemsTable.siteId, sitesTable.id))
    .leftJoin(categoriesTable, eq(complianceItemsTable.categoryId, categoriesTable.id))
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(and(...conditions))
    .orderBy(complianceItemsTable.createdAt);

  // Annotate each item with its latest related certificate expiry date so
  // the UI can surface "expired certificate" filtering without extra queries.
  // A cert is considered related to an item if it's directly linked via
  // certificates.itemId, OR it belongs to the contractor assigned to the item.
  // Certificates have no direct clientId column — they're tied to either a
  // compliance item or a contractor. Scope by joining to whichever owner
  // belongs to the current client.
  const { certificatesTable } = await import("@workspace/db/schema");

  const { or: orDynamic, sql: dsql } = await import("drizzle-orm");
  const certs = await db
    .select({
      itemId: certificatesTable.itemId,
      contractorId: certificatesTable.contractorId,
      expiryDate: certificatesTable.expiryDate,
    })
    .from(certificatesTable)
    .where(
      orDynamic(
        dsql`${certificatesTable.contractorId} IN (SELECT id FROM ${contractorsTable} WHERE ${contractorsTable.clientId} = ${clientId})`,
        dsql`${certificatesTable.itemId} IN (SELECT id FROM ${complianceItemsTable} WHERE ${complianceItemsTable.clientId} = ${clientId})`,
      ),
    );

  const latestExpiryByItem = new Map<number, Date>();
  const latestExpiryByContractor = new Map<number, Date>();
  const trackLatest = (map: Map<number, Date>, key: number, d: Date) => {
    const existing = map.get(key);
    if (!existing || d > existing) map.set(key, d);
  };
  for (const c of certs) {
    if (!c.expiryDate) continue;
    const d = new Date(c.expiryDate);
    if (c.itemId) trackLatest(latestExpiryByItem, c.itemId, d);
    if (c.contractorId) trackLatest(latestExpiryByContractor, c.contractorId, d);
  }

  const actionStates = await itemActionStates(clientId, items.map(({ item }) => item.id));
  res.json(items.map(({ item, site, category, contractor }) => {
    const direct = latestExpiryByItem.get(item.id);
    const viaContractor = item.contractorId ? latestExpiryByContractor.get(item.contractorId) : undefined;
    const latest = [direct, viaContractor].filter(Boolean).sort((a, b) => (b!.getTime() - a!.getTime()))[0];
    return {
      ...buildItemResponse(item, site, category, contractor, actionStates.get(item.id) ?? NO_ACTION),
      latestCertExpiryDate: latest?.toISOString() ?? null,
    };
  }));
});

async function fetchJoinedItem(itemId: number) {
  const rows = await db
    .select({ item: complianceItemsTable, site: sitesTable, category: categoriesTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(sitesTable, eq(complianceItemsTable.siteId, sitesTable.id))
    .leftJoin(categoriesTable, eq(complianceItemsTable.categoryId, categoriesTable.id))
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.id, itemId));
  return rows[0] ?? null;
}

router.post("/compliance-items", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  const applyToAllSites = req.body?.applyToAllSites === true;
  const body = CreateComplianceItemBody.parse(coerceDates(req.body, [...DATE_FIELDS]));
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  if (body.frequencyMonths != null && !Number.isInteger(body.frequencyMonths)) {
    res.status(400).json({ error: "Repeat interval must be a whole number of months" });
    return;
  }
  const titleCheck = filterName(body.title);
  if (!titleCheck.ok) {
    res.status(400).json({ error: titleCheck.message });
    return;
  }
  if (body.notes) {
    const notesCheck = filterName(body.notes);
    if (!notesCheck.ok) {
      res.status(400).json({ error: notesCheck.message });
      return;
    }
  }

  if (body.siteId != null) {
    const [s] = await db.select().from(sitesTable).where(eq(sitesTable.id, body.siteId));
    if (!s || s.clientId !== clientId) {
      res.status(400).json({ error: "Invalid siteId" });
      return;
    }
  }
  if (body.categoryId != null) {
    const [c] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, body.categoryId));
    if (!c || c.clientId !== clientId) {
      res.status(400).json({ error: "Invalid categoryId" });
      return;
    }
  }
  if (body.contractorId != null) {
    const [k] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, body.contractorId));
    if (!k || k.clientId !== clientId) {
      res.status(400).json({ error: "Invalid contractorId" });
      return;
    }
  }

  // A check created as already completed is a completion like any other.
  const createCompletion = body.status === "completed" ? completionFields(body.frequencyMonths, new Date()).fields : {};

  // "All Sites" mode: create one independent compliance check per site so each
  // can have its own certificate, due date, contractor etc.
  if (applyToAllSites) {
    const sites = await db.select().from(sitesTable).where(eq(sitesTable.clientId, clientId));
    if (sites.length === 0) {
      res.status(400).json({ error: "No sites exist yet — add a site before using 'All Sites'." });
      return;
    }
    const { siteId: _ignored, ...rest } = body;
    const inserted = await db
      .insert(complianceItemsTable)
      .values(sites.map(s => ({ ...rest, ...createCompletion, siteId: s.id, clientId, updatedAt: new Date() })))
      .returning();

    const joined = await Promise.all(inserted.map(i => fetchJoinedItem(i.id)));
    await Promise.all(inserted.map(i => appendAuditEvent(req, {
      clientId, entityType: "compliance_item", entityId: i.id, action: "created", after: i,
      metadata: { applyToAllSites: true },
    })));
    res.status(201).json(
      joined.map(j => buildItemResponse(j!.item, j!.site, j!.category, j!.contractor)),
    );
    return;
  }

  const [item] = await db
    .insert(complianceItemsTable)
    .values({ ...body, ...createCompletion, clientId, updatedAt: new Date() })
    .returning();

  const joined = await fetchJoinedItem(item.id);
  await appendAuditEvent(req, {
    clientId, entityType: "compliance_item", entityId: item.id, action: "created", after: item,
  });
  res.status(201).json(buildItemResponse(joined!.item, joined!.site, joined!.category, joined!.contractor));
});

router.get("/compliance-items/:id", requireAuth, async (req, res) => {
  const { id } = GetComplianceItemParams.parse({ id: Number(req.params.id) });
  const user = req.currentUser!;

  const joined = await fetchJoinedItem(id);
  if (!joined) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }
  if (!canAccessClient(req, joined.item.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Department scope: if the user is scoped to a department and the item's site
  // belongs to a different department, deny access.
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null && joined.item.siteId != null) {
    const [itemSite] = await db
      .select({ departmentId: sitesTable.departmentId })
      .from(sitesTable)
      .where(eq(sitesTable.id, joined.item.siteId))
      .limit(1);
    if (itemSite && itemSite.departmentId !== null && itemSite.departmentId !== deptId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  res.json(buildItemResponse(joined.item, joined.site, joined.category, joined.contractor,
    await itemActionState(joined.item.clientId, joined.item.id)));
});

router.put("/compliance-items/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const { id } = UpdateComplianceItemParams.parse({ id: Number(req.params.id) });
  // Read the date done before the generic date coercion turns it into a Date.
  const completedDay = CompletedDay.safeParse(req.body?.completedAt);
  if (!completedDay.success) {
    res.status(400).json({ error: "completedAt must be a date (YYYY-MM-DD)" });
    return;
  }
  const body = UpdateComplianceItemBody.parse(coerceDates(req.body, [...DATE_FIELDS]));
  const user = req.currentUser!;

  if (body.frequencyMonths != null && !Number.isInteger(body.frequencyMonths)) {
    res.status(400).json({ error: "Repeat interval must be a whole number of months" });
    return;
  }
  if (body.title !== undefined) {
    const titleCheck = filterName(body.title);
    if (!titleCheck.ok) {
      res.status(400).json({ error: titleCheck.message });
      return;
    }
  }
  if (body.notes) {
    const notesCheck = filterName(body.notes);
    if (!notesCheck.ok) {
      res.status(400).json({ error: notesCheck.message });
      return;
    }
  }

  const existing = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  if (!existing[0] || (!canAccessClient(req, existing[0].clientId))) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  if (body.siteId != null) {
    const [s] = await db.select().from(sitesTable).where(eq(sitesTable.id, body.siteId));
    if (!s || s.clientId !== existing[0].clientId) {
      res.status(400).json({ error: "Invalid siteId" });
      return;
    }
  }
  if (body.categoryId != null) {
    const [c] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, body.categoryId));
    if (!c || c.clientId !== existing[0].clientId) {
      res.status(400).json({ error: "Invalid categoryId" });
      return;
    }
  }
  if (body.contractorId != null) {
    const [k] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, body.contractorId));
    if (!k || k.clientId !== existing[0].clientId) {
      res.status(400).json({ error: "Invalid contractorId" });
      return;
    }
  }

  const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };
  let recurrence: { completedAt: Date; nextDueDate: Date } | null = null;
  if (body.status === "completed") {
    // An explicit date done (YYYY-MM-DD, never in the future) wins. Otherwise
    // setting an interval on an already-completed check counts from its
    // recorded completion rather than from today.
    let completedAt = existing[0].status === "completed" && existing[0].completedAt
      ? new Date(existing[0].completedAt) : new Date();
    if (completedDay.data) {
      const today = await getAccountToday(existing[0].clientId);
      if (completedDay.data > today) {
        res.status(400).json({ error: "The date done cannot be in the future", code: "CHECK_DATE_IN_FUTURE", today });
        return;
      }
      completedAt = completionDateFromDay(completedDay.data);
    }
    const frequency = body.frequencyMonths !== undefined ? body.frequencyMonths : existing[0].frequencyMonths;
    const completion = completionFields(frequency, completedAt);
    Object.assign(updateData, completion.fields);
    if (completion.recurring) recurrence = { completedAt, nextDueDate: completion.fields.dueDate };
  }
  // The edit form always re-sends the status. Only reopening a completed
  // one-off check clears its completion; a repeating check keeps its "last
  // completed" date.
  else if (body.status && existing[0].status === "completed"
    && !((body.frequencyMonths !== undefined ? body.frequencyMonths : existing[0].frequencyMonths) ?? 0)) {
    updateData.completedAt = null;
  }
  // A reminder delivered for the old due date does not cover the new one, so
  // the scheduler may remind again for the new cycle.
  const nextDueDate = updateData.dueDate as Date | null | undefined;
  const previousCycle = existing[0].dueDate ? reminderCycleOf(new Date(existing[0].dueDate)) : null;
  const nextCycle = nextDueDate === undefined ? previousCycle : nextDueDate ? reminderCycleOf(new Date(nextDueDate)) : null;
  if (nextCycle !== previousCycle) updateData.notificationSentAt = null;

  // The item row is updated (and locked) first, then obsolete pending
  // reminder drafts are superseded in the same transaction.
  await db.transaction(async (tx) => {
    await tx.update(complianceItemsTable).set(updateData).where(eq(complianceItemsTable.id, id));
    await supersedeStaleReminderCycles(tx, existing[0].clientId, id);
  });

  const joined = await fetchJoinedItem(id);
  await appendAuditEvent(req, {
    clientId: existing[0].clientId, entityType: "compliance_item", entityId: id,
    action: "updated", before: existing[0], after: joined!.item,
    ...(recurrence ? { metadata: { recurringCompletion: recurrence } } : {}),
  });
  // Completing a task a track also keeps (emergency lighting, fire alarm and
  // extinguisher servicing, cleaning the water tanks) records it in that track.
  if (recurrence || (body.status === "completed" && String(joined!.item.completedAt) !== String(existing[0].completedAt))) {
    await recordTrackCheckFromTask(req, joined!.item, joined!.item.completedAt);
  }
  res.json(buildItemResponse(joined!.item, joined!.site, joined!.category, joined!.contractor,
    await itemActionState(existing[0].clientId, id)));
});

router.delete("/compliance-items/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const { id } = DeleteComplianceItemParams.parse({ id: Number(req.params.id) });
  const user = req.currentUser!;

  if (user.role === "client_viewer") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const existing = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  if (!existing[0] || (!canAccessClient(req, existing[0].clientId))) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.delete(complianceItemsTable).where(eq(complianceItemsTable.id, id));
    await supersedeStaleReminderCycles(tx, existing[0].clientId, id);
  });
  await appendAuditEvent(req, {
    clientId: existing[0].clientId, entityType: "compliance_item", entityId: id,
    action: "deleted", before: existing[0],
  });
  res.status(204).send();
});

router.patch("/compliance-items/:id/status", requireAuth, denyViewers, async (req, res) => {
  const { id } = UpdateComplianceItemStatusParams.parse({ id: Number(req.params.id) });
  const { status } = UpdateComplianceItemStatusBody.parse(req.body);
  const user = req.currentUser!;
  // The date the check was actually done (YYYY-MM-DD). Optional for older
  // clients, which complete "today".
  const completedDay = CompletedDay.safeParse(req.body?.completedAt);
  if (!completedDay.success) {
    res.status(400).json({ error: "completedAt must be a date (YYYY-MM-DD)" });
    return;
  }
  if (completedDay.data && status !== "completed") {
    res.status(400).json({ error: "completedAt can only be sent when completing a check" });
    return;
  }

  if (user.role === "client_viewer") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const existing = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  if (!existing[0] || (!canAccessClient(req, existing[0].clientId))) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  // Department scope: staff must not mutate items belonging to a different dept's site.
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null && existing[0].siteId != null) {
    const [itemSite] = await db
      .select({ departmentId: sitesTable.departmentId })
      .from(sitesTable)
      .where(eq(sitesTable.id, existing[0].siteId))
      .limit(1);
    if (itemSite && itemSite.departmentId !== null && itemSite.departmentId !== deptId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  let completedAt = new Date();
  if (status === "completed" && completedDay.data) {
    // No future completion dates, judged on the account's own calendar.
    const today = await getAccountToday(existing[0].clientId);
    if (completedDay.data > today) {
      res.status(400).json({ error: "The date done cannot be in the future", code: "CHECK_DATE_IN_FUTURE", today });
      return;
    }
    completedAt = completionDateFromDay(completedDay.data);
  }
  const completion = status === "completed" ? completionFields(existing[0].frequencyMonths, completedAt) : null;
  const statusFields = completion
    ? {
        ...completion.fields,
        // The next due date starts a new reminder cycle.
        ...(completion.recurring ? { notificationSentAt: null } : {}),
      }
    : {
        status,
        // Reopening a completed one-off check clears its completion; a
        // repeating check keeps its "last completed" date.
        ...(existing[0].status === "completed" && !existing[0].frequencyMonths ? { completedAt: null } : {}),
      };
  await db.transaction(async (tx) => {
    await tx
      .update(complianceItemsTable)
      .set({ ...statusFields, updatedAt: new Date() })
      .where(eq(complianceItemsTable.id, id));
    await supersedeStaleReminderCycles(tx, existing[0].clientId, id);
  });

  const joined = await fetchJoinedItem(id);
  await appendAuditEvent(req, {
    clientId: existing[0].clientId, entityType: "compliance_item", entityId: id,
    action: "status_changed", before: existing[0], after: joined!.item,
    ...(completion?.recurring
      ? { metadata: { recurringCompletion: { completedAt: completion.fields.completedAt, nextDueDate: completion.fields.dueDate } } }
      : {}),
  });
  if (completion) await recordTrackCheckFromTask(req, joined!.item, completion.fields.completedAt);
  res.json(buildItemResponse(joined!.item, joined!.site, joined!.category, joined!.contractor,
    await itemActionState(existing[0].clientId, id)));
});

router.get("/dashboard/stats", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const itemConditions = [eq(complianceItemsTable.clientId, clientId)];

  // Department scoping: consistent with GET /compliance-items — filter by
  // the site's department rather than the item's own departmentId column.
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    const allowedSites = db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(and(
        eq(sitesTable.clientId, clientId),
        or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
      ));
    itemConditions.push(
      or(isNull(complianceItemsTable.siteId), inArray(complianceItemsTable.siteId, allowedSites)) as any,
    );
  }

  const { certificatesTable } = await import("@workspace/db/schema");

  const { or: orDynamic, sql: dsql } = await import("drizzle-orm");

  // Also scope the site breakdown to the user's accessible sites
  const siteConditions: ReturnType<typeof eq>[] = [eq(sitesTable.clientId, clientId)];
  if (deptId !== null) {
    siteConditions.push(or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)) as any);
  }

  const [items, contractors, certificates, sites] = await Promise.all([
    db.select().from(complianceItemsTable).where(and(...itemConditions)),
    db.select().from(contractorsTable).where(eq(contractorsTable.clientId, clientId)),
    // Tenant-scoped certificate fetch: a cert belongs to this tenant if it links
    // to a contractor or compliance item belonging to this client.
    db
      .select({
        id: certificatesTable.id,
        expiryDate: certificatesTable.expiryDate,
      })
      .from(certificatesTable)
      .where(
        or(
          dsql`${certificatesTable.contractorId} IN (SELECT id FROM ${contractorsTable} WHERE ${contractorsTable.clientId} = ${clientId})`,
          dsql`${certificatesTable.itemId} IN (SELECT id FROM ${complianceItemsTable} WHERE ${complianceItemsTable.clientId} = ${clientId})`,
        ),
      ),
    db.select({ id: sitesTable.id, name: sitesTable.name }).from(sitesTable).where(and(...siteConditions)),
  ]);

  const actionStates = await itemActionStates(clientId, items.map((i) => i.id));
  const needsAction = (i: typeof items[number]) => actionStates.get(i.id)?.needsAction === true;
  const actionRequired = items.filter(needsAction).length;

  const total = items.length;
  const pending = items.filter(i => i.status === "pending").length;
  const inProgress = items.filter(i => i.status === "in_progress").length;
  const completed = items.filter(i => i.status === "completed").length;
  // Treat any past-due, not-yet-completed item as overdue regardless of stored
  // status, so the dashboard count matches what the filtered list shows.
  const overdue = items.filter(i =>
    i.status === "overdue" ||
    (i.status !== "completed" && i.dueDate && new Date(i.dueDate) < now)
  ).length;
  const criticalItems = items.filter(i => i.priority === "critical" && i.status !== "completed").length;
  const dueSoon = items.filter(i =>
    i.dueDate && i.status !== "completed" &&
    new Date(i.dueDate) <= thirtyDaysFromNow && new Date(i.dueDate) >= now
  ).length;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const contractorsCount = contractors.length;
  const certificatesExpiringSoon = certificates.filter(c =>
    c.expiryDate && new Date(c.expiryDate) <= thirtyDaysFromNow && new Date(c.expiryDate) >= now
  ).length;
  const certificatesExpired = certificates.filter(c =>
    c.expiryDate && new Date(c.expiryDate) < now
  ).length;

  // Compliance rate: a check counts as "in date" when it is completed, has no
  // due date, or its due date is more than 7 days away. Anything overdue or
  // due within the next 7 days is treated as out of compliance.
  // A check whose newest certificate is unsatisfactory or has open remedial
  // defects is out of compliance whatever its due date.
  const isInDate = (i: typeof items[number]) => {
    if (needsAction(i)) return false;
    if (i.status === "completed") return true;
    if (!i.dueDate) return true;
    return new Date(i.dueDate) > sevenDaysFromNow;
  };
  const inDateCount = items.filter(isInDate).length;
  const complianceRate = total > 0 ? Math.round((inDateCount / total) * 100) : 0;

  // Per-site breakdown so the dashboard can render a clickable list of sites
  // each with their own compliance percentage. "No site assigned" buckets
  // anything without a siteId so it's still actionable.
  const bySite = new Map<number | "none", { siteId: number | null; siteName: string; total: number; inDate: number }>();
  for (const s of sites) {
    bySite.set(s.id, { siteId: s.id, siteName: s.name, total: 0, inDate: 0 });
  }
  bySite.set("none", { siteId: null, siteName: "No site assigned", total: 0, inDate: 0 });
  for (const it of items) {
    const key = it.siteId ?? "none";
    const bucket = bySite.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    if (isInDate(it)) bucket.inDate += 1;
  }
  const complianceRateBySite = Array.from(bySite.values())
    .filter(b => b.total > 0)
    .map(b => ({
      siteId: b.siteId,
      siteName: b.siteName,
      total: b.total,
      inDate: b.inDate,
      rate: Math.round((b.inDate / b.total) * 100),
    }))
    .sort((a, b) => a.rate - b.rate);

  res.json({
    total, pending, inProgress, completed, overdue, criticalItems, dueSoon, completionRate,
    complianceRate, complianceRateBySite, actionRequired,
    contractorsCount, certificatesExpiringSoon, certificatesExpired,
  });
});

export default router;
