import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { complianceItemsTable, categoriesTable, contractorsTable } from "@workspace/db/schema";
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

const router: IRouter = Router();

function buildItemResponse(
  item: typeof complianceItemsTable.$inferSelect,
  category: typeof categoriesTable.$inferSelect | null,
  contractor: typeof contractorsTable.$inferSelect | null
) {
  return {
    ...item,
    categoryName: category?.name ?? null,
    categoryColor: category?.color ?? null,
    contractorName: contractor?.name ?? null,
    contractorEmail: contractor?.email ?? null,
  };
}

router.get("/compliance-items", async (req, res) => {
  const query = ListComplianceItemsQueryParams.parse(req.query);

  const conditions = [];
  if (query.status) conditions.push(eq(complianceItemsTable.status, query.status));
  if (query.priority) conditions.push(eq(complianceItemsTable.priority, query.priority));
  if (query.categoryId) conditions.push(eq(complianceItemsTable.categoryId, query.categoryId));
  if (query.type) conditions.push(eq(complianceItemsTable.type, query.type));
  if (query.contractorId) conditions.push(eq(complianceItemsTable.contractorId, query.contractorId));

  const items = await db
    .select({
      item: complianceItemsTable,
      category: categoriesTable,
      contractor: contractorsTable,
    })
    .from(complianceItemsTable)
    .leftJoin(categoriesTable, eq(complianceItemsTable.categoryId, categoriesTable.id))
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(complianceItemsTable.createdAt);

  res.json(items.map(({ item, category, contractor }) => buildItemResponse(item, category, contractor)));
});

router.post("/compliance-items", async (req, res) => {
  const body = CreateComplianceItemBody.parse(req.body);
  const [item] = await db
    .insert(complianceItemsTable)
    .values({ ...body, updatedAt: new Date() })
    .returning();

  const [catResult] = item.categoryId
    ? await db.select().from(categoriesTable).where(eq(categoriesTable.id, item.categoryId))
    : [];
  const [conResult] = item.contractorId
    ? await db.select().from(contractorsTable).where(eq(contractorsTable.id, item.contractorId))
    : [];

  res.status(201).json(buildItemResponse(item, catResult ?? null, conResult ?? null));
});

router.get("/compliance-items/:id", async (req, res) => {
  const { id } = GetComplianceItemParams.parse({ id: Number(req.params.id) });
  const rows = await db
    .select({ item: complianceItemsTable, category: categoriesTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(categoriesTable, eq(complianceItemsTable.categoryId, categoriesTable.id))
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.id, id));

  if (!rows.length) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }
  const { item, category, contractor } = rows[0];
  res.json(buildItemResponse(item, category, contractor));
});

router.put("/compliance-items/:id", async (req, res) => {
  const { id } = UpdateComplianceItemParams.parse({ id: Number(req.params.id) });
  const body = UpdateComplianceItemBody.parse(req.body);

  const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (body.status === "completed") updateData.completedAt = new Date();
  else if (body.status) updateData.completedAt = null;

  const [updated] = await db
    .update(complianceItemsTable)
    .set(updateData)
    .where(eq(complianceItemsTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  const [catResult] = updated.categoryId
    ? await db.select().from(categoriesTable).where(eq(categoriesTable.id, updated.categoryId))
    : [];
  const [conResult] = updated.contractorId
    ? await db.select().from(contractorsTable).where(eq(contractorsTable.id, updated.contractorId))
    : [];

  res.json(buildItemResponse(updated, catResult ?? null, conResult ?? null));
});

router.delete("/compliance-items/:id", async (req, res) => {
  const { id } = DeleteComplianceItemParams.parse({ id: Number(req.params.id) });
  await db.delete(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  res.status(204).send();
});

router.patch("/compliance-items/:id/status", async (req, res) => {
  const { id } = UpdateComplianceItemStatusParams.parse({ id: Number(req.params.id) });
  const { status } = UpdateComplianceItemStatusBody.parse(req.body);

  const [updated] = await db
    .update(complianceItemsTable)
    .set({ status, updatedAt: new Date(), completedAt: status === "completed" ? new Date() : null })
    .where(eq(complianceItemsTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  const [catResult] = updated.categoryId
    ? await db.select().from(categoriesTable).where(eq(categoriesTable.id, updated.categoryId))
    : [];
  const [conResult] = updated.contractorId
    ? await db.select().from(contractorsTable).where(eq(contractorsTable.id, updated.contractorId))
    : [];

  res.json(buildItemResponse(updated, catResult ?? null, conResult ?? null));
});

router.get("/dashboard/stats", async (_req, res) => {
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [items, contractors, certs] = await Promise.all([
    db.select().from(complianceItemsTable),
    db.select().from(contractorsTable),
    db.select().from(categoriesTable),
  ]);

  const { certificatesTable } = await import("@workspace/db/schema");
  const certificates = await db.select().from(certificatesTable);

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
  const externalTotal = items.filter(i => i.type === "external").length;
  const internalTotal = items.filter(i => i.type === "internal").length;
  const contractorsCount = contractors.length;
  const certificatesExpiringSoon = certificates.filter(c =>
    c.expiryDate && new Date(c.expiryDate) <= thirtyDaysFromNow && new Date(c.expiryDate) >= now
  ).length;

  res.json({
    total, pending, inProgress, completed, overdue, criticalItems, dueSoon, completionRate,
    externalTotal, internalTotal, contractorsCount, certificatesExpiringSoon
  });
});

export default router;
