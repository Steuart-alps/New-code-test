import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { dailyChecklistsTable, dailyManagerSignoffsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, gte, lte } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEntitledServices, requireAnyEntitlement, SERVICES } from "../lib/services";
import {
  accessibleDailyChecklistTypes,
  canAccessDailyChecklistType,
  serviceForDailyChecklistType,
  type DailyChecklistType,
} from "../lib/dailyChecklistEntitlements";
import { resolveStaffPerformer as resolveStaffRoster, resolveStaffPerformerUpdate } from "../lib/staffPerformer";

const router = Router();

const AM_TYPES = ["kitchen_opening", "premises_opening"] as const;

// KitchenTrack/PremisesTrack subscribers retain access to their matching checklist,
// while the standalone DailyTrack AM add-on grants access to every AM checklist.
async function accessibleTypes(clientId: number): Promise<(typeof AM_TYPES)[number][]> {
  const services = await getEntitledServices(clientId);
  return accessibleDailyChecklistTypes(services, "am") as (typeof AM_TYPES)[number][];
}

async function canAccessType(clientId: number, type: (typeof AM_TYPES)[number]): Promise<boolean> {
  const services = await getEntitledServices(clientId);
  return canAccessDailyChecklistType(services, "am", type);
}

function serviceDenied(res: any, type: (typeof AM_TYPES)[number]) {
  const requiredService = serviceForDailyChecklistType(type);
  return res.status(403).json({
    error: `${SERVICES[requiredService].label} is not enabled for this account`,
    code: "SERVICE_NOT_ENABLED",
    service: requiredService,
  });
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
  staffRosterId: z.number().int().positive().nullable().optional(),
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
  const allowedTypes = await accessibleTypes(clientId);
  if (allowedTypes.length === 0) return res.status(403).json({ error: "No AM checklist service is enabled" });
  if (type && (AM_TYPES as readonly string[]).includes(type) && !allowedTypes.includes(type as (typeof AM_TYPES)[number])) {
    return serviceDenied(res, type as (typeof AM_TYPES)[number]);
  }
  const conditions: any[] = [
    eq(dailyChecklistsTable.clientId, clientId),
    inArray(dailyChecklistsTable.checklistType, allowedTypes as [string, ...string[]]),
  ];

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

// GET /api/daily-track-am/history?from=&to= — slim completion history across
// ALL checklist types + manager sign-offs, for the month/pattern view.
router.get("/history", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { from, to } = req.query as Record<string, string>;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
    return res.status(400).json({ error: "from and to (YYYY-MM-DD) are required" });
  }
  const allowedTypes = await accessibleTypes(clientId);
  if (allowedTypes.length === 0) return res.status(403).json({ error: "No AM checklist service is enabled" });

  const deptId = getActiveDepartmentId(req);
  const deptFilter = (siteCol: any) =>
    deptId !== null ? (or(isNull(siteCol), inArray(siteCol, allowedSites(clientId, deptId))) as any) : undefined;

  const clConditions: any[] = [
    eq(dailyChecklistsTable.clientId, clientId),
    inArray(dailyChecklistsTable.checklistType, allowedTypes as [string, ...string[]]),
    gte(dailyChecklistsTable.checkDate, from),
    lte(dailyChecklistsTable.checkDate, to),
  ];
  const clDept = deptFilter(dailyChecklistsTable.siteId);
  if (clDept) clConditions.push(clDept);

  const soConditions: any[] = [
    eq(dailyManagerSignoffsTable.clientId, clientId),
    gte(dailyManagerSignoffsTable.signoffDate, from),
    lte(dailyManagerSignoffsTable.signoffDate, to),
  ];
  const soDept = deptFilter(dailyManagerSignoffsTable.siteId);
  if (soDept) soConditions.push(soDept);

  const [checklists, signoffs] = await Promise.all([
    db.select({
      checkDate: dailyChecklistsTable.checkDate,
      siteId: dailyChecklistsTable.siteId,
      checklistType: dailyChecklistsTable.checklistType,
      submittedAt: dailyChecklistsTable.submittedAt,
    }).from(dailyChecklistsTable).where(and(...clConditions)),
    db.select({
      signoffDate: dailyManagerSignoffsTable.signoffDate,
      siteId: dailyManagerSignoffsTable.siteId,
      submittedAt: dailyManagerSignoffsTable.submittedAt,
    }).from(dailyManagerSignoffsTable).where(and(...soConditions)),
  ]);

  res.json({ checklists, signoffs });
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
  if (!(await canAccessType(clientId, row.checklistType as (typeof AM_TYPES)[number]))) {
    return serviceDenied(res, row.checklistType as (typeof AM_TYPES)[number]);
  }
  res.json(row);
});

// POST /api/daily-track-am
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  const requiredService = serviceForDailyChecklistType(data.checklistType);
  if (!(await requireAnyEntitlement(clientId, "dailytrack_am", requiredService))) {
    return res.status(403).json({
      error: `${SERVICES[requiredService].label} is not enabled for this account`,
      code: "SERVICE_NOT_ENABLED",
      service: requiredService,
    });
  }
  if (!(await verifySite(data.siteId, clientId))) return res.status(400).json({ error: "Invalid site" });
  const performer = await resolveStaffRoster(clientId, data.staffRosterId, data.completedBy);
  if (data.staffRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
  const [row] = await db.insert(dailyChecklistsTable).values({
    clientId,
    siteId: data.siteId ?? null,
    checklistType: data.checklistType,
    checkDate: data.checkDate,
    items: (data.items ?? []) as any,
    completedBy: performer?.performedBy ?? null,
    staffRosterId: performer?.staffRosterId ?? null,
    managerNote: data.managerNote ?? null,
    submittedAt: data.submittedAt ? new Date(data.submittedAt) : null,
    createdBy: (req.session as any).userId ?? null,
  } as any).returning();
  res.status(201).json(row);
});

// PUT /api/daily-track-am/:id
router.put("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [existing] = await db.select().from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!existing || !(AM_TYPES as readonly string[]).includes(existing.checklistType)) return res.status(404).json({ error: "Not found" });
  if (existing.submittedAt) return res.status(409).json({ error: "Checklist already submitted" });
  const requiredService = serviceForDailyChecklistType(existing.checklistType as DailyChecklistType);
  if (!(await requireAnyEntitlement(clientId, "dailytrack_am", requiredService))) {
    return res.status(403).json({
      error: `${SERVICES[requiredService].label} is not enabled for this account`,
      code: "SERVICE_NOT_ENABLED",
      service: requiredService,
    });
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data as any;
  const performer = await resolveStaffPerformerUpdate(clientId, data.staffRosterId, data.completedBy, (existing as any).staffRosterId, existing.completedBy);
  if (data.staffRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
  const [row] = await db.update(dailyChecklistsTable)
    .set({ ...data, completedBy: performer?.performedBy, staffRosterId: performer?.staffRosterId, items: data.items as any, submittedAt: data.submittedAt ? new Date(data.submittedAt) : undefined, updatedAt: new Date() })
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).returning();
  res.json(row);
});

// DELETE /api/daily-track-am/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const [existing] = await db.select({
    id: dailyChecklistsTable.id,
    checklistType: dailyChecklistsTable.checklistType,
    submittedAt: dailyChecklistsTable.submittedAt,
  }).from(dailyChecklistsTable)
    .where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId))).limit(1);
  if (!existing || !(AM_TYPES as readonly string[]).includes(existing.checklistType)) return res.status(404).json({ error: "Not found" });
  if (!(await canAccessType(clientId, existing.checklistType as (typeof AM_TYPES)[number]))) {
    return serviceDenied(res, existing.checklistType as (typeof AM_TYPES)[number]);
  }
  if (existing.submittedAt) return res.status(409).json({ error: "Cannot delete a submitted checklist" });
  await db.delete(dailyChecklistsTable).where(and(eq(dailyChecklistsTable.id, id), eq(dailyChecklistsTable.clientId, clientId)));
  res.status(204).end();
});

export default router;
