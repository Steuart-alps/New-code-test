import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { dailyChecklistsTable, dailyManagerSignoffsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { requireAnyEntitlement, SERVICES } from "../lib/services";

const router = Router();

const PM_TYPES = ["kitchen_closing", "premises_closing"] as const;

// The router-level guard only requires SOME purchased branch (kitchentrack or
// safetrack), since this router covers both. Individual checklist writes are
// checked against the specific branch the checklistType belongs to.
function serviceForType(type: (typeof PM_TYPES)[number]): "kitchentrack" | "safetrack" {
  return type === "kitchen_closing" ? "kitchentrack" : "safetrack";
}

const itemSchema = z.object({
  label: z.string(),
  checked: z.boolean(),
  notes: z.string().optional(),
});

const createSchema = z.object({
  siteId: z.number().int().nullable().optional(),
  checklistType: z.enum(PM_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(itemSchema).optional(),
  completedBy: z.string().max(200).nullable().optional(),
  managerNote: z.string().max(2000).nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checklistType: true, checkDate: true });

const signoffCreateSchema = z.object({
  siteId: z.number().int().nullable().optional(),
  signoffDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  managerName: z.string().min(1).max(200),
  notes: z.string().max(2000).nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
});

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

// ── Manager Sign-offs (MUST come before /:id) ────────────────────────────────

router.get("/signoffs", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { siteId, date } = req.query as Record<string, string>;
  const conditions: any[] = [eq(dailyManagerSignoffsTable.clientId, clientId)];
  if (siteId && !isNaN(parseInt(siteId))) conditions.push(eq(dailyManagerSignoffsTable.siteId, parseInt(siteId)));
  if (date) conditions.push(eq(dailyManagerSignoffsTable.signoffDate, date));
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(or(isNull(dailyManagerSignoffsTable.siteId), inArray(dailyManagerSignoffsTable.siteId, allowedSites(clientId, deptId))) as any);
  }
  const rows = await db.select().from(dailyManagerSignoffsTable)
    .where(and(...conditions)).orderBy(desc(dailyManagerSignoffsTable.signoffDate), desc(dailyManagerSignoffsTable.id));
  res.json(rows);
});

router.post("/signoffs", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = signoffCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  if (!(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
  const [row] = await db.insert(dailyManagerSignoffsTable).values({
    clientId, siteId: data.siteId ?? null, signoffDate: data.signoffDate,
    managerName: data.managerName, notes: data.notes ?? null,
    submittedAt: data.submittedAt ? new Date(data.submittedAt) : null,
    createdBy: (req.session as any).userId ?? null,
  }).returning();
  res.status(201).json(row);
});

router.put("/signoffs/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [existing] = await db.select({ id: dailyManagerSignoffsTable.id, submittedAt: dailyManagerSignoffsTable.submittedAt })
    .from(dailyManagerSignoffsTable)
    .where(and(eq(dailyManagerSignoffsTable.id, id), eq(dailyManagerSignoffsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Sign-off already submitted" });
  const parsed = signoffCreateSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data as any;
  const [row] = await db.update(dailyManagerSignoffsTable)
    .set({ ...data, submittedAt: data.submittedAt ? new Date(data.submittedAt) : undefined, updatedAt: new Date() })
    .where(and(eq(dailyManagerSignoffsTable.id, id), eq(dailyManagerSignoffsTable.clientId, clientId))).returning();
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.delete("/signoffs/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [existing] = await db.select({ id: dailyManagerSignoffsTable.id, submittedAt: dailyManagerSignoffsTable.submittedAt })
    .from(dailyManagerSignoffsTable)
    .where(and(eq(dailyManagerSignoffsTable.id, id), eq(dailyManagerSignoffsTable.clientId, clientId))).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Cannot delete a submitted sign-off" });
  await db.delete(dailyManagerSignoffsTable).where(and(eq(dailyManagerSignoffsTable.id, id), eq(dailyManagerSignoffsTable.clientId, clientId)));
  res.status(204).end();
});

// ── Checklists ────────────────────────────────────────────────────────────────

router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { siteId, date, type } = req.query as Record<string, string>;
  const conditions: any[] = [
    eq(dailyChecklistsTable.clientId, clientId),
    inArray(dailyChecklistsTable.checklistType, PM_TYPES as unknown as [string, ...string[]]),
  ];
  if (siteId && !isNaN(parseInt(siteId))) conditions.push(eq(dailyChecklistsTable.siteId, parseInt(siteId)));
  if (date) conditions.push(eq(dailyChecklistsTable.checkDate, date));
  if (type && (PM_TYPES as readonly string[]).includes(type)) conditions.push(eq(dailyChecklistsTable.checklistType, type));
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(or(isNull(dailyChecklistsTable.siteId), inArray(dailyChecklistsTable.siteId, allowedSites(clientId, deptId))) as any);
  }
  const rows = await db.select().from(dailyChecklistsTable)
    .where(and(...conditions)).orderBy(desc(dailyChecklistsTable.checkDate), desc(dailyChecklistsTable.id));
  res.json(rows);
});

router.get("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [row] = await db.select().from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!row || !(PM_TYPES as readonly string[]).includes(row.checklistType)) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

router.post("/", requireAuth, denyViewers, async (req, res) => {
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
    clientId, siteId: data.siteId ?? null, checklistType: data.checklistType,
    checkDate: data.checkDate, items: (data.items ?? []) as any,
    completedBy: data.completedBy ?? null, managerNote: data.managerNote ?? null,
    submittedAt: data.submittedAt ? new Date(data.submittedAt) : null,
    createdBy: (req.session as any).userId ?? null,
  }).returning();
  res.status(201).json(row);
});

router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [existing] = await db.select().from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!existing || !(PM_TYPES as readonly string[]).includes(existing.checklistType)) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Checklist already submitted" });
  const requiredService = serviceForType(existing.checklistType as (typeof PM_TYPES)[number]);
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

router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
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
