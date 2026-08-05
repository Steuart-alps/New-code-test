import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { legionellaChecksTable, sitesTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";

const router = Router();

// HSG274 Part 2 Table 2.1 — recommended monitoring, inspection and testing activities
const CHECK_TYPES = [
  // Temperature monitoring — hot water system
  "calorifier_temp",       // Weekly:     Calorifier flow/return (≥60°C)
  "hot_sentinel_temp",     // Monthly:    Hot water sentinel outlets (≥50°C after 1 min)
  "hot_nonsent_temp",      // Quarterly:  Hot water representative outlets (≥50°C after 1 min)
  // Temperature monitoring — cold water system
  "cold_tank_temp",        // Monthly:    Cold water storage temperature (≤20°C)
  "cold_sentinel_temp",    // Monthly:    Cold water sentinel outlets (≤20°C after 2 min)
  "cold_nonsent_temp",     // Quarterly:  Cold water representative outlets (≤20°C after 2 min)
  // Inspection & maintenance
  "cold_tank_inspection",  // 6-monthly:  Cold water storage tank visual inspection
  "cold_tank_clean",       // Annually:   Cold water storage tank clean & disinfect
  "calorifier_inspection", // Annually:   Calorifier internal inspection
  "calorifier_clean",      // Annually:   Calorifier clean & disinfect
  "shower_clean",          // Quarterly:  Shower head / hose descale & disinfect
  "tmv_service",           // Annually:   Thermostatic mixing valve service & verify
  "outlet_flush",          // Weekly:     Little-used outlet 5-minute flush
] as const;

// Frequencies per HSG274 Part 2 Table 2.1
const FREQUENCY_DAYS: Record<(typeof CHECK_TYPES)[number], number> = {
  calorifier_temp:       7,    // Weekly
  hot_sentinel_temp:     30,   // Monthly
  hot_nonsent_temp:      90,   // Quarterly
  cold_tank_temp:        30,   // Monthly
  cold_sentinel_temp:    30,   // Monthly
  cold_nonsent_temp:     90,   // Quarterly
  cold_tank_inspection:  183,  // 6-monthly
  cold_tank_clean:       365,  // Annually
  calorifier_inspection: 365,  // Annually
  calorifier_clean:      365,  // Annually
  shower_clean:          90,   // Quarterly
  tmv_service:           365,  // Annually
  outlet_flush:          7,    // Weekly
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

// ── Template config ───────────────────────────────────────────────────────────
const WATER_CONFIG_KEYS = [
  "water_sentinel_outlets",     // JSON: [{name:string, type:"hot"|"cold", location?:string}]
  "water_non_sentinel_outlets", // JSON: string[]
  "water_default_performer",
] as const;

const WATER_DEFAULT_CONFIG = {
  water_sentinel_outlets: "",
  water_non_sentinel_outlets: "",
  water_default_performer: "",
};

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const settingRows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.clientId, clientId));
  const config: Record<string, string> = { ...WATER_DEFAULT_CONFIG };
  for (const row of settingRows) {
    if (WATER_CONFIG_KEYS.includes(row.key as (typeof WATER_CONFIG_KEYS)[number]) && row.value != null) {
      config[row.key] = row.value;
    }
  }
  res.json(config);
});

router.put("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const updates = req.body as Record<string, string>;
  for (const key of WATER_CONFIG_KEYS) {
    if (key in updates) {
      const existing = await db.select({ id: appSettingsTable.clientId }).from(appSettingsTable)
        .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key))).limit(1);
      if (existing.length > 0) {
        await db.update(appSettingsTable).set({ value: updates[key], updatedAt: new Date() })
          .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, key)));
      } else {
        await db.insert(appSettingsTable).values({ clientId, key, value: updates[key] });
      }
    }
  }
  res.json({ ok: true });
});

export default router;
