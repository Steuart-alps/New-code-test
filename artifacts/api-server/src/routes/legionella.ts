import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { legionellaChecksTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";

const router = Router();

const CHECK_TYPES = [
  "cold_water_temp",
  "hot_water_temp",
  "sentinel_flush",
  "shower_clean",
  "tank_inspection",
  "risk_assessment",
] as const;

// Default check frequencies in days (UK HSG274 / L8 guidance)
const FREQUENCY_DAYS: Record<(typeof CHECK_TYPES)[number], number> = {
  cold_water_temp: 7,       // Weekly: cold outlets should be ≤20°C
  hot_water_temp: 7,        // Weekly: hot outlets should be ≥50°C
  sentinel_flush: 30,       // Monthly: flush little-used sentinel outlets
  shower_clean: 90,         // Quarterly: shower head/hose descale & disinfect
  tank_inspection: 30,      // Monthly: cold water storage tank inspection
  risk_assessment: 365,     // Annual: Legionella risk assessment review
};

const createSchema = z.object({
  checkType: z.enum(CHECK_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result: z.enum(["pass", "fail", "action_required"]),
  temperature: z.number().nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  performedBy: z.string().max(200).nullable().optional(),
});

const updateSchema = createSchema.partial().omit({ checkType: true });

/** Returns the site row if it belongs to the tenant, or null. */
async function fetchClientSite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return null;
  const [site] = await db
    .select({ id: sitesTable.id, departmentId: sitesTable.departmentId })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  return site ?? null;
}

/**
 * Two-step site access check. Returns:
 *   null        → no siteId supplied; no check needed
 *   "not_found" → siteId does not belong to this client (→ 400)
 *   "forbidden" → site is in a different department (→ 403)
 *   "ok"        → access granted
 */
async function checkSiteAccess(
  siteId: number | null | undefined,
  clientId: number,
  deptId: number | null,
): Promise<null | "not_found" | "forbidden" | "ok"> {
  if (siteId == null) return null;
  const site = await fetchClientSite(siteId, clientId);
  if (!site) return "not_found";
  if (deptId !== null && site.departmentId !== null && site.departmentId !== deptId) return "forbidden";
  return "ok";
}

/** Build the subquery that limits checks to sites accessible to the user. */
function allowedSitesSubquery(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
    ));
}

// GET /api/legionella?checkType=&siteId=
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const conditions = [eq(legionellaChecksTable.clientId, clientId)];
  const { checkType, siteId } = req.query as { checkType?: string; siteId?: string };
  if (checkType && (CHECK_TYPES as readonly string[]).includes(checkType)) {
    conditions.push(eq(legionellaChecksTable.checkType, checkType));
  }
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(legionellaChecksTable.siteId, parseInt(siteId)));
  }

  // Department scoping: staff/viewers only see checks for sites in their dept.
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(legionellaChecksTable.siteId), inArray(legionellaChecksTable.siteId, allowedSitesSubquery(clientId, deptId))) as any,
    );
  }

  const rows = await db
    .select()
    .from(legionellaChecksTable)
    .where(and(...conditions))
    .orderBy(desc(legionellaChecksTable.checkDate), desc(legionellaChecksTable.id));

  res.json(rows);
});

// GET /api/legionella/status?siteId=
router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { siteId } = req.query as { siteId?: string };
  const conditions = [eq(legionellaChecksTable.clientId, clientId)];
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(legionellaChecksTable.siteId, parseInt(siteId)));
  }

  // Department scoping: status should only reflect checks visible to this user.
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(legionellaChecksTable.siteId), inArray(legionellaChecksTable.siteId, allowedSitesSubquery(clientId, deptId))) as any,
    );
  }

  const lastDates = await db
    .select({
      checkType: legionellaChecksTable.checkType,
      lastDate: sql<string>`max(${legionellaChecksTable.checkDate})`,
    })
    .from(legionellaChecksTable)
    .where(and(...conditions))
    .groupBy(legionellaChecksTable.checkType);

  const lastByType = new Map(lastDates.map((r) => [r.checkType, r.lastDate]));
  const MS_DAY = 24 * 60 * 60 * 1000;
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

// POST /api/legionella
router.post("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;

  const deptId = getActiveDepartmentId(req);
  const siteAccess = await checkSiteAccess(data.siteId, clientId, deptId);
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });

  const [inserted] = await db
    .insert(legionellaChecksTable)
    .values({
      clientId,
      checkType: data.checkType,
      checkDate: data.checkDate,
      result: data.result,
      temperature: data.temperature != null ? String(data.temperature) : null,
      siteId: data.siteId ?? null,
      location: data.location ?? null,
      notes: data.notes ?? null,
      performedBy: data.performedBy ?? null,
      createdBy: (req.session as any).userId ?? null,
    })
    .returning();

  res.status(201).json(inserted);
});

// PUT /api/legionella/:id
router.put("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  // Fetch the existing record to verify dept access before and after mutation.
  const [existing] = await db
    .select()
    .from(legionellaChecksTable)
    .where(and(eq(legionellaChecksTable.id, id), eq(legionellaChecksTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  // Current record's site must be accessible to the user
  const existingAccess = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (existingAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  // If updating siteId, the new site must also pass both checks
  if ("siteId" in parsed.data) {
    const newAccess = await checkSiteAccess(parsed.data.siteId, clientId, deptId);
    if (newAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (newAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }

  const { temperature, ...rest } = parsed.data;
  const updateData: any = { ...rest, updatedAt: new Date() };
  if (temperature !== undefined) {
    updateData.temperature = temperature != null ? String(temperature) : null;
  }

  const [updated] = await db
    .update(legionellaChecksTable)
    .set(updateData)
    .where(and(eq(legionellaChecksTable.id, id), eq(legionellaChecksTable.clientId, clientId)))
    .returning();

  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(updated);
});

// DELETE /api/legionella/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db
    .select()
    .from(legionellaChecksTable)
    .where(and(eq(legionellaChecksTable.id, id), eq(legionellaChecksTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  const access = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });

  await db
    .delete(legionellaChecksTable)
    .where(and(eq(legionellaChecksTable.id, id), eq(legionellaChecksTable.clientId, clientId)));

  res.status(204).end();
});

export default router;
