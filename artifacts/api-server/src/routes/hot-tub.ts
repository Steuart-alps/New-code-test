import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { hotTubChecksTable, sitesTable, HOT_TUB_CHECK_TYPES, trackControlProfilesTable, auditEventsTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { resolveStaffPerformer, resolveStaffPerformerUpdate } from "../lib/staffPerformer";

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
  // New observations use the canonical pass/fail vocabulary. Legacy records
  // retain their original result when read.
  result: z.enum(["pass", "fail"]),
  session: z.enum(["morning", "midday", "evening"]).nullable().optional(),
  phValue: z.number().finite().min(0).max(14).nullable().optional(),
  sanitiserLevel: z.number().finite().min(0).nullable().optional(),
  temperature: z.number().finite().min(0).max(50).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  hotTubId: z.number().int().nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  performedBy: z.string().max(200).nullable().optional(),
  staffRosterId: z.number().int().positive().nullable().optional(),
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
  const departmentId = getActiveDepartmentId(req);
  const rows = await db.execute(sql`
    SELECT ht.id, ht.client_id, ht.site_id, ht.name, ht.description, ht.active,
           ht.created_at, ht.updated_at,
           s.name AS site_name
    FROM hot_tubs ht
    LEFT JOIN sites s ON s.id = ht.site_id
    WHERE ht.client_id = ${clientId}
      ${departmentId !== null ? sql`AND (
        ht.site_id IS NULL
        OR ht.site_id IN (
          SELECT id FROM sites
          WHERE client_id = ${clientId}
            AND (department_id IS NULL OR department_id = ${departmentId})
        )
      )` : sql``}
    ORDER BY ht.active DESC, ht.name
  `);
  res.json(rows.rows ?? rows);
});

// POST /api/hot-tub/tubs
router.post("/tubs", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = tubSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const siteAccess = await checkSiteAccess(d.siteId, clientId, getActiveDepartmentId(req));
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  const result = await db.execute(sql`
    INSERT INTO hot_tubs (client_id, site_id, name, description, active)
    VALUES (${clientId}, ${d.siteId ?? null}, ${d.name}, ${d.description ?? null}, true)
    RETURNING *
  `);
  res.status(201).json((result.rows ?? [result])[0]);
});

// PUT /api/hot-tub/tubs/:id
router.put("/tubs/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = tubSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const d = parsed.data;
  const existingResult = await db.execute(sql`
    SELECT id, site_id FROM hot_tubs
    WHERE id = ${id} AND client_id = ${clientId}
    LIMIT 1
  `);
  const existing = (existingResult.rows ?? [])[0] as { id: number; site_id: number | null } | undefined;
  if (!existing) return res.status(404).json({ error: "Not found" });

  const departmentId = getActiveDepartmentId(req);
  const existingAccess = await checkSiteAccess(existing.site_id, clientId, departmentId);
  if (existingAccess === "forbidden") return res.status(403).json({ error: "Forbidden" });
  if (d.siteId !== undefined) {
    const newAccess = await checkSiteAccess(d.siteId, clientId, departmentId);
    if (newAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
    if (newAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }
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
router.delete("/tubs/:id", requireAuth, denyViewers, async (req, res) => {
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

const HOT_TUB_PROFILE_MODULE = "hot_tub";
const DEFAULT_OPERATING_RANGES = { ph: { min: 7.2, max: 7.8 }, sanitiser: { min: 3, max: 5 }, temperature: { max: 40 } };
async function getHotTubProfile(clientId: number, siteId: number) {
  const [row] = await db.select({ profile: trackControlProfilesTable.profile }).from(trackControlProfilesTable)
    .where(and(eq(trackControlProfilesTable.clientId, clientId), eq(trackControlProfilesTable.siteId, siteId),
      eq(trackControlProfilesTable.module, HOT_TUB_PROFILE_MODULE))).limit(1);
  return row?.profile ?? null;
}
function hotTubBreach(data: { phValue?: number | null; sanitiserLevel?: number | null; temperature?: number | null }, checkType: string, profile: any) {
  const r = profile?.operatingRanges ?? DEFAULT_OPERATING_RANGES;
  const breached: Record<string, unknown> = {};
  if (checkType === "water_chemistry" || data.phValue != null || data.sanitiserLevel != null) {
    if (data.phValue != null && (data.phValue < r.ph.min || data.phValue > r.ph.max)) breached.ph = { observed: data.phValue, range: r.ph };
    if (data.sanitiserLevel != null && (data.sanitiserLevel < r.sanitiser.min || data.sanitiserLevel > r.sanitiser.max)) breached.sanitiser = { observed: data.sanitiserLevel, range: r.sanitiser };
  }
  if (data.temperature != null && data.temperature > r.temperature.max) breached.temperature = { observed: data.temperature, range: r.temperature };
  return Object.keys(breached).length ? breached : null;
}
async function ensureHotTubAction(tx: any, clientId: number, checkId: number, breach: unknown, userId: number | null, ownerName: string | null) {
  await tx.execute(sql`INSERT INTO compliance_actions
    (client_id, source_track, source_record_id, title, severity, owner_name, corrective_action, evidence_reference, created_by, updated_by, auto_generated)
    SELECT ${clientId}, 'HotTubTrack', ${String(checkId)}, 'Failed hot-tub safety check', 'high',
      ${ownerName ?? "Duty manager"}, 'Investigate and restore water controls',
      ${JSON.stringify({ reportedResult: "fail", breachedRanges: breach ?? null })}, ${userId}, ${userId}, true
    WHERE NOT EXISTS (SELECT 1 FROM compliance_actions WHERE client_id = ${clientId}
      AND source_track = 'HotTubTrack' AND source_record_id = ${String(checkId)})
    ON CONFLICT DO NOTHING`);
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

  // Keep one latest observation per physical tub, then aggregate by check type.
  // A single tub's passing result must not mask a newer failure on another tub.
  const lastDates = await db
    .selectDistinctOn([hotTubChecksTable.siteId, hotTubChecksTable.checkType, hotTubChecksTable.hotTubId], {
      siteId: hotTubChecksTable.siteId,
      hotTubId: hotTubChecksTable.hotTubId,
      checkType: hotTubChecksTable.checkType,
      lastDate: hotTubChecksTable.checkDate,
      lastResult: hotTubChecksTable.result,
    })
    .from(hotTubChecksTable)
    .where(and(...conditions))
    .orderBy(hotTubChecksTable.siteId, hotTubChecksTable.checkType, hotTubChecksTable.hotTubId,
      desc(hotTubChecksTable.checkDate), desc(hotTubChecksTable.id));

  const lastByType = new Map<string, { date: string; result: string }>();
  for (const row of lastDates) {
    const previous = lastByType.get(row.checkType);
    // Use the oldest unit's latest reading for scheduling: a neglected tub
    // must not be hidden by a more recently checked tub.
    const date = previous && previous.date < row.lastDate ? previous.date : row.lastDate;
    const result = previous?.result === "fail" || previous?.result === "action_required"
      || row.lastResult === "fail" || row.lastResult === "action_required"
      ? "fail" : row.lastResult;
    lastByType.set(row.checkType, { date, result });
  }
  const MS_DAY = 24 * 60 * 60 * 1000;
  const toUtcDays = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / MS_DAY);
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayDays = toUtcDays(todayIso);

  const statuses = HOT_TUB_CHECK_TYPES.map((checkType) => {
    const frequencyDays = FREQUENCY_DAYS[checkType];
    const last = lastByType.get(checkType) ?? null;
    const lastDate = last?.date ?? null;
    if (!lastDate) {
      return { checkType, frequencyDays, lastDate: null, lastResult: null, dueDate: null, status: "never" as const };
    }
    const dueDays = toUtcDays(lastDate) + frequencyDays;
    const dueDate = new Date(dueDays * MS_DAY).toISOString().slice(0, 10);
    const daysUntilDue = dueDays - todayDays;
    const dueSoonWindow = Math.max(1, Math.ceil(frequencyDays * 0.2));
    const status = daysUntilDue < 0 ? "overdue" : daysUntilDue <= dueSoonWindow ? "due_soon" : "ok";
    return { checkType, frequencyDays, lastDate, lastResult: last?.result ?? null, dueDate, status };
  });

  // Session completion for 3× daily check types
  const DAILY_SESSION_TYPES = ["water_chemistry", "temperature"];
  const sessionRows = await db.execute(sql`
    SELECT check_type, COALESCE(hot_tub_id, 0) AS unit_id, session
    FROM hot_tub_checks
    WHERE client_id = ${clientId}
      AND check_date = ${todayIso}
      AND check_type IN ('water_chemistry', 'temperature')
      ${siteId && !isNaN(parseInt(siteId)) ? sql`AND site_id = ${parseInt(siteId)}` : sql``}
      ${deptId !== null ? sql`AND (site_id IS NULL OR site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${deptId})))` : sql``}
  `);
  const unitsByType = new Map<string, Set<number>>();
  const sessionsByType = new Map<string, Map<number, Set<string>>>();
  const expectedUnits = await db.execute(sql`
    SELECT id AS unit_id
    FROM hot_tubs
    WHERE client_id = ${clientId} AND active = true
      ${siteId && !isNaN(parseInt(siteId)) ? sql`AND site_id = ${parseInt(siteId)}` : sql``}
      ${deptId !== null ? sql`AND (site_id IS NULL OR site_id IN (SELECT id FROM sites WHERE client_id = ${clientId} AND (department_id IS NULL OR department_id = ${deptId})))` : sql``}
  `);
  const expectedUnitIds = (expectedUnits.rows ?? []).map((row: any) => Number(row.unit_id));
  for (const checkType of DAILY_SESSION_TYPES) unitsByType.set(checkType, new Set(expectedUnitIds));
  for (const row of (sessionRows.rows ?? []) as { check_type: string; unit_id: number | string; session: string | null }[]) {
    const unitId = Number(row.unit_id);
    if (!unitsByType.has(row.check_type)) unitsByType.set(row.check_type, new Set());
    unitsByType.get(row.check_type)!.add(unitId);
    if (row.session != null) {
      if (!sessionsByType.has(row.check_type)) sessionsByType.set(row.check_type, new Map());
      const byUnit = sessionsByType.get(row.check_type)!;
      if (!byUnit.has(unitId)) byUnit.set(unitId, new Set());
      byUnit.get(unitId)!.add(row.session);
    }
  }
  const enriched = statuses.map((s) => {
    if (!DAILY_SESSION_TYPES.includes(s.checkType)) return s;
    const units = unitsByType.get(s.checkType) ?? new Set<number>();
    const byUnit = sessionsByType.get(s.checkType) ?? new Map<number, Set<string>>();
    const completed = (session: string) => units.size > 0
      && [...units].every(unitId => byUnit.get(unitId)?.has(session));
    return {
      ...s,
      sessionsToday: {
        morning: completed("morning"),
        midday:  completed("midday"),
        evening: completed("evening"),
      },
    };
  });

  res.json(enriched);
});

// POST /api/hot-tub
router.post("/", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });
  const data = parsed.data;
  if (data.checkType === "water_chemistry" && (data.phValue == null || data.sanitiserLevel == null))
    return res.status(400).json({ error: "Record both pH and sanitiser before marking this check" });
  if (data.checkType === "temperature" && data.temperature == null)
    return res.status(400).json({ error: "Record a temperature before marking this check" });
  const performer = await resolveStaffPerformer(clientId, data.staffRosterId, data.performedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });

  const deptId = getActiveDepartmentId(req);
  const siteAccess = await checkSiteAccess(data.siteId, clientId, deptId);
  if (siteAccess === "not_found") return res.status(400).json({ error: "Invalid site" });
  if (siteAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });

  // Validate hotTubId belongs to client
  let effectiveSiteId = data.siteId ?? null;
  if (data.hotTubId) {
    const tubCheck = await db.execute(sql`SELECT id, site_id FROM hot_tubs WHERE id = ${data.hotTubId} AND client_id = ${clientId} LIMIT 1`);
    const tub = (tubCheck.rows ?? [])[0] as any;
    if (!tub) return res.status(400).json({ error: "Invalid tub" });
    if (data.siteId != null && tub.site_id != null && data.siteId !== Number(tub.site_id)) return res.status(400).json({ error: "Tub does not belong to site" });
    effectiveSiteId = data.siteId ?? (tub.site_id == null ? null : Number(tub.site_id));
  }
  if (effectiveSiteId !== (data.siteId ?? null)) {
    const effectiveAccess = await checkSiteAccess(effectiveSiteId, clientId, deptId);
    if (effectiveAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }

  const profile = effectiveSiteId == null ? null : await getHotTubProfile(clientId, effectiveSiteId);
  const breach = hotTubBreach(data, data.checkType, profile);
  const inserted = await db.transaction(async tx => {
    const [row] = await tx.insert(hotTubChecksTable).values({
      clientId,
      checkType: data.checkType,
      checkDate: data.checkDate,
      result: breach ? "fail" : data.result,
      session: data.session ?? null,
      phValue: data.phValue != null ? String(data.phValue) : null,
      sanitiserLevel: data.sanitiserLevel != null ? String(data.sanitiserLevel) : null,
      temperature: data.temperature != null ? String(data.temperature) : null,
      siteId: effectiveSiteId,
      hotTubId: data.hotTubId ?? null,
      location: data.location ?? null,
       performedBy: performer.performedBy,
       staffRosterId: performer.staffRosterId,
      notes: data.notes ?? null,
      createdBy: (req.session as any).userId ?? null,
    }).returning();
    if (row?.result === "fail") await ensureHotTubAction(tx, clientId, row.id, breach, (req.session as any).userId ?? null, performer.performedBy);
    return row;
  });

  res.status(201).json(inserted);
});

// PUT /api/hot-tub/:id
router.put("/:id", requireAuth, denyViewers, async (req, res, next) => {
  if (req.params.id === "config") { next(); return; }
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
  let selectedSiteId = parsed.data.siteId !== undefined ? parsed.data.siteId : existing.siteId;
  const effectiveTubId = parsed.data.hotTubId === undefined ? existing.hotTubId : parsed.data.hotTubId;
  if (effectiveTubId != null) {
    const tubCheck = await db.execute(sql`SELECT site_id FROM hot_tubs WHERE id = ${effectiveTubId} AND client_id = ${clientId} LIMIT 1`);
    const tub = (tubCheck.rows ?? [])[0] as any;
    if (!tub) return res.status(400).json({ error: "Invalid tub" });
    if (selectedSiteId != null && tub.site_id != null && Number(selectedSiteId) !== Number(tub.site_id)) {
      return res.status(400).json({ error: "Tub does not belong to site" });
    }
    if (selectedSiteId == null && tub.site_id != null) selectedSiteId = Number(tub.site_id);
  }
  if (selectedSiteId !== existing.siteId) {
    const effectiveAccess = await checkSiteAccess(selectedSiteId, clientId, deptId);
    if (effectiveAccess === "forbidden") return res.status(403).json({ error: "Site not accessible" });
  }
  const performer = await resolveStaffPerformerUpdate(clientId, parsed.data.staffRosterId, parsed.data.performedBy,
    existing.staffRosterId, existing.performedBy);
  if (!performer) return res.status(400).json({ error: "Invalid staff roster member" });

  const { phValue, sanitiserLevel, temperature, session, ...rest } = parsed.data;
  const updateData: any = { ...rest, ...(performer ?? {}), updatedAt: new Date() };
  if (phValue !== undefined) updateData.phValue = phValue != null ? String(phValue) : null;
  if (sanitiserLevel !== undefined) updateData.sanitiserLevel = sanitiserLevel != null ? String(sanitiserLevel) : null;
  if (temperature !== undefined) updateData.temperature = temperature != null ? String(temperature) : null;
  if (session !== undefined) updateData.session = session ?? null;
  const siteForCheck = selectedSiteId;
  updateData.siteId = siteForCheck;
  const profile = siteForCheck == null ? null : await getHotTubProfile(clientId, siteForCheck);
  const values = {
    phValue: phValue !== undefined ? phValue : (existing.phValue == null ? null : Number(existing.phValue)),
    sanitiserLevel: sanitiserLevel !== undefined ? sanitiserLevel : (existing.sanitiserLevel == null ? null : Number(existing.sanitiserLevel)),
    temperature: temperature !== undefined ? temperature : (existing.temperature == null ? null : Number(existing.temperature)),
  };
  if (existing.checkType === "water_chemistry" && (values.phValue == null || values.sanitiserLevel == null))
    return res.status(400).json({ error: "Record both pH and sanitiser before marking this check" });
  if (existing.checkType === "temperature" && values.temperature == null)
    return res.status(400).json({ error: "Record a temperature before marking this check" });
  const breach = hotTubBreach(values, existing.checkType, profile);
  updateData.result = breach ? "fail" : (parsed.data.result !== undefined ? parsed.data.result : existing.result);
  const updated = await db.transaction(async tx => {
    const [row] = await tx.update(hotTubChecksTable).set(updateData)
      .where(and(eq(hotTubChecksTable.id, id), eq(hotTubChecksTable.clientId, clientId))).returning();
    if (row?.result === "fail") await ensureHotTubAction(tx, clientId, id, breach, (req.session as any).userId ?? null, performer.performedBy);
    return row;
  });

  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(updated);
});

const hotTubProfileSchema = z.object({
  operatingRanges: z.object({
    ph: z.object({ min: z.number().finite().min(0).max(14), max: z.number().finite().min(0).max(14) }),
    sanitiser: z.object({ min: z.number().finite().min(0), max: z.number().finite().min(0) }),
    temperature: z.object({ max: z.number().finite().positive().max(40) }),
  }).optional(),
}).strict().refine(v => !v.operatingRanges || (v.operatingRanges.ph.min <= v.operatingRanges.ph.max &&
  v.operatingRanges.sanitiser.min <= v.operatingRanges.sanitiser.max), "minimum must not exceed maximum");

router.get("/config", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "No client context" }); return; }
  const raw = req.query.siteId;
  const siteId = raw == null || raw === "" ? null : Number(raw);
  if (siteId !== null && (!Number.isInteger(siteId) || siteId < 1)) { res.status(400).json({ error: "Invalid site" }); return; }
  if (siteId !== null) {
    const access = await checkSiteAccess(siteId, clientId, getActiveDepartmentId(req));
    if (access === "not_found") { res.status(400).json({ error: "Invalid site" }); return; }
    if (access === "forbidden") { res.status(403).json({ error: "Site not accessible" }); return; }
  }
  const profile = siteId == null ? null : await getHotTubProfile(clientId, siteId);
  res.json({ siteId, operatingRanges: (profile as any)?.operatingRanges ?? DEFAULT_OPERATING_RANGES,
    controlProfile: profile, disclaimer: "Defaults are guidance only; the site's written scheme and risk assessment are authoritative." });
});

router.put("/config", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) { res.status(400).json({ error: "No client context" }); return; }
  const siteId = Number(req.query.siteId);
  if (!Number.isInteger(siteId) || siteId < 1) { res.status(400).json({ error: "A valid site is required" }); return; }
  const access = await checkSiteAccess(siteId, clientId, getActiveDepartmentId(req));
  if (access === "not_found") { res.status(400).json({ error: "Invalid site" }); return; }
  if (access === "forbidden") { res.status(403).json({ error: "Site not accessible" }); return; }
  const parsed = hotTubProfileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const after = await db.transaction(async tx => {
    const [previous] = await tx.select({ profile: trackControlProfilesTable.profile })
      .from(trackControlProfilesTable).where(and(eq(trackControlProfilesTable.clientId, clientId),
        eq(trackControlProfilesTable.siteId, siteId), eq(trackControlProfilesTable.module, HOT_TUB_PROFILE_MODULE))).limit(1);
    await tx.insert(trackControlProfilesTable).values({ clientId, siteId, module: HOT_TUB_PROFILE_MODULE, profile: parsed.data })
      .onConflictDoUpdate({ target: [trackControlProfilesTable.clientId, trackControlProfilesTable.siteId, trackControlProfilesTable.module],
        set: { profile: parsed.data, updatedAt: new Date() } });
    await tx.insert(auditEventsTable).values({
      clientId, actorId: req.currentUser?.id ?? null, entityType: "hot_tub_control_profile",
      entityId: siteId, action: "updated", before: previous?.profile ?? null, after: parsed.data,
    });
    return parsed.data;
  });
  res.json({ siteId, operatingRanges: (after as any)?.operatingRanges ?? DEFAULT_OPERATING_RANGES, controlProfile: after,
    disclaimer: "Defaults are guidance only; the site's written scheme and risk assessment are authoritative." });
});

// DELETE /api/hot-tub/:id
router.delete("/:id", requireAuth, denyViewers, async (req, res) => {
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

  const linkedAction = await db.execute(sql`
    SELECT 1 FROM compliance_actions WHERE client_id = ${clientId}
      AND source_track = 'HotTubTrack' AND source_record_id = ${String(id)} LIMIT 1
  `);
  if (linkedAction.rows.length) return res.status(409).json({ error: "Resolve the linked safety action; its source check must be retained for audit" });

  await db
    .delete(hotTubChecksTable)
    .where(and(eq(hotTubChecksTable.id, id), eq(hotTubChecksTable.clientId, clientId)));

  res.status(204).end();
});

export default router;
