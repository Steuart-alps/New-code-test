/**
 * Track owners: who receives each track's in-app reminders (lib/trackOwners.ts).
 *   GET    /api/track-owners       any signed-in user of the business
 *   PUT    /api/track-owners       set/replace { module, siteId?, userId } (admins/consultants)
 *   DELETE /api/track-owners/:id   remove (admins/consultants)
 * The business is always getClientId(req); users and sites are checked
 * against it, never trusted from the body.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { denyViewers, getActiveDepartmentId, getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";
import { getEntitledServices, isEntitled } from "../lib/services";
import { TRACK_MODULES, TRACK_MODULE_KEYS } from "../lib/trackModules";
import { candidateCanSeeSite, loadEligibleOwners } from "../lib/trackOwners";
import { siteVisibleSql } from "../lib/departmentSites";

const router: IRouter = Router();

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

const setOwnerSchema = z.object({
  module: z.string().refine((value) => TRACK_MODULE_KEYS.includes(value), "Unknown track"),
  siteId: z.number().int().positive().nullable().optional(),
  userId: z.number().int().positive(),
});

function isAdmin(role: string | undefined): boolean {
  return role === "client_admin" || role === "consultant";
}

router.get("/track-owners", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const admin = isAdmin(req.currentUser?.role);
  const departmentId = getActiveDepartmentId(req);

  const [services, candidates, siteResult, ownerResult] = await Promise.all([
    getEntitledServices(clientId),
    loadEligibleOwners(clientId),
    db.execute(sql`
      SELECT s.id, s.name FROM sites s
      WHERE s.client_id = ${clientId}
        ${departmentId !== null ? sql`AND ${siteVisibleSql(sql`s.id`, sql`s.department_id`, departmentId)}` : sql``}
      ORDER BY s.name, s.id
    `),
    db.execute(sql`
      SELECT o.id, o.module, o.site_id, o.user_id, u.name AS user_name
      FROM track_owners o
      JOIN users u ON u.id = o.user_id
      WHERE o.client_id = ${clientId}
      ORDER BY o.module, o.site_id NULLS FIRST
    `),
  ]);
  const sites = rowsOf<{ id: number; name: string }>(siteResult)
    .map((site) => ({ id: Number(site.id), name: site.name }));
  const visibleSiteIds = new Set(sites.map((site) => site.id));
  const eligibleIds = new Set(candidates.map((candidate) => candidate.id));
  const owners = rowsOf<{ id: number; module: string; site_id: number | null; user_id: number; user_name: string }>(ownerResult)
    .filter((row) => row.site_id == null || visibleSiteIds.has(Number(row.site_id)))
    .map((row) => ({
      id: Number(row.id),
      module: row.module,
      siteId: row.site_id == null ? null : Number(row.site_id),
      userId: Number(row.user_id),
      userName: row.user_name,
      // A deactivated or removed owner no longer receives reminders; the
      // next level (module-wide owner, then the admins) does.
      eligible: eligibleIds.has(Number(row.user_id)),
    }));

  res.json({
    modules: TRACK_MODULES.map((module) => ({
      key: module.key,
      label: module.label,
      enabled: module.services.some((key) => isEntitled(services, key)),
    })),
    owners,
    sites,
    // Colleague details are only listed for the people who assign owners.
    users: admin
      ? candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, email: candidate.email, role: candidate.role }))
      : [],
    defaultRecipients: admin
      ? candidates
        .filter((candidate) => candidate.role === "client_admin" || candidate.role === "consultant")
        .map((candidate) => ({ id: candidate.id, name: candidate.name }))
      : [],
  });
});

router.put("/track-owners", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const parsed = setOwnerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
  const { module, userId } = parsed.data;
  const siteId = parsed.data.siteId ?? null;

  let siteDepartmentId: number | null = null;
  if (siteId !== null) {
    const [site] = rowsOf<{ department_id: number | null }>(await db.execute(sql`
      SELECT department_id FROM sites WHERE id = ${siteId} AND client_id = ${clientId}
    `));
    if (!site) return res.status(400).json({ error: "That site isn't part of this business" });
    siteDepartmentId = site.department_id == null ? null : Number(site.department_id);
  }
  const candidate = (await loadEligibleOwners(clientId)).find((user) => user.id === userId);
  if (!candidate) {
    return res.status(400).json({ error: "Choose an active admin, staff member or consultant of this business" });
  }
  if (siteId !== null && !candidateCanSeeSite(candidate, siteDepartmentId, siteId)) {
    return res.status(400).json({ error: `${candidate.name} can't access that site's department` });
  }

  const conflictTarget = siteId === null
    ? sql`("client_id", "module") WHERE "site_id" IS NULL`
    : sql`("client_id", "module", "site_id") WHERE "site_id" IS NOT NULL`;
  const [row] = rowsOf<{ id: number; module: string; site_id: number | null; user_id: number }>(await db.execute(sql`
    INSERT INTO track_owners (client_id, module, site_id, user_id)
    VALUES (${clientId}, ${module}, ${siteId}, ${userId})
    ON CONFLICT ${conflictTarget}
    DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()
    RETURNING id, module, site_id, user_id
  `));
  res.json({
    id: Number(row!.id),
    module: row!.module,
    siteId: row!.site_id == null ? null : Number(row!.site_id),
    userId: Number(row!.user_id),
    userName: candidate.name,
    eligible: true,
  });
});

router.delete("/track-owners/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  const id = Number(req.params.id);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid id" });
  const removed = await db.execute(sql`
    DELETE FROM track_owners WHERE id = ${id} AND client_id = ${clientId} RETURNING id
  `);
  if (removed.rows.length === 0) return res.status(404).json({ error: "Track owner not found" });
  res.status(204).end();
});

export default router;
