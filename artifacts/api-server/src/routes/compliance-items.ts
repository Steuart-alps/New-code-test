import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { complianceItemsTable, sitesTable, categoriesTable, contractorsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
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
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";

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

function buildItemResponse(
  item: typeof complianceItemsTable.$inferSelect,
  site: typeof sitesTable.$inferSelect | null,
  category: typeof categoriesTable.$inferSelect | null,
  contractor: typeof contractorsTable.$inferSelect | null
) {
  return {
    ...item,
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

  // Scope staff to their department
  if (user.role === "client_staff" && user.departmentId) {
    conditions.push(eq(complianceItemsTable.departmentId, user.departmentId));
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

  // Annotate each item with its latest certificate expiry date (if any) so
  // the UI can surface "expired certificate" filtering without extra queries.
  const { certificatesTable } = await import("@workspace/db/schema");
  const certs = await db
    .select({ itemId: certificatesTable.itemId, expiryDate: certificatesTable.expiryDate })
    .from(certificatesTable)
    .where(eq(certificatesTable.clientId, clientId));
  const latestExpiryByItem = new Map<number, Date>();
  for (const c of certs) {
    if (!c.itemId || !c.expiryDate) continue;
    const existing = latestExpiryByItem.get(c.itemId);
    const next = new Date(c.expiryDate);
    if (!existing || next > existing) latestExpiryByItem.set(c.itemId, next);
  }

  res.json(items.map(({ item, site, category, contractor }) => ({
    ...buildItemResponse(item, site, category, contractor),
    latestCertExpiryDate: latestExpiryByItem.get(item.id)?.toISOString() ?? null,
  })));
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

router.post("/compliance-items", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  const applyToAllSites = req.body?.applyToAllSites === true;
  const body = CreateComplianceItemBody.parse(coerceDates(req.body, [...DATE_FIELDS]));
  const clientId = user.role === "consultant" ? (req.body.clientId ?? getClientId(req)) : user.clientId;
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
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
      .values(sites.map(s => ({ ...rest, siteId: s.id, clientId, updatedAt: new Date() })))
      .returning();

    const joined = await Promise.all(inserted.map(i => fetchJoinedItem(i.id)));
    res.status(201).json(
      joined.map(j => buildItemResponse(j!.item, j!.site, j!.category, j!.contractor)),
    );
    return;
  }

  const [item] = await db
    .insert(complianceItemsTable)
    .values({ ...body, clientId, updatedAt: new Date() })
    .returning();

  const joined = await fetchJoinedItem(item.id);
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
  if (user.role !== "consultant" && joined.item.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(buildItemResponse(joined.item, joined.site, joined.category, joined.contractor));
});

router.put("/compliance-items/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = UpdateComplianceItemParams.parse({ id: Number(req.params.id) });
  const body = UpdateComplianceItemBody.parse(coerceDates(req.body, [...DATE_FIELDS]));
  const user = req.currentUser!;

  const existing = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  if (!existing[0] || (user.role !== "consultant" && existing[0].clientId !== user.clientId)) {
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
  if (body.status === "completed") updateData.completedAt = new Date();
  else if (body.status) updateData.completedAt = null;

  await db.update(complianceItemsTable).set(updateData).where(eq(complianceItemsTable.id, id));

  const joined = await fetchJoinedItem(id);
  res.json(buildItemResponse(joined!.item, joined!.site, joined!.category, joined!.contractor));
});

router.delete("/compliance-items/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = DeleteComplianceItemParams.parse({ id: Number(req.params.id) });
  const user = req.currentUser!;

  const existing = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  if (!existing[0] || (user.role !== "consultant" && existing[0].clientId !== user.clientId)) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  await db.delete(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  res.status(204).send();
});

router.patch("/compliance-items/:id/status", requireAuth, async (req, res) => {
  const { id } = UpdateComplianceItemStatusParams.parse({ id: Number(req.params.id) });
  const { status } = UpdateComplianceItemStatusBody.parse(req.body);
  const user = req.currentUser!;

  if (user.role === "client_viewer") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const existing = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  if (!existing[0] || (user.role !== "consultant" && existing[0].clientId !== user.clientId)) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  await db
    .update(complianceItemsTable)
    .set({ status, updatedAt: new Date(), completedAt: status === "completed" ? new Date() : null })
    .where(eq(complianceItemsTable.id, id));

  const joined = await fetchJoinedItem(id);
  res.json(buildItemResponse(joined!.item, joined!.site, joined!.category, joined!.contractor));
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
  if (user.role === "client_staff" && user.departmentId) {
    itemConditions.push(eq(complianceItemsTable.departmentId, user.departmentId));
  }

  const { certificatesTable } = await import("@workspace/db/schema");
  const { or, sql: dsql } = await import("drizzle-orm");

  const [items, contractors, certificates] = await Promise.all([
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
  ]);

  const total = items.length;
  const pending = items.filter(i => i.status === "pending").length;
  const inProgress = items.filter(i => i.status === "in_progress").length;
  const completed = items.filter(i => i.status === "completed").length;
  const overdue = items.filter(i => i.status === "overdue").length;
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

  res.json({
    total, pending, inProgress, completed, overdue, criticalItems, dueSoon, completionRate,
    contractorsCount, certificatesExpiringSoon, certificatesExpired
  });
});

export default router;
