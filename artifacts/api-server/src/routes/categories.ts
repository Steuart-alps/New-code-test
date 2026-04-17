import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { categoriesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
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
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const [category] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!category) {
    res.status(404).json({ error: "Category not found" });
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
  const clientId = user.role === "consultant" ? (req.body.clientId ?? getClientId(req)) : user.clientId;
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Category name is required" });
    return;
  }
  const color = String(req.body?.color ?? "#6366f1");
  const [category] = await db.insert(categoriesTable).values({ clientId, name, color }).returning();
  res.status(201).json(category);
});

router.patch("/categories/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const [existing] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  if (user.role !== "consultant" && existing.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const updates: Record<string, unknown> = {};
  if ("name" in req.body) updates.name = req.body.name;
  if ("color" in req.body) updates.color = req.body.color;
  const [updated] = await db.update(categoriesTable).set(updates).where(eq(categoriesTable.id, id)).returning();
  res.json(updated);
});

router.delete("/categories/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const [existing] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  if (user.role !== "consultant" && existing.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db.delete(categoriesTable).where(eq(categoriesTable.id, id));
  res.status(204).send();
});

export default router;
