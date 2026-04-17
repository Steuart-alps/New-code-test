import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { categoriesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  CreateCategoryBody,
  UpdateCategoryBody,
  DeleteCategoryParams,
  GetCategoryParams,
  UpdateCategoryParams,
} from "@workspace/api-zod";
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";

const router: IRouter = Router();

router.get("/categories", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const categories = await db
    .select()
    .from(categoriesTable)
    .where(eq(categoriesTable.clientId, clientId))
    .orderBy(categoriesTable.name);
  res.json(categories);
});

router.get("/categories/:id", requireAuth, async (req, res) => {
  const { id } = GetCategoryParams.parse({ id: Number(req.params.id) });
  const user = req.currentUser!;
  const [category] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!category) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (user.role !== "consultant" && category.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(category);
});

router.post("/categories", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  const body = CreateCategoryBody.parse(req.body);
  const clientId = user.role === "consultant" ? (req.body.clientId ?? getClientId(req)) : user.clientId;
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const [category] = await db.insert(categoriesTable).values({ ...body, clientId }).returning();
  res.status(201).json(category);
});

router.patch("/categories/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = UpdateCategoryParams.parse({ id: Number(req.params.id) });
  const body = UpdateCategoryBody.parse(req.body);
  const user = req.currentUser!;

  const [existing] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (user.role !== "consultant" && existing.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [updated] = await db
    .update(categoriesTable)
    .set(body)
    .where(eq(categoriesTable.id, id))
    .returning();
  res.json(updated);
});

router.delete("/categories/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = DeleteCategoryParams.parse({ id: Number(req.params.id) });
  const user = req.currentUser!;

  const existing = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!existing[0]) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  if (user.role !== "consultant" && existing[0].clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
  res.status(204).send();
});

export default router;
