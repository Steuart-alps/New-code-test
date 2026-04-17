import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sitesTable, categoriesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";

const router: IRouter = Router();

router.get("/sites", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const conditions = [eq(sitesTable.clientId, clientId)];
  if (req.query.categoryId) {
    conditions.push(eq(sitesTable.categoryId, Number(req.query.categoryId)));
  }
  const sites = await db
    .select()
    .from(sitesTable)
    .where(and(...conditions))
    .orderBy(sitesTable.name);
  res.json(sites);
});

router.get("/sites/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (user.role !== "consultant" && site.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(site);
});

router.post("/sites", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  const clientId = user.role === "consultant" ? (req.body.clientId ?? getClientId(req)) : user.clientId;
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Site name is required" });
    return;
  }
  let categoryId: number | null = req.body.categoryId ?? null;
  if (categoryId != null) {
    const [cat] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, categoryId));
    if (!cat || cat.clientId !== clientId) {
      res.status(400).json({ error: "Invalid categoryId" });
      return;
    }
  }
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId,
      categoryId,
      name,
      responsiblePerson: req.body.responsiblePerson ?? null,
      address: req.body.address ?? null,
      phone: req.body.phone ?? null,
      updatedAt: new Date(),
    })
    .returning();
  res.status(201).json(site);
});

router.patch("/sites/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const [existing] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (user.role !== "consultant" && existing.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["name", "responsiblePerson", "address", "phone", "categoryId"] as const) {
    if (key in req.body) updates[key] = req.body[key];
  }
  if (updates.categoryId != null) {
    const [cat] = await db.select().from(categoriesTable).where(eq(categoriesTable.id, updates.categoryId as number));
    if (!cat || cat.clientId !== existing.clientId) {
      res.status(400).json({ error: "Invalid categoryId" });
      return;
    }
  }
  const [updated] = await db.update(sitesTable).set(updates).where(eq(sitesTable.id, id)).returning();
  res.json(updated);
});

router.delete("/sites/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const [existing] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (user.role !== "consultant" && existing.clientId !== user.clientId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db.delete(sitesTable).where(eq(sitesTable.id, id));
  res.status(204).send();
});

export default router;
