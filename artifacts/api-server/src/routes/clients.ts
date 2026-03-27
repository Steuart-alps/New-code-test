import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireConsultant, requireClientAdmin } from "../middleware/requireAuth";

const router = Router();

const UpsertClientBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only"),
  logoUrl: z.string().nullable().optional(),
  primaryColor: z.string().default("#6366f1"),
  active: z.boolean().default(true),
});

router.get("/clients", requireAuth, requireConsultant, async (_req, res) => {
  const clients = await db.select().from(clientsTable).orderBy(clientsTable.name);
  res.json(clients);
});

router.get("/clients/:id", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const id = Number(req.params.id);

  if (user.role !== "consultant" && user.clientId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
  if (!rows[0]) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  res.json(rows[0]);
});

router.post("/clients", requireAuth, requireConsultant, async (req, res) => {
  const body = UpsertClientBody.parse(req.body);
  const rows = await db.insert(clientsTable).values(body).returning();
  res.status(201).json(rows[0]);
});

router.put("/clients/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  const id = Number(req.params.id);

  if (user.role !== "consultant" && user.clientId !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = UpsertClientBody.partial().parse(req.body);
  const rows = await db
    .update(clientsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(clientsTable.id, id))
    .returning();

  if (!rows[0]) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  res.json(rows[0]);
});

router.delete("/clients/:id", requireAuth, requireConsultant, async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(clientsTable).where(eq(clientsTable.id, id));
  res.json({ ok: true });
});

export default router;
