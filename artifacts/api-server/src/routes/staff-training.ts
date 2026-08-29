import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { staffTrainingRecordsTable, usersTable } from "@workspace/db/schema";
import { eq, and, lte, gte, isNotNull } from "drizzle-orm";
import { requireAuth, getClientId, requireClientAdmin } from "../middleware/requireAuth";

const router = Router();

const CreateBody = z.object({
  userId: z.number().nullable().optional(),
  staffName: z.string().min(1),
  courseName: z.string().min(1),
  issuedAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const UpdateBody = CreateBody.partial();

// GET /staff-training — list all records for this client
router.get("/staff-training", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "clientId required" }); return; }

  const records = await db
    .select()
    .from(staffTrainingRecordsTable)
    .where(eq(staffTrainingRecordsTable.clientId, clientId))
    .orderBy(staffTrainingRecordsTable.staffName, staffTrainingRecordsTable.courseName);

  res.json(records);
});

// GET /staff-training/expiring?within=30 — records expiring within N days
router.get("/staff-training/expiring", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "clientId required" }); return; }

  const withinDays = Math.min(Number(req.query.within ?? 30), 365);
  const now = new Date();
  const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const records = await db
    .select()
    .from(staffTrainingRecordsTable)
    .where(
      and(
        eq(staffTrainingRecordsTable.clientId, clientId),
        isNotNull(staffTrainingRecordsTable.expiresAt),
        lte(staffTrainingRecordsTable.expiresAt, cutoff),
      ),
    )
    .orderBy(staffTrainingRecordsTable.expiresAt);

  // Separate expired (past) from expiring-soon (future)
  const expired = records.filter(r => r.expiresAt! < now);
  const expiringSoon = records.filter(r => r.expiresAt! >= now);

  res.json({ expired, expiringSoon, total: records.length });
});

// POST /staff-training — create record (admin only)
router.post("/staff-training", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "clientId required" }); return; }

  const body = CreateBody.parse(req.body);

  const [record] = await db
    .insert(staffTrainingRecordsTable)
    .values({ ...body, clientId })
    .returning();

  res.status(201).json(record);
});

// PATCH /staff-training/:id — update record (admin only)
router.patch("/staff-training/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "clientId required" }); return; }

  const id = Number(req.params.id);
  const body = UpdateBody.parse(req.body);

  const existing = await db
    .select()
    .from(staffTrainingRecordsTable)
    .where(and(eq(staffTrainingRecordsTable.id, id), eq(staffTrainingRecordsTable.clientId, clientId)));

  if (!existing[0]) { res.status(404).json({ error: "Record not found" }); return; }

  const [updated] = await db
    .update(staffTrainingRecordsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(staffTrainingRecordsTable.id, id))
    .returning();

  res.json(updated);
});

// DELETE /staff-training/:id — delete record (admin only)
router.delete("/staff-training/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "clientId required" }); return; }

  const id = Number(req.params.id);
  const existing = await db
    .select()
    .from(staffTrainingRecordsTable)
    .where(and(eq(staffTrainingRecordsTable.id, id), eq(staffTrainingRecordsTable.clientId, clientId)));

  if (!existing[0]) { res.status(404).json({ error: "Record not found" }); return; }

  await db.delete(staffTrainingRecordsTable).where(eq(staffTrainingRecordsTable.id, id));
  res.status(204).end();
});

export { router as staffTrainingRouter };
