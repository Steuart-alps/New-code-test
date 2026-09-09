import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId, denyViewers } from "../middleware/requireAuth";

const router = Router();

const staffCreate = z.object({
  name: z.string().min(1).max(300),
  externalPayrollId: z.string().trim().min(1).max(200).nullable().optional(),
  jobTitle: z.string().max(300).nullable().optional(),
  department: z.string().max(300).nullable().optional(),
  email: z.string().email().max(300).nullable().optional().or(z.literal("").transform(() => null)),
  siteId: z.number().int().nullable().optional(),
  active: z.boolean().optional(),
});

const staffUpdate = staffCreate.partial();
const rosterRow = staffCreate.extend({
  externalPayrollId: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
});
const reconcileBody = z.object({
  rows: z.array(rosterRow).min(1).max(1000),
  siteId: z.number().int().positive().nullable().optional(),
  preview: z.boolean().default(true),
}).strict();
const normalizeIdentifier = (value: string) => value.trim().toUpperCase();
const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const normalizeEmail = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() || null;

// ── List staff ────────────────────────────────────────────────────────────────

router.get("/staff-roster", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { includeInactive, siteId } = req.query as any;

  const result = await db.execute(sql`
    SELECT sr.id, sr.client_id, sr.site_id, sr.name, sr.external_payroll_id, sr.last_reconciled_at, sr.job_title, sr.department,
           sr.email, sr.active, sr.created_at, sr.updated_at,
           s.name AS site_name
    FROM staff_roster sr
    LEFT JOIN sites s ON sr.site_id = s.id
    WHERE sr.client_id = ${clientId}
      ${includeInactive !== "true" ? sql`AND sr.active = true` : sql``}
    ORDER BY sr.name ASC
  `);

  let rows = (result.rows ?? []) as any[];
  if (siteId) rows = rows.filter((r: any) => r.site_id === Number(siteId));

  res.json(rows);
});

// ── Create staff member ───────────────────────────────────────────────────────

router.post("/staff-roster", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = staffCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { name, externalPayrollId, jobTitle, department, email, siteId, active } = parsed.data;

  const result = await db.execute(sql`
    INSERT INTO staff_roster (client_id, site_id, name, external_payroll_id, job_title, department, email, active)
    VALUES (${clientId}, ${siteId ?? null}, ${name}, ${externalPayrollId ? normalizeIdentifier(externalPayrollId) : null}, ${jobTitle ?? null},
            ${department ?? null}, ${email ?? null}, ${active ?? true})
    RETURNING *
  `);

  res.status(201).json((result.rows ?? [])[0]);
});

router.post("/staff-roster/bulk", requireAuth, denyViewers, (_req, res) => {
  res.status(410).json({ error: "Bulk insertion has been replaced by previewed roster reconciliation" });
});

router.post("/staff-roster/reconcile", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = reconcileBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid roster data", details: parsed.error.flatten() });
  const { preview } = parsed.data;
  const scopeSiteId = parsed.data.siteId ?? null;
  const identifiers = parsed.data.rows.map(row => normalizeIdentifier(row.externalPayrollId));
  const duplicateIdentifiers = [...new Set(identifiers.filter((id, index) => identifiers.indexOf(id) !== index))];
  if (duplicateIdentifiers.length) return res.status(409).json({ error: "Duplicate payroll identifiers in upload", identifiers: duplicateIdentifiers });

  const result = await db.transaction(async tx => {
    if (scopeSiteId != null) {
      const site = await tx.execute(sql`SELECT id FROM sites WHERE id = ${scopeSiteId} AND client_id = ${clientId} LIMIT 1`);
      if (!site.rows?.[0]) return { error: "Selected site does not belong to this client", status: 403 as const };
    }
    const currentResult = await tx.execute(sql`
      SELECT id, site_id, name, external_payroll_id, job_title, department, email, active
      FROM staff_roster
      WHERE client_id = ${clientId}
        ${scopeSiteId == null ? sql`` : sql`AND site_id = ${scopeSiteId}`}
      ORDER BY id
      FOR UPDATE
    `);
    const current = (currentResult.rows ?? []) as any[];
    const claimed = new Set<number>();
    const plans: Array<{ row: typeof parsed.data.rows[number]; id: number | null; kind: "created" | "updated" | "reactivated" | "unchanged"; match: "identifier" | "email" | "name" | "new" }> = [];
    const errors: Array<{ row: number; identifier: string; error: string }> = [];

    for (const [index, input] of parsed.data.rows.entries()) {
      const identifier = normalizeIdentifier(input.externalPayrollId);
      const rowSiteId = scopeSiteId ?? input.siteId ?? null;
      if (scopeSiteId != null && input.siteId != null && input.siteId !== scopeSiteId) {
        errors.push({ row: index + 2, identifier, error: "Row site does not match the selected reconciliation site" });
        continue;
      }
      if (rowSiteId != null) {
        const site = await tx.execute(sql`SELECT id FROM sites WHERE id = ${rowSiteId} AND client_id = ${clientId} LIMIT 1`);
        if (!site.rows?.[0]) {
          errors.push({ row: index + 2, identifier, error: "Site does not belong to this client" });
          continue;
        }
      }
      let matches = current.filter(item => item.external_payroll_id === identifier);
      let match: "identifier" | "email" | "name" | "new" = "identifier";
      if (!matches.length && normalizeEmail(input.email)) {
        matches = current.filter(item => !item.external_payroll_id && normalizeEmail(item.email) === normalizeEmail(input.email) && !claimed.has(Number(item.id)));
        match = "email";
      }
      if (!matches.length) {
        matches = current.filter(item => !item.external_payroll_id && normalizeName(item.name) === normalizeName(input.name) && Number(item.site_id ?? 0) === Number(rowSiteId ?? 0) && !claimed.has(Number(item.id)));
        match = "name";
      }
      if (matches.length > 1) {
        errors.push({ row: index + 2, identifier, error: `Ambiguous ${match} match; update the existing roster before importing` });
        continue;
      }
      const existing = matches[0];
      if (!existing) {
        plans.push({ row: { ...input, siteId: rowSiteId }, id: null, kind: "created", match: "new" });
        continue;
      }
      claimed.add(Number(existing.id));
      const changed = existing.name !== input.name.trim()
        || existing.external_payroll_id !== identifier
        || (existing.job_title ?? null) !== (input.jobTitle ?? null)
        || (existing.department ?? null) !== (input.department ?? null)
        || normalizeEmail(existing.email) !== normalizeEmail(input.email)
        || Number(existing.site_id ?? 0) !== Number(rowSiteId ?? 0);
      plans.push({ row: { ...input, siteId: rowSiteId }, id: Number(existing.id), kind: !existing.active ? "reactivated" : changed ? "updated" : "unchanged", match });
    }
    if (errors.length) return { error: "Roster contains rows that cannot be reconciled safely", status: 409 as const, errors };
    const deactivatedIds = current.filter(item => item.active && !claimed.has(Number(item.id)) && !plans.some(plan => plan.id === Number(item.id))).map(item => Number(item.id));
    const summary = {
      total: plans.length,
      created: plans.filter(plan => plan.kind === "created").length,
      updated: plans.filter(plan => plan.kind === "updated").length,
      reactivated: plans.filter(plan => plan.kind === "reactivated").length,
      unchanged: plans.filter(plan => plan.kind === "unchanged").length,
      deactivated: deactivatedIds.length,
      matchedByEmail: plans.filter(plan => plan.match === "email").length,
      matchedByName: plans.filter(plan => plan.match === "name").length,
    };
    if (preview) return { status: 200 as const, preview: true, summary };
    for (const plan of plans) {
      const identifier = normalizeIdentifier(plan.row.externalPayrollId);
      if (plan.id == null) {
        await tx.execute(sql`INSERT INTO staff_roster (client_id, site_id, name, external_payroll_id, job_title, department, email, active, last_reconciled_at)
          VALUES (${clientId}, ${plan.row.siteId ?? null}, ${plan.row.name.trim()}, ${identifier}, ${plan.row.jobTitle ?? null}, ${plan.row.department ?? null}, ${plan.row.email ?? null}, true, now())`);
      } else {
        await tx.execute(sql`UPDATE staff_roster SET site_id = ${plan.row.siteId ?? null}, name = ${plan.row.name.trim()}, external_payroll_id = ${identifier},
          job_title = ${plan.row.jobTitle ?? null}, department = ${plan.row.department ?? null}, email = ${plan.row.email ?? null},
          active = true, last_reconciled_at = now(), updated_at = now()
          WHERE id = ${plan.id} AND client_id = ${clientId}`);
      }
    }
    if (deactivatedIds.length) await tx.execute(sql`UPDATE staff_roster SET active = false, last_reconciled_at = now(), updated_at = now()
      WHERE client_id = ${clientId} AND id IN (${sql.join(deactivatedIds.map(id => sql`${id}`), sql`, `)})`);
    return { status: 200 as const, preview: false, summary };
  });
  if ("error" in result) return res.status(result.status).json(result);
  res.status(result.status).json(result);
});

// ── Update staff member ───────────────────────────────────────────────────────

router.patch("/staff-roster/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = staffUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { name, externalPayrollId, jobTitle, department, email, siteId, active } = parsed.data;
  const hasJobTitle  = jobTitle  !== undefined;
  const hasDept      = department !== undefined;
  const hasEmail     = email     !== undefined;
  const hasSite      = siteId    !== undefined;
  const hasActive    = active    !== undefined;
  const hasExternalId = externalPayrollId !== undefined;

  await db.execute(sql`
    UPDATE staff_roster
    SET name       = COALESCE(${name ?? null}, name),
        job_title  = CASE WHEN ${hasJobTitle}::boolean  THEN ${jobTitle ?? null}   ELSE job_title  END,
        department = CASE WHEN ${hasDept}::boolean       THEN ${department ?? null} ELSE department END,
        email      = CASE WHEN ${hasEmail}::boolean      THEN ${email ?? null}      ELSE email      END,
        site_id    = CASE WHEN ${hasSite}::boolean       THEN ${siteId ?? null}     ELSE site_id    END,
        active     = CASE WHEN ${hasActive}::boolean     THEN ${active ?? true}     ELSE active     END,
        external_payroll_id = CASE WHEN ${hasExternalId}::boolean THEN ${externalPayrollId ? normalizeIdentifier(externalPayrollId) : null} ELSE external_payroll_id END,
        updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);

  const result = await db.execute(sql`
    SELECT sr.*, s.name AS site_name
    FROM staff_roster sr
    LEFT JOIN sites s ON sr.site_id = s.id
    WHERE sr.id = ${id} AND sr.client_id = ${clientId}
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Remove from current roster without deleting compliance history ───────────

router.delete("/staff-roster/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  await db.execute(sql`
    UPDATE staff_roster
    SET active = false, updated_at = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.status(204).end();
});

export default router;
