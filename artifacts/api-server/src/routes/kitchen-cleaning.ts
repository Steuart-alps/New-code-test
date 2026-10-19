/**
 * KitchenTrack — Cleaning Schedule
 * Manages configurable cleaning task templates + dated completion logs.
 */
import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId, denyViewers, requireClientAdmin, getActiveDepartmentId } from "../middleware/requireAuth";
import { createCleaningSchedulePdf, type CleaningScheduleCompletion } from "../lib/cleaningSchedulePdf";
import {
  clientEntryFrom,
  clientEntryIdSchema,
  isUniqueViolation,
  respondToStoredEntry,
  type ClientEntry,
} from "../lib/clientEntryReplay";

const router = Router();

/** siteId value for logs not tied to a kitchen (GET /logs/history). */
const ACCOUNT_LEVEL = "account";

type SiteResolution =
  | { ok: true; siteId: number | null }
  | { ok: false };

async function resolveAccessibleSite(
  req: any,
  res: any,
  clientId: number,
  rawSiteId: unknown,
): Promise<SiteResolution> {
  if (rawSiteId === undefined || rawSiteId === null || rawSiteId === "") {
    return { ok: true, siteId: null };
  }

  const siteId = Number(Array.isArray(rawSiteId) ? rawSiteId[0] : rawSiteId);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(400).json({ error: "Invalid site id" });
    return { ok: false };
  }

  const departmentId = getActiveDepartmentId(req);
  const result = await db.execute(sql`
    SELECT id
    FROM sites
    WHERE id = ${siteId}
      AND client_id = ${clientId}
      AND (
        ${departmentId}::integer IS NULL
        OR department_id IS NULL
        OR department_id = ${departmentId}
      )
    LIMIT 1
  `);
  if (!result.rows[0]) {
    res.status(403).json({ error: "You do not have access to this site" });
    return { ok: false };
  }
  return { ok: true, siteId };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

const exportQuery = z.object({
  from: isoDate,
  to: isoDate,
  frequency: z.enum(["daily", "weekly", "monthly"]),
});

router.get("/export", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = exportQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Valid from, to and frequency query parameters are required" });
  const { from, to, frequency } = parsed.data;
  if (from > to) return res.status(400).json({ error: "The start date must be on or before the end date" });

  const scope = await resolveAccessibleSite(req, res, clientId, req.query.siteId);
  if (!scope.ok) return;
  // A single-site export only includes logs stamped with that site; logs
  // without a site appear in the all-sites export.
  const siteFilter = scope.siteId === null
    ? sql``
    : sql`AND l.site_id = ${scope.siteId}`;

  const [logsResult, clientResult, siteResult] = await Promise.all([
    db.execute(sql`
      SELECT l.log_date, l.frequency, l.completions, l.signed_by, l.submitted_at, s.name AS site_name
      FROM kitchen_cleaning_logs l
      LEFT JOIN sites s ON s.id = l.site_id AND s.client_id = l.client_id
      WHERE l.client_id = ${clientId}
        AND l.log_date >= ${from}
        AND l.log_date <= ${to}
        AND l.frequency = ${frequency}
        ${siteFilter}
      ORDER BY l.log_date ASC, s.name ASC NULLS LAST
    `),
    db.execute(sql`SELECT name FROM clients WHERE id = ${clientId} LIMIT 1`),
    scope.siteId === null
      ? Promise.resolve(null)
      : db.execute(sql`SELECT name FROM sites WHERE id = ${scope.siteId} AND client_id = ${clientId} LIMIT 1`),
  ]);

  const logs = logsResult.rows.map((row: any) => ({
    date: String(row.log_date),
    frequency: String(row.frequency),
    siteName: row.site_name ? String(row.site_name) : null,
    completions: (Array.isArray(row.completions) ? row.completions : []) as CleaningScheduleCompletion[],
    signedBy: row.signed_by ? String(row.signed_by) : "",
    submittedAt: row.submitted_at ? new Date(row.submitted_at) : null,
  }));
  const businessName = String((clientResult.rows[0] as any)?.name ?? "");
  const siteName = siteResult ? String((siteResult.rows[0] as any)?.name ?? "") : null;
  const pdf = await createCleaningSchedulePdf({
    businessName,
    siteName,
    dateFrom: from,
    dateTo: to,
    frequency: frequency.charAt(0).toUpperCase() + frequency.slice(1),
    generatedAt: new Date().toLocaleDateString("en-GB"),
    logs,
  });
  const siteSuffix = scope.siteId === null ? "" : `-site-${scope.siteId}`;
  const filename = `cleaning-schedule-${frequency}-${from}-to-${to}${siteSuffix}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", pdf.length);
  return res.send(pdf);
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

router.get("/tasks", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const scope = await resolveAccessibleSite(req, res, clientId, req.query.siteId);
  if (!scope.ok) return;
  const siteFilter = scope.siteId === null
    ? sql``
    : sql`AND (site_id = ${scope.siteId} OR site_id IS NULL)`;
  const rows = await db.execute(sql`
    SELECT * FROM kitchen_cleaning_tasks
    WHERE client_id = ${clientId} AND active = true
      ${siteFilter}
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
  const scope = await resolveAccessibleSite(req, res, clientId, siteId);
  if (!scope.ok) return;

  const result = await db.execute(sql`
    INSERT INTO kitchen_cleaning_tasks
      (client_id, site_id, area, task, frequency, method, product, responsible, sort_order)
    VALUES
      (${clientId}, ${scope.siteId}, ${area}, ${task}, ${frequency},
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
  if (siteId !== undefined) {
    const scope = await resolveAccessibleSite(req, res, clientId, siteId);
    if (!scope.ok) return;
  }

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

  // Logs without a site are account-level: most were recorded before kitchens
  // were added. A kitchen's history lists only that kitchen's logs, so an
  // account-level log is never shown as a kitchen's evidence; siteId=account
  // lists the account-level logs on their own, and no siteId lists every log
  // with its kitchen (or account_level) marked.
  let siteFilter = sql``;
  if (req.query.siteId === ACCOUNT_LEVEL) {
    siteFilter = sql`AND l.site_id IS NULL`;
  } else {
    const scope = await resolveAccessibleSite(req, res, clientId, req.query.siteId);
    if (!scope.ok) return;
    if (scope.siteId !== null) siteFilter = sql`AND l.site_id = ${scope.siteId}`;
  }
  const rows = await db.execute(sql`
    SELECT l.id, l.site_id, s.name AS site_name, (l.site_id IS NULL) AS account_level,
      l.log_date, l.frequency, l.signed_by, l.submitted_at,
      (SELECT count(*) FROM jsonb_array_elements(l.completions) AS c
       WHERE (c->>'done')::boolean = true)::int AS completed_count,
      jsonb_array_length(l.completions) AS total_count
    FROM kitchen_cleaning_logs l
    LEFT JOIN sites s ON s.id = l.site_id AND s.client_id = l.client_id
    WHERE l.client_id = ${clientId}
      ${siteFilter}
    ORDER BY l.log_date DESC, l.frequency, l.id
    LIMIT 60
  `);
  res.json(rows.rows);
});

router.get("/logs", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { date, frequency } = req.query;
  if (!date || !frequency) return res.status(400).json({ error: "date and frequency required" });

  const scope = await resolveAccessibleSite(req, res, clientId, req.query.siteId);
  if (!scope.ok) return;
  // Match POST /logs: no siteId means the client-wide (site_id IS NULL) log.
  const siteFilter = scope.siteId === null
    ? sql`AND site_id IS NULL`
    : sql`AND site_id = ${scope.siteId}`;
  const row = await db.execute(sql`
    SELECT * FROM kitchen_cleaning_logs
    WHERE client_id = ${clientId} AND log_date = ${date as string} AND frequency = ${frequency as string}
      ${siteFilter}
    ORDER BY id
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
  // Stable device entry ID from the mobile outbox (not a credential).
  clientEntryId: clientEntryIdSchema.optional(),
});

/**
 * Device entries applied to cleaning logs. A log is one row per kitchen,
 * period and frequency that every save updates, so the entry IDs are kept as
 * receipts in their own table (unique per client) rather than on the log row,
 * where a later save would overwrite them.
 */
async function findCleaningReceipt(executor: Pick<typeof db, "execute">, clientId: number, entry: ClientEntry) {
  const result = await executor.execute(sql`
    SELECT r.created_by AS receipt_created_by, r.client_entry_hash AS receipt_hash, l.*
    FROM kitchen_cleaning_log_entries r
    LEFT JOIN kitchen_cleaning_logs l ON l.id = r.log_id AND l.client_id = r.client_id
    WHERE r.client_id = ${clientId} AND r.client_entry_id = ${entry.id}
    LIMIT 1
  `);
  return result.rows[0] as Record<string, any> | undefined;
}

function respondToCleaningReceipt(res: any, receipt: Record<string, any>, userId: number, entry: ClientEntry) {
  const { receipt_created_by: createdBy, receipt_hash: hash, ...log } = receipt;
  return respondToStoredEntry(res, {
    createdBy: createdBy == null ? null : Number(createdBy),
    clientEntryHash: hash ?? null,
  }, userId, entry, () => log);
}

type LogSaveResult =
  | { kind: "saved"; status: 200 | 201; row: unknown }
  | { kind: "receipt"; receipt: Record<string, any> }
  | { kind: "signed-off" };

// POST upserts — creates or updates the log for that date+frequency
router.post("/logs", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = logBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { logDate, frequency, completions, signedBy, submittedAt, siteId } = parsed.data;
  const scope = await resolveAccessibleSite(req, res, clientId, siteId);
  if (!scope.ok) return;
  const siteMatch = scope.siteId === null
    ? sql`site_id IS NULL`
    : sql`site_id = ${scope.siteId}`;
  const userId = req.currentUser!.id;
  const completionsJson = JSON.stringify(completions);
  // Mobile outbox submissions carry an entry ID; web saves do not.
  const entry = clientEntryFrom(parsed.data);

  let outcome: LogSaveResult;
  try {
    outcome = await db.transaction(async (tx) => {
      // Lock the log so concurrent saves for this schedule apply one at a time.
      const existing = await tx.execute(sql`
        SELECT id, submitted_at FROM kitchen_cleaning_logs
        WHERE client_id = ${clientId} AND log_date = ${logDate} AND frequency = ${frequency}
          AND ${siteMatch}
        LIMIT 1
        FOR UPDATE
      `);
      const current = existing.rows[0] as { id: number; submitted_at: unknown } | undefined;

      if (entry) {
        // A resend of an entry that was already applied (e.g. its response was
        // lost) changes nothing; looked up after the lock so a concurrent
        // attempt of the same entry sees the first one's receipt.
        const receipt = await findCleaningReceipt(tx, clientId, entry);
        if (receipt) return { kind: "receipt" as const, receipt };
        // A device save made before the schedule was signed off (elsewhere, or
        // from another phone) must not reopen or rewrite the signed record.
        if (current?.submitted_at) return { kind: "signed-off" as const };
      }

      let row: any;
      let status: 200 | 201;
      if (current) {
        const result = await tx.execute(sql`
          UPDATE kitchen_cleaning_logs SET
            completions  = ${completionsJson}::jsonb,
            signed_by    = ${signedBy ?? null},
            submitted_at = ${submittedAt ? new Date(submittedAt) : null},
            site_id      = ${scope.siteId},
            updated_at   = now()
          WHERE id = ${current.id} AND client_id = ${clientId}
          RETURNING *
        `);
        row = result.rows[0];
        status = 200;
      } else {
        const result = await tx.execute(sql`
          INSERT INTO kitchen_cleaning_logs
            (client_id, site_id, log_date, frequency, completions, signed_by, submitted_at, created_by)
          VALUES
             (${clientId}, ${scope.siteId}, ${logDate}, ${frequency},
             ${completionsJson}::jsonb, ${signedBy ?? null},
             ${submittedAt ? new Date(submittedAt) : null}, ${userId})
          RETURNING *
        `);
        row = result.rows[0];
        status = 201;
      }
      if (entry) {
        await tx.execute(sql`
          INSERT INTO kitchen_cleaning_log_entries (client_id, log_id, client_entry_id, client_entry_hash, created_by)
          VALUES (${clientId}, ${row.id}, ${entry.id}, ${entry.hash}, ${userId})
        `);
      }
      return { kind: "saved" as const, status, row };
    });
  } catch (error) {
    // A concurrent attempt of the same entry (or another save creating this
    // log) won the race: answer from what it stored.
    if (!isUniqueViolation(error)) throw error;
    const receipt = entry ? await findCleaningReceipt(db, clientId, entry) : undefined;
    if (receipt) return respondToCleaningReceipt(res, receipt, userId, entry!);
    return res.status(409).json({ error: "This cleaning schedule was saved at the same time from elsewhere. Reload it and try again." });
  }

  if (outcome.kind === "receipt") return respondToCleaningReceipt(res, outcome.receipt, userId, entry!);
  if (outcome.kind === "signed-off") {
    return res.status(409).json({
      error: "This cleaning schedule was already signed off, so the changes saved on this device were not applied.",
      code: "CLEANING_LOG_SIGNED_OFF",
    });
  }
  return res.status(outcome.status).json(outcome.row);
});

export default router;
