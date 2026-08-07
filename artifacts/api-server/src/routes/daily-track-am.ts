import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { dailyChecklistsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { requireAnyEntitlement, SERVICES } from "../lib/services";

const router = Router();

const AM_TYPES = ["kitchen_opening", "premises_opening"] as const;

// The router-level guard only requires SOME purchased branch (kitchentrack or
// safetrack), since this router covers both. Individual writes are checked
// against the specific branch the checklistType belongs to.
function serviceForType(type: (typeof AM_TYPES)[number]): "kitchentrack" | "safetrack" {
  return type === "kitchen_opening" ? "kitchentrack" : "safetrack";
}

const itemSchema = z.object({
  label: z.string(),
  checked: z.boolean(),
  notes: z.string().optional(),
});

const createSchema = z.object({
  siteId: z.number().int().nullable().optional(),
  checklistType: z.enum(AM_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(itemSchema).optional(),
  completedBy: z.string().max(200).nullable().optional(),
  managerNote: z.string().max(2000).nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checklistType: true, checkDate: true });

function allowedSites(clientId: number, deptId: number) {
  return db.select({ id: sitesTable.id }).from(sitesTable).where(
    and(eq(sitesTable.clientId, clientId), or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)))
  );
}

async function verifySite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return true;
  const [r] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId))).limit(1);
  return !!r;
}

// GET /api/daily-track-am?siteId=&date=&type=
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { siteId, date, type } = req.query as Record<string, string>;
  const conditions: any[] = [
    eq(dailyChecklistsTable.clientId, clientId),
    ...(AM_TYPES as readonly string[]).map(() => []).flat(),
  ];

  // Only AM types
  const amCondition = inArray(dailyChecklistsTable.checklistType, AM_TYPES as unknown as [string, ...string[]]);
  conditions.push(amCondition);

  if (siteId && !isNaN(parseInt(siteId))) conditions.push(eq(dailyChecklistsTable.siteId, parseInt(siteId)));
  if (date) conditions.push(eq(dailyChecklistsTable.checkDate, date));
  if (type && (AM_TYPES as readonly string[]).includes(type)) conditions.push(eq(dailyChecklistsTable.checklistType, type));

  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(or(isNull(dailyChecklistsTable.siteId), inArray(dailyChecklistsTable.siteId, allowedSites(clientId, deptId))) as any);
  }

  const rows = await db.select().from(dailyChecklistsTable)
    .where(and(...conditions))
    .orderBy(desc(dailyChecklistsTable.checkDate), desc(dailyChecklistsTable.id));
  res.json(rows);
});

// GET /api/daily-track-am/:id
router.get("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [row] = await db.select().from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!row || !(AM_TYPES as readonly string[]).includes(row.checklistType)) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// POST /api/daily-track-am
router.post("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  const requiredService = serviceForType(data.checklistType);
  if (!(await requireAnyEntitlement(clientId, requiredService))) {
    return res.status(403).json({
      error: `${SERVICES[requiredService].label} is not enabled for this account`,
      code: "SERVICE_NOT_ENABLED",
      service: requiredService,
    });
  }
  if (!(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
  const [row] = await db.insert(dailyChecklistsTable).values({
    clientId,
    siteId: data.siteId ?? null,
    checklistType: data.checklistType,
    checkDate: data.checkDate,
    items: (data.items ?? []) as any,
    completedBy: data.completedBy ?? null,
    managerNote: data.managerNote ?? null,
    submittedAt: data.submittedAt ? new Date(data.submittedAt) : null,
    createdBy: (req.session as any).userId ?? null,
  }).returning();
  res.status(201).json(row);
});

// PUT /api/daily-track-am/:id
router.put("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [existing] = await db.select().from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!existing || !(AM_TYPES as readonly string[]).includes(existing.checklistType)) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Checklist already submitted" });
  const requiredService = serviceForType(existing.checklistType as (typeof AM_TYPES)[number]);
  if (!(await requireAnyEntitlement(clientId, requiredService))) {
    return res.status(403).json({
      error: `${SERVICES[requiredService].label} is not enabled for this account`,
      code: "SERVICE_NOT_ENABLED",
      service: requiredService,
    });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data as any;
  const [row] = await db.update(dailyChecklistsTable)
    .set({ ...data, items: data.items as any, submittedAt: data.submittedAt ? new Date(data.submittedAt) : undefined, updatedAt: new Date() })
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).returning();
  res.json(row);
});

// DELETE /api/daily-track-am/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [existing] = await db.select({ id: dailyChecklistsTable.id, submittedAt: dailyChecklistsTable.submittedAt }).from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Cannot delete a submitted checklist" });
  await db.delete(dailyChecklistsTable).where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId)));
  res.status(204).end();
});

export default router;
