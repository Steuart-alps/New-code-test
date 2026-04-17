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

function buildItemResponse(
  item: typeof complianceItemsTable.$inferSelect,
  site: typeof sitesTable.$inferSelect | null,
  category: typeof categoriesTable.$inferSelect | null,
  contractor: typeof contractorsTable.$inferSelect | null
) {
  return {
    ...item,
    siteName: site?.name ?? null,
    categoryId: site?.categoryId ?? null,
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
    .leftJoin(categoriesTable, eq(sitesTable.categoryId, categoriesTable.id))
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(and(...conditions))
    .orderBy(complianceItemsTable.createdAt);

  res.json(items.map(({ item, site, category, contractor }) => buildItemResponse(item, site, category, contractor)));
});

async function fetchJoinedItem(itemId: number) {
  const rows = await db
    .select({ item: complianceItemsTable, site: sitesTable, category: categoriesTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(sitesTable, eq(complianceItemsTable.siteId, sitesTable.id))
    .leftJoin(categoriesTable, eq(sitesTable.categoryId, categoriesTable.id))
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.id, itemId));
  return rows[0] ?? null;
}

router.post("/compliance-items", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  const body = CreateComplianceItemBody.parse(req.body);
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
  const body = UpdateComplianceItemBody.parse(req.body);
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

  const [items, contractors, certificates] = await Promise.all([
    db.select().from(complianceItemsTable).where(and(...itemConditions)),
    db.select().from(contractorsTable).where(eq(contractorsTable.clientId, clientId)),
    db.select().from(certificatesTable),
  ]);

  const total = items.length;
  const pending = items.filter(i => i.status === "pending").length;
  const inProgress = items.filter(i => i.status === "in_progress").length;
  const completed = items.filter(i => i.status === "completed").length;
  const overdue = items.filter(i => i.status === "overdue").length;
  const criticalItems = items.filter(i => i.priority === "critical" && i.status !== "completed").length;
  const dueSoon = items.filter(i =>
    i.dueDate && i.status !== "completed" &&
    new Date(i.dueDate) <= sevenDaysFromNow && new Date(i.dueDate) >= now
  ).length;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const contractorsCount = contractors.length;
  const certificatesExpiringSoon = certificates.filter(c =>
    c.expiryDate && new Date(c.expiryDate) <= thirtyDaysFromNow && new Date(c.expiryDate) >= now
  ).length;

  res.json({
    total, pending, inProgress, completed, overdue, criticalItems, dueSoon, completionRate,
    contractorsCount, certificatesExpiringSoon
  });
});

export default router;
