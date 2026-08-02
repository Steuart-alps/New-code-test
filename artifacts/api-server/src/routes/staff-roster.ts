import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";

const router = Router();

const staffCreate = z.object({
  name: z.string().min(1).max(300),
  jobTitle: z.string().max(300).nullable().optional(),
  department: z.string().max(300).nullable().optional(),
  email: z.string().email().max(300).nullable().optional().or(z.literal("").transform(() => null)),
  siteId: z.number().int().nullable().optional(),
  active: z.boolean().optional(),
});

const staffUpdate = staffCreate.partial();

// ── List staff ────────────────────────────────────────────────────────────────

router.get("/staff-roster", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { includeInactive, siteId } = req.query as any;

  const result = await db.execute(sql`
    SELECT sr.id, sr.client_id, sr.site_id, sr.name, sr.job_title, sr.department,
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

router.post("/staff-roster", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = staffCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { name, jobTitle, department, email, siteId, active } = parsed.data;

  const result = await db.execute(sql`
    INSERT INTO staff_roster (client_id, site_id, name, job_title, department, email, active)
    VALUES (${clientId}, ${siteId ?? null}, ${name}, ${jobTitle ?? null},
            ${department ?? null}, ${email ?? null}, ${active ?? true})
    RETURNING *
  `);

  res.status(201).json((result.rows ?? [])[0]);
});

// ── Bulk import (CSV-style array) ─────────────────────────────────────────────

router.post("/staff-roster/bulk", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = z.array(staffCreate).min(1).max(500).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const inserted: any[] = [];
  for (const s of parsed.data) {
    const r = await db.execute(sql`
      INSERT INTO staff_roster (client_id, site_id, name, job_title, department, email, active)
      VALUES (${clientId}, ${s.siteId ?? null}, ${s.name}, ${s.jobTitle ?? null},
              ${s.department ?? null}, ${s.email ?? null}, ${s.active ?? true})
      RETURNING *
    `);
    if (r.rows?.[0]) inserted.push(r.rows[0]);
  }

  res.status(201).json(inserted);
});

// ── Update staff member ───────────────────────────────────────────────────────

router.patch("/staff-roster/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = staffUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { name, jobTitle, department, email, siteId, active } = parsed.data;
  const hasJobTitle  = jobTitle  !== undefined;
  const hasDept      = department !== undefined;
  const hasEmail     = email     !== undefined;
  const hasSite      = siteId    !== undefined;
  const hasActive    = active    !== undefined;

  await db.execute(sql`
    UPDATE staff_roster
    SET name       = COALESCE(${name ?? null}, name),
        job_title  = CASE WHEN ${hasJobTitle}::boolean  THEN ${jobTitle ?? null}   ELSE job_title  END,
        department = CASE WHEN ${hasDept}::boolean       THEN ${department ?? null} ELSE department END,
        email      = CASE WHEN ${hasEmail}::boolean      THEN ${email ?? null}      ELSE email      END,
        site_id    = CASE WHEN ${hasSite}::boolean       THEN ${siteId ?? null}     ELSE site_id    END,
        active     = CASE WHEN ${hasActive}::boolean     THEN ${active ?? true}     ELSE active     END,
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

// ── Delete staff member ───────────────────────────────────────────────────────

router.delete("/staff-roster/:id", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  await db.execute(sql`
    DELETE FROM staff_roster
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.status(204).end();
});

export default router;
