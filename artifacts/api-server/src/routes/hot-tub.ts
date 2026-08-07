import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { hotTubChecksTable, sitesTable, HOT_TUB_CHECK_TYPES } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";

const router = Router();

export type HotTubCheckType = (typeof HOT_TUB_CHECK_TYPES)[number];

/** Default maintenance frequencies (days) — based on HSG282 / PWTAG guidance */
const FREQUENCY_DAYS: Record<HotTubCheckType, number> = {
  water_chemistry:       1,    // Daily: pH and sanitiser levels
  temperature:           1,    // Daily: water temperature must not exceed 40°C
  filter_clean:          7,    // Weekly: filter rinse; deep-clean monthly
  cover_inspection:      7,    // Weekly: check cover condition and seals
  drain_refill:          91,   // Quarterly: full drain, clean and disinfect
  microbiological_test:  91,   // Quarterly: water sample bacteria test
  risk_assessment:       365,  // Annual: HSG282 risk assessment review
};

const createSchema = z.object({
  checkType: z.enum(HOT_TUB_CHECK_TYPES),
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  result: z.enum(["pass", "fail", "action_required"]),
  session: z.enum(["morning", "midday", "evening"]).nullable().optional(),
  phValue: z.number().min(0).max(14).nullable().optional(),
  sanitiserLevel: z.number().min(0).nullable().optional(),
  temperature: z.number().min(0).max(50).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  hotTubId: z.number().int().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  performedBy: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

// ── Hot Tub Registry CRUD ─────────────────────────────────────────────────────

const tubSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  active: z.boolean().optional(),
});

// GET /api/hot-tub/tubs
router.get("/tubs", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const rows = await db.execute(sql`
    SELECT ht.id, ht.client_id, ht.site_id, ht.name, ht.description, ht.active,
           ht.created_at, ht.updated_at,
           s.name AS site_name
    FROM hot_tubs ht
    LEFT JOIN sites s ON s.id = ht.site_id
    WHERE ht.client_id = ${clientId}
    ORDER BY ht.active DESC, ht.name
  `);
  res.json(rows.rows ?? rows);
});

// POST /api/hot-tub/tubs
router.post("/tubs", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = tubSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  if (d.siteId) {
    const siteCheckResult = await db.execute(sql`SELECT id FROM sites WHERE id = ${d.siteId} AND client_id = ${clientId} LIMIT 1`);
    const site = ((siteCheckResult as any).rows ?? [])[0];
    if (!site?.id) return res.status(400).json({ error: "Invalid site" });
  }
  const result = await db.execute(sql`
    INSERT INTO hot_tubs (client_id, site_id, name, description, active)
    VALUES (${clientId}, ${d.siteId ?? null}, ${d.name}, ${d.description ?? null}, true)
    RETURNING *
  `);
  res.status(201).json((result.rows ?? [result])[0]);
});

// PUT /api/hot-tub/tubs/:id
router.put("/tubs/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = tubSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const result = await db.execute(sql`
    UPDATE hot_tubs
    SET name        = COALESCE(${d.name ?? null}, name),
        description = CASE WHEN ${d.description !== undefined} THEN ${d.description ?? null} ELSE description END,
        site_id     = CASE WHEN ${d.siteId !== undefined} THEN ${d.siteId ?? null} ELSE site_id END,
        active      = COALESCE(${d.active ?? null}, active),
        updated_at  = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *
  `);
  const row = (result.rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// DELETE /api/hot-tub/tubs/:id
router.delete("/tubs/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  // Block deletion if records reference this tub
  const usageResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM hot_tub_checks WHERE hot_tub_id = ${id} AND client_id = ${clientId}
  `);
  const cnt = parseInt(String((usageResult.rows ?? [])[0]?.cnt ?? 0));
  if (cnt > 0) return res.status(409).json({ error: `Cannot delete — ${cnt} record${cnt !== 1 ? "s" : ""} reference this tub. Mark it inactive instead.` });
  await db.execute(sql`DELETE FROM hot_tubs WHERE id = ${id} AND client_id = ${clientId}`);
  res.status(204).end();
});

const updateSchema = createSchema.partial().omit({ checkType: true });

async function fetchClientSite(siteId: number | null | undefined, clientId: number) {
  if (siteId == null) return null;
  const [site] = await db
    .select({ id: sitesTable.id, departmentId: sitesTable.departmentId })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  return site ?? null;
}

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

function allowedSitesSubquery(clientId: number, deptId: number) {
  return db
    .select({ id: sitesTable.id })
    .from(sitesTable)
    .where(and(
      eq(sitesTable.clientId, clientId),
      or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)),
    ));
}

// GET /api/hot-tub?checkType=&siteId=
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const conditions = [eq(hotTubChecksTable.clientId, clientId)];
  const { checkType, siteId } = req.query as { checkType?: string; siteId?: string };
  if (checkType && (HOT_TUB_CHECK_TYPES as readonly string[]).includes(checkType)) {
    conditions.push(eq(hotTubChecksTable.checkType, checkType));
  }
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(hotTubChecksTable.siteId, parseInt(siteId)));
  }

  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(hotTubChecksTable.siteId), inArray(hotTubChecksTable.siteId, allowedSitesSubquery(clientId, deptId))) as any,
    );
  }

  const rows = await db
    .select()
    .from(hotTubChecksTable)
    .where(and(...conditions))
    .orderBy(desc(hotTubChecksTable.checkDate), desc(hotTubChecksTable.id));

  res.json(rows);
});

// GET /api/hot-tub/status?siteId=
router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { siteId } = req.query as { siteId?: string };
  const conditions = [eq(hotTubChecksTable.clientId, clientId)];
  if (siteId && !isNaN(parseInt(siteId))) {
    conditions.push(eq(hotTubChecksTable.siteId, parseInt(siteId)));
  }

  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(
      or(isNull(hotTubChecksTable.siteId), inArray(hotTubChecksTable.siteId, allowedSitesSubquery(clientId, deptId))) as any,
    );
  }

  const lastDates = await db
    .select({
      checkType: hotTubChecksTable.checkType,
      lastDate: sql<string>`max(${hotTubChecksTable.checkDate})`,
    })
    .from(hotTubChecksTable)
    .where(and(...conditions))
    .groupBy(hotTubChecksTable.checkType);

  const lastByType = new Map(lastDates.map((r) => [r.checkType, r.lastDate]));
  const MS_DAY = 24 * 60 * 60 * 1000;
  const toUtcDays = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_DAY);
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayDays = toUtcDays(todayIso);

  const statuses = HOT_TUB_CHECK_TYPES.map((checkType) => {
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

  // Session completion for 3× daily check types
  const DAILY_SESSION_TYPES = ["water_chemistry", "temperature"];
  const sessionRows = await db.execute(sql`
    SELECT check_type, session
    FROM hot_tub_checks
    WHERE client_id = ${clientId}
      AND check_date = ${todayIso}
      AND check_type IN ('water_chemistry', 'temperature')
      AND session IS NOT NULL
  `);
  const sessionsByType = new Map<string, Set<string>>();
  for (const row of (sessionRows.rows ?? []) as { check_type: string; session: string }[]) {
    if (!sessionsByType.has(row.check_type)) sessionsByType.set(row.check_type, new Set());
    sessionsByType.get(row.check_type)!.add(row.session);
  }
  const enriched = statuses.map((s) => {
    if (!DAILY_SESSION_TYPES.includes(s.checkType)) return s;
    const done = sessionsByType.get(s.checkType) ?? new Set<string>();
    return {
      ...s,
      sessionsToday: {
        morning: done.has("morning"),
        midday:  done.has("midday"),
        evening: done.has("evening"),
      },
    };
  });

  res.json(enriched);
});

// POST /api/hot-tub
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

  // Validate hotTubId belongs to client
  if (data.hotTubId) {
    const tubCheck = await db.execute(sql`SELECT id FROM hot_tubs WHERE id = ${data.hotTubId} AND client_id = ${clientId} LIMIT 1`);
    if (!(tubCheck.rows ?? [])[0]) return res.status(400).json({ error: "Invalid tub" });
  }

  const [inserted] = await db
    .insert(hotTubChecksTable)
    .values({
      clientId,
      checkType: data.checkType,
      checkDate: data.checkDate,
      result: data.result,
      session: data.session ?? null,
      phValue: data.phValue != null ? String(data.phValue) : null,
      sanitiserLevel: data.sanitiserLevel != null ? String(data.sanitiserLevel) : null,
      temperature: data.temperature != null ? String(data.temperature) : null,
      siteId: data.siteId ?? null,
      hotTubId: data.hotTubId ?? null,
      location: data.location ?? null,
      performedBy: data.performedBy ?? null,
      notes: data.notes ?? null,
      createdBy: (req.session as any).userId ?? null,
    })
    .returning();

  res.status(201).json(inserted);
});

// PUT /api/hot-tub/:id
router.put("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const [existing] = await db
    .select()
    .from(hotTubChecksTable)
    .where(and(eq(hotTubChecksTable.id, id), eq(hotTubChecksTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  const existingAccess = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (existingAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });

  if ("siteId" in parsed.data) {
    const newAccess = await checkSiteAccess(parsed.data.siteId, clientId, deptId);
    if (newAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (newAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }

  const { phValue, sanitiserLevel, temperature, session, ...rest } = parsed.data;
  const updateData: any = { ...rest, updatedAt: new Date() };
  if (phValue !== undefined) updateData.phValue = phValue != null ? String(phValue) : null;
  if (sanitiserLevel !== undefined) updateData.sanitiserLevel = sanitiserLevel != null ? String(sanitiserLevel) : null;
  if (temperature !== undefined) updateData.temperature = temperature != null ? String(temperature) : null;
  if (session !== undefined) updateData.session = session ?? null;

  const [updated] = await db
    .update(hotTubChecksTable)
    .set(updateData)
    .where(and(eq(hotTubChecksTable.id, id), eq(hotTubChecksTable.clientId, clientId)))
    .returning();

  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(updated);
});

// DELETE /api/hot-tub/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const [existing] = await db
    .select()
    .from(hotTubChecksTable)
    .where(and(eq(hotTubChecksTable.id, id), eq(hotTubChecksTable.clientId, clientId)))
    .limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const deptId = getActiveDepartmentId(req);
  const access = await checkSiteAccess(existing.siteId, clientId, deptId);
  if (access === "forbidden") return res.status(403).json({ error: "Forbidden" });

  await db
    .delete(hotTubChecksTable)
    .where(and(eq(hotTubChecksTable.id, id), eq(hotTubChecksTable.clientId, clientId)));

  res.status(204).end();
});

export default router;
