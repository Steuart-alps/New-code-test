import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sitesTable } from "@workspace/db/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { requireAuth, getActiveDepartmentId, getClientId, denyViewers } from "../middleware/requireAuth";
import { resolveStaffPerformer as resolveStaffRoster, resolveStaffPerformerUpdate } from "../lib/staffPerformer";
import {
  clientEntryFrom, clientEntryIdSchema, findRawStoredEntry, isUniqueViolation, respondToRawStoredEntry,
} from "../lib/clientEntryReplay";

const router = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

function computedWeeklyResult(checks: Record<string, "yes" | "no" | "na">): "pass" | "fail" {
  return Object.values(checks).some((value) => value === "no") ? "fail" : "pass";
}

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  "Invalid calendar date",
);

function parseSiteId(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  const siteId = Number(raw);
  return Number.isInteger(siteId) && siteId > 0 ? siteId : undefined;
}

async function resolveSiteId(req: any, res: any, clientId: number, raw: unknown): Promise<number | null | undefined> {
  const siteId = parseSiteId(raw);
  if (siteId === undefined) {
    res.status(400).json({ error: "Invalid siteId" });
    return undefined;
  }
  if (siteId === null) return null;
  const departmentId = getActiveDepartmentId(req);
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable).where(and(
    eq(sitesTable.id, siteId),
    eq(sitesTable.clientId, clientId),
    ...(departmentId != null ? [or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId))] : []),
  )).limit(1);
  if (!site) {
    res.status(403).json({ error: "Site not accessible" });
    return undefined;
  }
  return siteId;
}

const scopeSql = (siteId: number | null) =>
  siteId === null ? sql`site_id IS NULL` : sql`site_id = ${siteId}`;

async function fetchWeekly(clientId: number, date: string, siteId: number | null) {
  const r = await db.execute(sql`
    SELECT * FROM kitchen_weekly_records
    WHERE client_id = ${clientId} AND week_commencing = ${date} AND ${scopeSql(siteId)} LIMIT 1
  `);
  return r.rows[0] as Record<string, any> | undefined;
}

async function fetchWeeklyById(id: number, clientId: number) {
  const r = await db.execute(sql`
    SELECT * FROM kitchen_weekly_records WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  return r.rows[0] as Record<string, any> | undefined;
}

async function fetchProbe(clientId: number, date: string, siteId: number | null) {
  const r = await db.execute(sql`
    SELECT * FROM kitchen_probe_checks
    WHERE client_id = ${clientId} AND check_date = ${date} AND ${scopeSql(siteId)} LIMIT 1
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
  const siteId = await resolveSiteId(req, res, clientId, req.query.siteId);
  if (siteId === undefined) return;
  const rows = await db.execute(sql`
    SELECT id, site_id, week_commencing, submitted_at, manager_signature
    FROM kitchen_weekly_records
    WHERE client_id = ${clientId} AND ${scopeSql(siteId)}
    ORDER BY week_commencing DESC
    LIMIT 52
  `);
  res.json(rows.rows);
});

// ── Weekly Review: by date ────────────────────────────────────────────────────

router.get("/weekly/by-date/:date", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const date = calendarDate.safeParse(req.params.date);
  if (!date.success) return res.status(400).json({ error: "Invalid date" });
  const siteId = await resolveSiteId(req, res, clientId, req.query.siteId);
  if (siteId === undefined) return;
  const row = await fetchWeekly(clientId, date.data, siteId);
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Weekly Review: create ─────────────────────────────────────────────────────

const weeklyBody = z.object({
  weekCommencing: calendarDate,
  checks: z.record(z.string(), z.enum(["yes", "no", "na"])).optional(),
  deviations: z.array(z.object({ rule: z.string().optional(), action: z.string().optional() })).optional(),
  additional: z.record(z.string(), z.any()).optional(),
  managerSignature: z.string().max(300).nullable().optional(),
  submittedAt: z.string().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
});
// Creation only: the phone's device entry ID (lib/clientEntryReplay.ts), so a
// resend after a lost response returns the stored review instead of a 409.
const weeklyCreateBody = weeklyBody.extend({ clientEntryId: clientEntryIdSchema.optional() });

router.post("/weekly", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = weeklyCreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { weekCommencing, checks, deviations, additional, managerSignature, submittedAt, siteId } = parsed.data;
  const resolvedSiteId = await resolveSiteId(req, res, clientId, siteId);
  if (resolvedSiteId === undefined) return;

  // Web session or phone bearer token: both set currentUser (the session
  // userId alone left phone records without a creator).
  const userId = req.currentUser!.id;
  const entry = clientEntryFrom(parsed.data);
  // Before the one-review-per-week rule: the stored review is this entry's own.
  const prior = await findRawStoredEntry("kitchen_weekly_records", clientId, entry);
  if (entry && prior) return respondToRawStoredEntry(res, prior, userId, entry);

  const existing = await fetchWeekly(clientId, weekCommencing, resolvedSiteId);
  if (existing) return res.status(409).json({ error: "Record already exists for this week", id: existing.id });

  const checksJson = JSON.stringify(checks ?? {});
  const deviationsJson = JSON.stringify(deviations ?? []);
  const additionalJson = JSON.stringify(additional ?? {});
  const overallResult = submittedAt ? computedWeeklyResult(checks ?? {}) : null;

  try {
    const result = await db.execute(sql`
      INSERT INTO kitchen_weekly_records
        (client_id, site_id, week_commencing, checks, deviations, additional, overall_result, manager_signature, submitted_at, created_by,
         client_entry_id, client_entry_hash)
      VALUES (
        ${clientId}, ${resolvedSiteId}, ${weekCommencing},
         ${checksJson}::jsonb, ${deviationsJson}::jsonb, ${additionalJson}::jsonb, ${overallResult},
        ${managerSignature ?? null},
        ${submittedAt ? new Date(submittedAt) : null},
        ${userId}, ${entry?.id ?? null}, ${entry?.hash ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent resend of the same device entry won the insert.
      const raced = await findRawStoredEntry("kitchen_weekly_records", clientId, entry);
      if (entry && raced) return respondToRawStoredEntry(res, raced, userId, entry);
      const duplicate = await fetchWeekly(clientId, weekCommencing, resolvedSiteId);
      return res.status(409).json({ error: "Record already exists for this week", id: duplicate?.id });
    }
    throw error;
  }
});

// ── Weekly Review: update ─────────────────────────────────────────────────────

router.put("/weekly/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await fetchWeeklyById(id, clientId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = weeklyBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const { checks, deviations, additional, managerSignature, submittedAt, siteId } = parsed.data;
  const requestedSiteId = siteId !== undefined ? siteId : existing.site_id;
  const resolvedSiteId = await resolveSiteId(req, res, clientId, requestedSiteId);
  if (resolvedSiteId === undefined) return;
  if (existing.site_id !== null && await resolveSiteId(req, res, clientId, existing.site_id) === undefined) return;

  const checksJson = JSON.stringify(checks ?? existing.checks);
  const deviationsJson = JSON.stringify(deviations ?? existing.deviations);
  const additionalJson = JSON.stringify(additional ?? existing.additional);
  const sig = managerSignature !== undefined ? managerSignature : existing.manager_signature;
  const sub = submittedAt !== undefined ? (submittedAt ? new Date(submittedAt) : null) : existing.submitted_at;
  // Do not infer a result for old submissions during an unrelated edit.
  const overallResult = (checks !== undefined || submittedAt !== undefined)
    ? (sub ? computedWeeklyResult(checks ?? existing.checks) : null)
    : existing.overall_result;

  const result = await db.execute(sql`
    UPDATE kitchen_weekly_records SET
      checks            = ${checksJson}::jsonb,
      deviations        = ${deviationsJson}::jsonb,
      additional        = ${additionalJson}::jsonb,
       overall_result    = ${overallResult},
      manager_signature = ${sig},
      submitted_at      = ${sub},
       site_id           = ${resolvedSiteId},
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
  const siteId = await resolveSiteId(req, res, clientId, req.query.siteId);
  if (siteId === undefined) return;
  const rows = await db.execute(sql`
    SELECT id, site_id, check_date, overall_result, checked_by, submitted_at
    FROM kitchen_probe_checks
    WHERE client_id = ${clientId} AND ${scopeSql(siteId)}
    ORDER BY check_date DESC
    LIMIT 24
  `);
  res.json(rows.rows);
});

// ── Probe Checks: by date ─────────────────────────────────────────────────────

router.get("/probe/by-date/:date", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const date = calendarDate.safeParse(req.params.date);
  if (!date.success) return res.status(400).json({ error: "Invalid date" });
  const siteId = await resolveSiteId(req, res, clientId, req.query.siteId);
  if (siteId === undefined) return;
  const row = await fetchProbe(clientId, date.data, siteId);
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
  checkDate: calendarDate,
  probes: z.array(probeRowSchema).optional(),
  overallResult: z.enum(["pass", "fail", ""]).nullable().optional(),
  checkedBy: z.string().max(300).nullable().optional(),
  checkedByRosterId: z.number().int().positive().nullable().optional(),
  signature: z.string().max(300).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  submittedAt: z.string().nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
});
// Creation only: the phone's device entry ID (see weeklyCreateBody).
const probeCreateBody = probeBody.extend({ clientEntryId: clientEntryIdSchema.optional() });

router.post("/probe", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = probeCreateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { checkDate, probes, overallResult, checkedBy, checkedByRosterId, signature, notes, submittedAt, siteId } = parsed.data;
  const resolvedSiteId = await resolveSiteId(req, res, clientId, siteId);
  if (resolvedSiteId === undefined) return;
  const userId = req.currentUser!.id;
  const entry = clientEntryFrom(parsed.data);
  // Before the roster and one-check-per-date rules: a check applied before
  // its signer left the roster is still recognised as recorded.
  const prior = await findRawStoredEntry("kitchen_probe_checks", clientId, entry);
  if (entry && prior) return respondToRawStoredEntry(res, prior, userId, entry);
  const performer = await resolveStaffRoster(clientId, checkedByRosterId, checkedBy);
  if (checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
  const existing = await fetchProbe(clientId, checkDate, resolvedSiteId);
  if (existing) return res.status(409).json({ error: "Record already exists for this date", id: existing.id });
  const probesJson = JSON.stringify(probes ?? []);

  try {
    const result = await db.execute(sql`
      INSERT INTO kitchen_probe_checks
        (client_id, site_id, check_date, probes, overall_result, checked_by, checked_by_roster_id, signature, notes, submitted_at, created_by,
         client_entry_id, client_entry_hash)
      VALUES (
        ${clientId}, ${resolvedSiteId}, ${checkDate},
        ${probesJson}::jsonb,
        ${overallResult || null}, ${performer?.performedBy ?? null}, ${performer?.staffRosterId ?? null}, ${signature ?? null}, ${notes ?? null},
        ${submittedAt ? new Date(submittedAt) : null},
        ${userId}, ${entry?.id ?? null}, ${entry?.hash ?? null}
      )
      RETURNING *
    `);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent resend of the same device entry won the insert.
      const raced = await findRawStoredEntry("kitchen_probe_checks", clientId, entry);
      if (entry && raced) return respondToRawStoredEntry(res, raced, userId, entry);
      const duplicate = await fetchProbe(clientId, checkDate, resolvedSiteId);
      return res.status(409).json({ error: "Record already exists for this date", id: duplicate?.id });
    }
    throw error;
  }
});

// ── Probe Checks: update ──────────────────────────────────────────────────────

router.put("/probe/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const existing = await fetchProbeById(id, clientId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  const parsed = probeBody.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data" });

  const { probes, overallResult, checkedBy, checkedByRosterId, signature, notes, submittedAt, siteId } = parsed.data;
  const requestedSiteId = siteId !== undefined ? siteId : existing.site_id;
  const resolvedSiteId = await resolveSiteId(req, res, clientId, requestedSiteId);
  if (resolvedSiteId === undefined) return;
  const performer = await resolveStaffPerformerUpdate(clientId, checkedByRosterId, checkedBy, existing.checked_by_roster_id, existing.checked_by);
  if (checkedByRosterId != null && !performer) return res.status(400).json({ error: "Invalid staff roster member" });
  if (existing.site_id !== null && await resolveSiteId(req, res, clientId, existing.site_id) === undefined) return;

  const probesJson = JSON.stringify(probes ?? existing.probes);
  const result = existing.overall_result;
  const finalResult = overallResult !== undefined ? (overallResult || null) : result;
  const finalCheckedBy = checkedBy !== undefined ? checkedBy : existing.checked_by;
  const finalSig = signature !== undefined ? signature : existing.signature;
  const finalNotes = notes !== undefined ? notes : existing.notes;
  const finalSub = submittedAt !== undefined ? (submittedAt ? new Date(submittedAt) : null) : existing.submitted_at;

  const updated = await db.execute(sql`
    UPDATE kitchen_probe_checks SET
      probes         = ${probesJson}::jsonb,
      overall_result = ${finalResult},
      checked_by     = ${performer?.performedBy},
      checked_by_roster_id = ${performer?.staffRosterId},
      signature      = ${finalSig},
      notes          = ${finalNotes},
      submitted_at   = ${finalSub},
      site_id        = ${resolvedSiteId},
      updated_at     = now()
    WHERE id = ${id} AND client_id = ${clientId}
    RETURNING *
  `);
  res.json(updated.rows[0]);
});

export default router;
