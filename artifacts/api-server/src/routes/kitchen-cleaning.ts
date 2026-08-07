/**
 * KitchenTrack — Cleaning Schedule
 * Manages configurable cleaning task templates + dated completion logs.
 */
import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId, denyViewers } from "../middleware/requireAuth";

const router = Router();

// ── Tasks ─────────────────────────────────────────────────────────────────────

router.get("/tasks", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.execute(sql`
    SELECT * FROM kitchen_cleaning_tasks
    WHERE client_id = ${clientId} AND active = true
    ORDER BY frequency, sort_order, id
  `);
  res.json(rows.rows);
});

const taskBody = z.object({
  area:       z.string().max(200),
  task:       z.string().max(500),
  frequency:  z.enum(["daily", "weekly", "monthly"]),
  method:     z.string().max(500).nullable().optional(),
  product:    z.string().max(200).nullable().optional(),
  responsible: z.string().max(200).nullable().optional(),
  sortOrder:  z.number().int().optional(),
  siteId:     z.number().int().nullable().optional(),
});

router.post("/tasks", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = taskBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { area, task, frequency, method, product, responsible, sortOrder, siteId } = parsed.data;

  const result = await db.execute(sql`
    INSERT INTO kitchen_cleaning_tasks
      (client_id, site_id, area, task, frequency, method, product, responsible, sort_order)
    VALUES
      (${clientId}, ${siteId ?? null}, ${area}, ${task}, ${frequency},
       ${method ?? null}, ${product ?? null}, ${responsible ?? null}, ${sortOrder ?? 0})
    RETURNING *
  `);
  res.status(201).json(result.rows[0]);
});

router.put("/tasks/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = taskBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const existing = await db.execute(sql`
    SELECT * FROM kitchen_cleaning_tasks WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  if (!existing.rows[0]) return res.status(404).json({ error: "Not found" });

  const row = existing.rows[0] as any;
  const { area, task, frequency, method, product, responsible, sortOrder, siteId } = parsed.data;

  const result = await db.execute(sql`
    UPDATE kitchen_cleaning_tasks SET
      area        = ${area        !== undefined ? area        : row.area},
      task        = ${task        !== undefined ? task        : row.task},
      frequency   = ${frequency   !== undefined ? frequency   : row.frequency},
      method      = ${method      !== undefined ? method      : row.method},
      product     = ${product     !== undefined ? product     : row.product},
      responsible = ${responsible !== undefined ? responsible : row.responsible},
      sort_order  = ${sortOrder   !== undefined ? sortOrder   : row.sort_order},
      site_id     = ${siteId      !== undefined ? siteId      : row.site_id},
      updated_at  = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *
  `);
  res.json(result.rows[0]);
});

router.delete("/tasks/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  await db.execute(sql`
    UPDATE kitchen_cleaning_tasks SET active = false, updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.json({ ok: true });
});

// ── Logs ──────────────────────────────────────────────────────────────────────

router.get("/logs/history", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const rows = await db.execute(sql`
    SELECT id, log_date, frequency, signed_by, submitted_at,
      (SELECT count(*) FROM jsonb_array_elements(completions) AS c
       WHERE (c->>'done')::boolean = true)::int AS completed_count,
      jsonb_array_length(completions) AS total_count
    FROM kitchen_cleaning_logs
    WHERE client_id = ${clientId}
    ORDER BY log_date DESC, frequency
    LIMIT 60
  `);
  res.json(rows.rows);
});

router.get("/logs", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { date, frequency } = req.query;
  if (!date || !frequency) return res.status(400).json({ error: "date and frequency required" });

  const row = await db.execute(sql`
    SELECT * FROM kitchen_cleaning_logs
    WHERE client_id = ${clientId} AND log_date = ${date as string} AND frequency = ${frequency as string}
    LIMIT 1
  `);
  if (!row.rows[0]) return res.status(404).json({ error: "Not found" });
  res.json(row.rows[0]);
});

const completionItem = z.object({
  taskId:   z.number().int().optional(),
  taskArea: z.string().optional(),
  taskName: z.string(),
  done:     z.boolean(),
  doneBy:   z.string().max(200).optional(),
  notes:    z.string().max(500).optional(),
});

const logBody = z.object({
  logDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  frequency:   z.enum(["daily", "weekly", "monthly"]),
  completions: z.array(completionItem),
  signedBy:    z.string().max(300).nullable().optional(),
  submittedAt: z.string().nullable().optional(),
  siteId:      z.number().int().nullable().optional(),
});

// POST upserts — creates or updates the log for that date+frequency
router.post("/logs", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = logBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { logDate, frequency, completions, signedBy, submittedAt, siteId } = parsed.data;
  const userId = (req.session as any).userId ?? null;
  const completionsJson = JSON.stringify(completions);

  const existing = await db.execute(sql`
    SELECT id FROM kitchen_cleaning_logs
    WHERE client_id = ${clientId} AND log_date = ${logDate} AND frequency = ${frequency}
    LIMIT 1
  `);

  if (existing.rows[0]) {
    const id = (existing.rows[0] as any).id;
    const result = await db.execute(sql`
      UPDATE kitchen_cleaning_logs SET
        completions  = ${completionsJson}::jsonb,
        signed_by    = ${signedBy ?? null},
        submitted_at = ${submittedAt ? new Date(submittedAt) : null},
        site_id      = ${siteId ?? null},
        updated_at   = now()
      WHERE id = ${id} AND client_id = ${clientId}
      RETURNING *
    `);
    return res.json(result.rows[0]);
  }

  const result = await db.execute(sql`
    INSERT INTO kitchen_cleaning_logs
      (client_id, site_id, log_date, frequency, completions, signed_by, submitted_at, created_by)
    VALUES
      (${clientId}, ${siteId ?? null}, ${logDate}, ${frequency},
       ${completionsJson}::jsonb, ${signedBy ?? null},
       ${submittedAt ? new Date(submittedAt) : null}, ${userId})
    RETURNING *
  `);
  res.status(201).json(result.rows[0]);
});

export default router;
