import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { complianceItemsTable, categoriesTable } from "@workspace/db/schema";
import { eq, and, sql } from "drizzle-orm";
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

function buildItemWithCategory(item: typeof complianceItemsTable.$inferSelect, category: typeof categoriesTable.$inferSelect | null) {
  return {
    ...item,
    categoryName: category?.name ?? null,
    categoryColor: category?.color ?? null,
  };
}

router.get("/compliance-items", async (req, res) => {
  const query = ListComplianceItemsQueryParams.parse(req.query);

  const conditions = [];
  if (query.status) conditions.push(eq(complianceItemsTable.status, query.status));
  if (query.priority) conditions.push(eq(complianceItemsTable.priority, query.priority));
  if (query.categoryId) conditions.push(eq(complianceItemsTable.categoryId, query.categoryId));

  const items = await db
    .select({
      item: complianceItemsTable,
      category: categoriesTable,
    })
    .from(complianceItemsTable)
    .leftJoin(categoriesTable, eq(complianceItemsTable.categoryId, categoriesTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(complianceItemsTable.createdAt);

  const result = items.map(({ item, category }) => buildItemWithCategory(item, category));
  res.json(result);
});

router.post("/compliance-items", async (req, res) => {
  const body = CreateComplianceItemBody.parse(req.body);
  const [item] = await db
    .insert(complianceItemsTable)
    .values({
      ...body,
      updatedAt: new Date(),
    })
    .returning();

  let category = null;
  if (item.categoryId) {
    const cats = await db.select().from(categoriesTable).where(eq(categoriesTable.id, item.categoryId));
    category = cats[0] ?? null;
  }

  res.status(201).json(buildItemWithCategory(item, category));
});

router.get("/compliance-items/:id", async (req, res) => {
  const { id } = GetComplianceItemParams.parse({ id: Number(req.params.id) });

  const rows = await db
    .select({ item: complianceItemsTable, category: categoriesTable })
    .from(complianceItemsTable)
    .leftJoin(categoriesTable, eq(complianceItemsTable.categoryId, categoriesTable.id))
    .where(eq(complianceItemsTable.id, id));

  if (!rows.length) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  const { item, category } = rows[0];
  res.json(buildItemWithCategory(item, category));
});

router.put("/compliance-items/:id", async (req, res) => {
  const { id } = UpdateComplianceItemParams.parse({ id: Number(req.params.id) });
  const body = UpdateComplianceItemBody.parse(req.body);

  const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };

  if (body.status === "completed") {
    updateData.completedAt = new Date();
  } else if (body.status && body.status !== "completed") {
    updateData.completedAt = null;
  }

  const [updated] = await db
    .update(complianceItemsTable)
    .set(updateData)
    .where(eq(complianceItemsTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  let category = null;
  if (updated.categoryId) {
    const cats = await db.select().from(categoriesTable).where(eq(categoriesTable.id, updated.categoryId));
    category = cats[0] ?? null;
  }

  res.json(buildItemWithCategory(updated, category));
});

router.delete("/compliance-items/:id", async (req, res) => {
  const { id } = DeleteComplianceItemParams.parse({ id: Number(req.params.id) });
  await db.delete(complianceItemsTable).where(eq(complianceItemsTable.id, id));
  res.status(204).send();
});

router.patch("/compliance-items/:id/status", async (req, res) => {
  const { id } = UpdateComplianceItemStatusParams.parse({ id: Number(req.params.id) });
  const { status } = UpdateComplianceItemStatusBody.parse(req.body);

  const updateData: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
    completedAt: status === "completed" ? new Date() : null,
  };

  const [updated] = await db
    .update(complianceItemsTable)
    .set(updateData)
    .where(eq(complianceItemsTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Compliance item not found" });
    return;
  }

  let category = null;
  if (updated.categoryId) {
    const cats = await db.select().from(categoriesTable).where(eq(categoriesTable.id, updated.categoryId));
    category = cats[0] ?? null;
  }

  res.json(buildItemWithCategory(updated, category));
});

router.get("/dashboard/stats", async (_req, res) => {
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const items = await db.select().from(complianceItemsTable);

  const total = items.length;
  const pending = items.filter(i => i.status === "pending").length;
  const inProgress = items.filter(i => i.status === "in_progress").length;
  const completed = items.filter(i => i.status === "completed").length;
  const overdue = items.filter(i => i.status === "overdue").length;
  const criticalItems = items.filter(i => i.priority === "critical" && i.status !== "completed").length;
  const dueSoon = items.filter(i =>
    i.dueDate &&
    i.status !== "completed" &&
    new Date(i.dueDate) <= sevenDaysFromNow &&
    new Date(i.dueDate) >= now
  ).length;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  res.json({ total, pending, inProgress, completed, overdue, criticalItems, dueSoon, completionRate });
});

export default router;
