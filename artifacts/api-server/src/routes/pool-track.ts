import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

// ── Check type config ─────────────────────────────────────────────────────────

export const POOL_CHECK_TYPES = ["routine", "opening", "closing", "weekly"] as const;

/** Expected frequency per check type, in hours (for status calculation). */
const FREQUENCY_HOURS: Record<(typeof POOL_CHECK_TYPES)[number], number> = {
  routine: 2,
  opening: 24,
  closing: 24,
  weekly: 168,
};

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createSchema = z.object({
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkTime: z.string().optional(),
  checkType: z.enum(POOL_CHECK_TYPES).default("routine"),
  siteId: z.number().int().positive().optional().nullable(),
  phLevel: z.number().min(0).max(14).optional().nullable(),
  freeChlorine: z.number().min(0).max(20).optional().nullable(),
  combinedChlorine: z.number().min(0).max(20).optional().nullable(),
  waterTempC: z.number().min(0).max(60).optional().nullable(),
  airTempC: z.number().min(-20).max(60).optional().nullable(),
  turbidity: z.enum(["clear", "slightly_hazy", "hazy", "cloudy"]).optional().nullable(),
  poolOpen: z.boolean().default(true),
  performedBy: z.string().max(200).optional(),
  actionsTaken: z.string().max(2000).optional(),
  result: z.enum(["pass", "fail", "action_required"]).default("pass"),
  notes: z.string().max(2000).optional(),
});

const updateSchema = createSchema.partial().omit({ checkType: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPool(id: number, clientId: number) {
  const result = await db.execute(sql`
    SELECT * FROM pool_checks WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  return (result as any)[0] ?? null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /pool-track — list checks
router.get("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { checkType, siteId, limit = "100" } = req.query;

  const rows = await db.execute(sql`
    SELECT pc.*, s.name AS site_name
    FROM pool_checks pc
    LEFT JOIN sites s ON s.id = pc.site_id
    WHERE pc.client_id = ${clientId}
    ${checkType ? sql`AND pc.check_type = ${String(checkType)}` : sql``}
    ${siteId ? sql`AND pc.site_id = ${Number(siteId)}` : sql``}
    ORDER BY pc.check_date DESC, pc.check_time DESC
    LIMIT ${Number(limit)}
  `);

  res.json([...(rows as any)]);
});

// POST /pool-track — create check
router.post("/", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const body = createSchema.parse(req.body);

  const result = await db.execute(sql`
    INSERT INTO pool_checks (
      client_id, site_id, check_date, check_time, check_type,
      ph_level, free_chlorine, combined_chlorine,
      water_temp_c, air_temp_c, turbidity,
      pool_open, performed_by, actions_taken, result, notes
    ) VALUES (
      ${clientId},
      ${body.siteId ?? null},
      ${body.checkDate},
      ${body.checkTime ?? null},
      ${body.checkType},
      ${body.phLevel ?? null},
      ${body.freeChlorine ?? null},
      ${body.combinedChlorine ?? null},
      ${body.waterTempC ?? null},
      ${body.airTempC ?? null},
      ${body.turbidity ?? null},
      ${body.poolOpen},
      ${body.performedBy ?? null},
      ${body.actionsTaken ?? null},
      ${body.result},
      ${body.notes ?? null}
    )
    RETURNING *
  `);

  res.status(201).json((result as any)[0]);
});

// PUT /pool-track/:id — update check
router.put("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await getPool(id, clientId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const body = updateSchema.parse(req.body);

  const result = await db.execute(sql`
    UPDATE pool_checks SET
      site_id        = ${body.siteId !== undefined ? body.siteId : existing.site_id},
      check_date     = ${body.checkDate ?? existing.check_date},
      check_time     = ${body.checkTime !== undefined ? body.checkTime : existing.check_time},
      ph_level       = ${body.phLevel !== undefined ? body.phLevel : existing.ph_level},
      free_chlorine  = ${body.freeChlorine !== undefined ? body.freeChlorine : existing.free_chlorine},
      combined_chlorine = ${body.combinedChlorine !== undefined ? body.combinedChlorine : existing.combined_chlorine},
      water_temp_c   = ${body.waterTempC !== undefined ? body.waterTempC : existing.water_temp_c},
      air_temp_c     = ${body.airTempC !== undefined ? body.airTempC : existing.air_temp_c},
      turbidity      = ${body.turbidity !== undefined ? body.turbidity : existing.turbidity},
      pool_open      = ${body.poolOpen !== undefined ? body.poolOpen : existing.pool_open},
      performed_by   = ${body.performedBy !== undefined ? body.performedBy : existing.performed_by},
      actions_taken  = ${body.actionsTaken !== undefined ? body.actionsTaken : existing.actions_taken},
      result         = ${body.result ?? existing.result},
      notes          = ${body.notes !== undefined ? body.notes : existing.notes},
      updated_at     = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *
  `);

  res.json((result as any)[0]);
});

// DELETE /pool-track/:id
router.delete("/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const result = await db.execute(sql`
    DELETE FROM pool_checks WHERE id = ${id} AND client_id = ${clientId}
    RETURNING id
  `);

  if (!(result as any)[0]) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// GET /pool-track/status — latest per check type + overdue flags
router.get("/status", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { siteId } = req.query;

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (check_type)
      check_type, check_date, check_time, result, pool_open,
      ph_level, free_chlorine, combined_chlorine, water_temp_c, turbidity
    FROM pool_checks
    WHERE client_id = ${clientId}
    ${siteId ? sql`AND site_id = ${Number(siteId)}` : sql``}
    ORDER BY check_type, check_date DESC, check_time DESC NULLS LAST
  `);

  const now = new Date();
  const latestByType = Object.fromEntries(
    ([...(rows as any)] as any[]).map((r: any) => [r.check_type, r])
  );

  const status = POOL_CHECK_TYPES.map(ct => {
    const latest = latestByType[ct];
    const frequencyHours = FREQUENCY_HOURS[ct];

    if (!latest) {
      return { checkType: ct, frequencyHours, status: "never", lastDate: null, lastTime: null, result: null };
    }

    // Parse last check datetime
    const lastDt = latest.check_time
      ? new Date(`${latest.check_date}T${latest.check_time}`)
      : new Date(latest.check_date);
    const hoursSince = (now.getTime() - lastDt.getTime()) / (1000 * 60 * 60);
    const checkStatus = hoursSince > frequencyHours * 1.5 ? "overdue"
      : hoursSince > frequencyHours ? "due_soon"
      : "ok";

    return {
      checkType: ct,
      frequencyHours,
      status: checkStatus,
      lastDate: latest.check_date,
      lastTime: latest.check_time,
      result: latest.result,
      phLevel: latest.ph_level,
      freeChlorine: latest.free_chlorine,
      combinedChlorine: latest.combined_chlorine,
      waterTempC: latest.water_temp_c,
      turbidity: latest.turbidity,
    };
  });

  res.json(status);
});

// GET /pool-track/summary — for dashboard card
router.get("/summary", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const todayResult = await db.execute(sql`
    SELECT COUNT(*) AS total_today,
           SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS pass_today,
           SUM(CASE WHEN result = 'fail' OR result = 'action_required' THEN 1 ELSE 0 END) AS fail_today
    FROM pool_checks
    WHERE client_id = ${clientId}
    AND check_date = CURRENT_DATE
  `);

  const lastResult = await db.execute(sql`
    SELECT check_date, check_time, result, check_type, ph_level, free_chlorine
    FROM pool_checks
    WHERE client_id = ${clientId}
    ORDER BY check_date DESC, check_time DESC NULLS LAST
    LIMIT 1
  `);

  const today = (todayResult as any)[0];
  const last = (lastResult as any)[0];

  res.json({
    totalToday: Number(today?.total_today ?? 0),
    passToday: Number(today?.pass_today ?? 0),
    failToday: Number(today?.fail_today ?? 0),
    lastCheck: last ?? null,
  });
});

export default router;
