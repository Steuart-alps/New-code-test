import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

async function fetchWeekly(clientId: number, date: string) {
  const r = await db.execute(sql`
    SELECT * FROM kitchen_weekly_records
    WHERE client_id = ${clientId} AND week_commencing = ${date} LIMIT 1
  `);
  return r.rows[0] as Record<string, any> | undefined;
}

async function fetchWeeklyById(id: number, clientId: number) {
  const r = await db.execute(sql`
    SELECT * FROM kitchen_weekly_records WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  return r.rows[0] as Record<string, any> | undefined;
}

async function fetchProbe(clientId: number, date: string) {
  const r = await db.execute(sql`
    SELECT * FROM kitchen_probe_checks
    WHERE client_id = ${clientId} AND check_date = ${date} LIMIT 1
  `);
  return r.rows[0] as Record<string, any> | undefined;
}

async function fetchProbeById(id: number, clientId: number) {
  const r = await db.execute(sql`
    SELECT * FROM kitchen_probe_checks WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  return r.rows[0] as Record<string, any> | undefined;
}

// ── Weekly Review: list ───────────────────────────────────────────────────────

router.get("/weekly", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const rows = await db.execute(sql`
    SELECT id, week_commencing, submitted_at, manager_signature
    FROM kitchen_weekly_records
    WHERE client_id = ${clientId}
    ORDER BY week_commencing DESC
    LIMIT 52
  `);
  res.json(rows.rows);
});

// ── Weekly Review: by date ────────────────────────────────────────────────────

router.get("/weekly/by-date/:date", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const row = await fetchWeekly(clientId, req.params.date as string);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Weekly Review: create ─────────────────────────────────────────────────────

const weeklyBody = z.object({
  weekCommencing: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checks: z.record(z.string(), z.enum(["yes", "no", "na"])).optional(),
  deviations: z.array(z.object({ rule: z.string().optional(), action: z.string().optional() })).optional(),
  additional: z.record(z.string(), z.any()).optional(),
  managerSignature: z.string().max(300).nullable().optional(),
  submittedAt: z.string().nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.post("/weekly", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = weeklyBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { weekCommencing, checks, deviations, additional, managerSignature, submittedAt, siteId } = parsed.data;

  const existing = await fetchWeekly(clientId, weekCommencing);
  if (existing) return res.status(409).json({ error: "Record already exists for this week", id: existing.id });

  const userId = (req.session as any).userId ?? null;
  const checksJson = JSON.stringify(checks ?? {});
  const deviationsJson = JSON.stringify(deviations ?? []);
  const additionalJson = JSON.stringify(additional ?? {});

  const result = await db.execute(sql`
    INSERT INTO kitchen_weekly_records
      (client_id, site_id, week_commencing, checks, deviations, additional, manager_signature, submitted_at, created_by)
    VALUES (
      ${clientId}, ${siteId ?? null}, ${weekCommencing},
      ${checksJson}::jsonb, ${deviationsJson}::jsonb, ${additionalJson}::jsonb,
      ${managerSignature ?? null},
      ${submittedAt ? new Date(submittedAt) : null},
      ${userId}
    )
    RETURNING *
  `);
  res.status(201).json(result.rows[0]);
});

// ── Weekly Review: update ─────────────────────────────────────────────────────

router.put("/weekly/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await fetchWeeklyById(id, clientId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = weeklyBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const { checks, deviations, additional, managerSignature, submittedAt, siteId } = parsed.data;

  const checksJson = JSON.stringify(checks ?? existing.checks);
  const deviationsJson = JSON.stringify(deviations ?? existing.deviations);
  const additionalJson = JSON.stringify(additional ?? existing.additional);
  const sig = managerSignature !== undefined ? managerSignature : existing.manager_signature;
  const sub = submittedAt !== undefined ? (submittedAt ? new Date(submittedAt) : null) : existing.submitted_at;
  const site = siteId !== undefined ? siteId : existing.site_id;

  const result = await db.execute(sql`
    UPDATE kitchen_weekly_records SET
      checks            = ${checksJson}::jsonb,
      deviations        = ${deviationsJson}::jsonb,
      additional        = ${additionalJson}::jsonb,
      manager_signature = ${sig},
      submitted_at      = ${sub},
      site_id           = ${site},
      updated_at        = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *
  `);
  res.json(result.rows[0]);
});

// ── Probe Checks: list ────────────────────────────────────────────────────────

router.get("/probe", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const rows = await db.execute(sql`
    SELECT id, check_date, overall_result, checked_by, submitted_at
    FROM kitchen_probe_checks
    WHERE client_id = ${clientId}
    ORDER BY check_date DESC
    LIMIT 24
  `);
  res.json(rows.rows);
});

// ── Probe Checks: by date ─────────────────────────────────────────────────────

router.get("/probe/by-date/:date", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const row = await fetchProbe(clientId, req.params.date as string);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Probe Checks: create ──────────────────────────────────────────────────────

const probeRowSchema = z.object({
  name: z.string().optional(),
  serialNo: z.string().optional(),
  iceTemp: z.string().optional(),
  boilingTemp: z.string().optional(),
  accurateIce: z.boolean().optional(),
  accurateBoiling: z.boolean().optional(),
  notes: z.string().optional(),
});

const probeBody = z.object({
  checkDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  probes: z.array(probeRowSchema).optional(),
  overallResult: z.enum(["pass", "fail", ""]).nullable().optional(),
  checkedBy: z.string().max(300).nullable().optional(),
  signature: z.string().max(300).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  submittedAt: z.string().nullable().optional(),
  siteId: z.number().int().nullable().optional(),
});

router.post("/probe", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = probeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { checkDate, probes, overallResult, checkedBy, signature, notes, submittedAt, siteId } = parsed.data;
  const userId = (req.session as any).userId ?? null;
  const probesJson = JSON.stringify(probes ?? []);

  const result = await db.execute(sql`
    INSERT INTO kitchen_probe_checks
      (client_id, site_id, check_date, probes, overall_result, checked_by, signature, notes, submitted_at, created_by)
    VALUES (
      ${clientId}, ${siteId ?? null}, ${checkDate},
      ${probesJson}::jsonb,
      ${overallResult || null}, ${checkedBy ?? null}, ${signature ?? null}, ${notes ?? null},
      ${submittedAt ? new Date(submittedAt) : null},
      ${userId}
    )
    RETURNING *
  `);
  res.status(201).json(result.rows[0]);
});

// ── Probe Checks: update ──────────────────────────────────────────────────────

router.put("/probe/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await fetchProbeById(id, clientId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = probeBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const { probes, overallResult, checkedBy, signature, notes, submittedAt, siteId } = parsed.data;

  const probesJson = JSON.stringify(probes ?? existing.probes);
  const result = existing.overall_result;
  const finalResult = overallResult !== undefined ? (overallResult || null) : result;
  const finalCheckedBy = checkedBy !== undefined ? checkedBy : existing.checked_by;
  const finalSig = signature !== undefined ? signature : existing.signature;
  const finalNotes = notes !== undefined ? notes : existing.notes;
  const finalSub = submittedAt !== undefined ? (submittedAt ? new Date(submittedAt) : null) : existing.submitted_at;
  const finalSite = siteId !== undefined ? siteId : existing.site_id;

  const updated = await db.execute(sql`
    UPDATE kitchen_probe_checks SET
      probes         = ${probesJson}::jsonb,
      overall_result = ${finalResult},
      checked_by     = ${finalCheckedBy},
      signature      = ${finalSig},
      notes          = ${finalNotes},
      submitted_at   = ${finalSub},
      site_id        = ${finalSite},
      updated_at     = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *
  `);
  res.json(updated.rows[0]);
});

export default router;
