import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { fireSafetyChecksTable, sitesTable } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

const CHECK_TYPES = ["alarm", "emergency_lights", "extinguishers", "fire_doors", "fire_drill"] as const;

// Default check frequencies, in days
const FREQUENCY_DAYS: Record<(typeof CHECK_TYPES)[number], number> = {
  alarm: 7,
  emergency_lights: 30,
  extinguishers: 30,
  fire_doors: 90,
  fire_drill: 180,
};

const createSchema = z.object({
  checkType: z.enum(CHECK_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result: z.enum(["pass", "fail"]),
  siteId: z.number().int().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  performedBy: z.string().max(200).nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checkType: true });

/** Ensure a siteId (if provided) belongs to the tenant. Returns false when it does not. */
async function siteBelongsToClient(siteId: number | null | undefined, clientId: number): Promise<boolean> {
  if (siteId == null) return true;
  const [site] = await db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  return !!site;
}

// GET /api/fire-safety?checkType=&siteId=
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const conditions = [eq(fireSafetyChecksTable.clientId, clientId)];
  const { checkType, siteId } = req.query as { checkType?: string; siteId?: string };
  if (checkType && (CHECK_TYPES as readonly string[]).includes(checkType)) {
    conditions.push(eq(fireSafetyChecksTable.checkType, checkType));
  }
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(fireSafetyChecksTable.siteId, parseInt(siteId)));
  }

  const rows = await db
    .select()
    .from(fireSafetyChecksTable)
    .where(and(...conditions))
    .orderBy(desc(fireSafetyChecksTable.checkDate), desc(fireSafetyChecksTable.id));

  res.json(rows);
});

// GET /api/fire-safety/status?siteId=
router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { siteId } = req.query as { siteId?: string };
  const conditions = [eq(fireSafetyChecksTable.clientId, clientId)];
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(fireSafetyChecksTable.siteId, parseInt(siteId)));
  }

  const lastDates = await db
    .select({
      checkType: fireSafetyChecksTable.checkType,
      lastDate: sql<string>`max(${fireSafetyChecksTable.checkDate})`,
    })
    .from(fireSafetyChecksTable)
    .where(and(...conditions))
    .groupBy(fireSafetyChecksTable.checkType);

  const lastByType = new Map(lastDates.map((r) => [r.checkType, r.lastDate]));
  const MS_DAY = 24 * 60 * 60 * 1000;
  // Date-only arithmetic in UTC to avoid local-timezone drift
  const toUtcDays = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_DAY);
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayDays = toUtcDays(todayIso);

  const statuses = CHECK_TYPES.map((checkType) => {
    const frequencyDays = FREQUENCY_DAYS[checkType];
    const lastDate = lastByType.get(checkType) ?? null;
    if (!lastDate) {
      return { checkType, frequencyDays, lastDate: null, dueDate: null, status: "never" as const };
    }
    const dueDays = toUtcDays(lastDate) + frequencyDays;
    const dueDate = new Date(dueDays * MS_DAY).toISOString().slice(0, 10);
    const daysUntilDue = dueDays - todayDays;
    const dueSoonWindow = Math.max(1, Math.ceil(frequencyDays * 0.2));
    const status = daysUntilDue < 0 ? "overdue" : daysUntilDue <= dueSoonWindow ? "due_soon" : "ok";
    return { checkType, frequencyDays, lastDate, dueDate, status };
  });

  res.json(statuses);
});

// POST /api/fire-safety
router.post("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;

  if (!(await siteBelongsToClient(data.siteId, clientId))) {
    return res.status(400).json({ error: "Invalid site" });
  }

  const [inserted] = await db
    .insert(fireSafetyChecksTable)
    .values({
      clientId,
      checkType: data.checkType,
      checkDate: data.checkDate,
      result: data.result,
      siteId: data.siteId ?? null,
      location: data.location ?? null,
      notes: data.notes ?? null,
      performedBy: data.performedBy ?? null,
      createdBy: (req.session as any).userId ?? null,
    })
    .returning();

  res.status(201).json(inserted);
});

// PUT /api/fire-safety/:id
router.put("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  if (!(await siteBelongsToClient(parsed.data.siteId, clientId))) {
    return res.status(400).json({ error: "Invalid site" });
  }

  const [updated] = await db
    .update(fireSafetyChecksTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(eq(fireSafetyChecksTable.id, id), eq(fireSafetyChecksTable.clientId, clientId)))
    .returning();

  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(updated);
});

// DELETE /api/fire-safety/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const deleted = await db
    .delete(fireSafetyChecksTable)
    .where(and(eq(fireSafetyChecksTable.id, id), eq(fireSafetyChecksTable.clientId, clientId)))
    .returning({ id: fireSafetyChecksTable.id });

  if (deleted.length === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

export default router;
