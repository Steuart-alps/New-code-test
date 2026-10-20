import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { departmentsTable, sitesTable, usersTable } from "@workspace/db/schema";
import { and, count, eq, getTableColumns, ne } from "drizzle-orm";
import {
  canAccessClient,
  getClientId,
  requireAuth,
  requireClientAdmin,
} from "../middleware/requireAuth";
import { nameIsClean } from "../lib/contentFilter";

const router: IRouter = Router();

const UpsertDepartmentBody = z.object({
  name: z.string().min(1).refine(nameIsClean, { message: "Please use an appropriate name." }),
  description: z.string().nullable().optional(),
  // The site the department sits under; null or left out spans every site.
  siteId: z.number().int().positive().nullable().optional(),
  // Accepted for compatibility with the shared request shape, but the tenant
  // is always taken from the authenticated request.
  clientId: z.number().optional(),
});

router.get("/departments", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const siteId = req.query.siteId === undefined ? undefined : Number(req.query.siteId);
  if (siteId !== undefined && (!Number.isSafeInteger(siteId) || siteId <= 0)) {
    res.status(400).json({ error: "Invalid siteId" });
    return;
  }
  // siteName lets every page label "Housekeeping (Main Hotel)" without loading sites.
  const rows = await db
    .select({ ...getTableColumns(departmentsTable), siteName: sitesTable.name })
    .from(departmentsTable)
    .leftJoin(sitesTable, eq(sitesTable.id, departmentsTable.siteId))
    .where(and(
      eq(departmentsTable.clientId, clientId),
      siteId === undefined ? undefined : eq(departmentsTable.siteId, siteId),
    ))
    .orderBy(departmentsTable.name, sitesTable.name, departmentsTable.id);
  res.json(rows);
});

async function siteInClient(siteId: number, clientId: number): Promise<boolean> {
  const [site] = await db.select({ id: sitesTable.id }).from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)));
  return Boolean(site);
}

router.post("/departments", requireAuth, requireClientAdmin, async (req, res) => {
  const body = UpsertDepartmentBody.parse(req.body);
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  if (body.siteId != null && !(await siteInClient(body.siteId, clientId))) {
    res.status(400).json({ error: "Site does not belong to this client" });
    return;
  }

  const rows = await db
    .insert(departmentsTable)
    .values({
      name: body.name,
      description: body.description ?? null,
      siteId: body.siteId ?? null,
      clientId,
    })
    .returning();
  res.status(201).json(rows[0]);
});

router.put("/departments/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Department not found" });
    return;
  }
  if (!canAccessClient(req, existing.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = UpsertDepartmentBody.partial().parse(req.body);
  const updates: { name?: string; description?: string | null; siteId?: number | null } = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.siteId !== undefined && body.siteId !== existing.siteId) {
    if (body.siteId !== null) {
      if (!(await siteInClient(body.siteId, existing.clientId))) {
        res.status(400).json({ error: "Site does not belong to this client" });
        return;
      }
      // A department under a site sees only that site, so it can't keep other
      // sites that were given to it on the Sites page.
      const [other] = await db.select({ value: count() }).from(sitesTable).where(and(
        eq(sitesTable.clientId, existing.clientId),
        eq(sitesTable.departmentId, id),
        ne(sitesTable.id, body.siteId),
      ));
      const otherSites = Number(other?.value ?? 0);
      if (otherSites > 0) {
        res.status(409).json({
          error: `This department is given ${otherSites} other site${otherSites === 1 ? "" : "s"} on the Sites page. Take ${otherSites === 1 ? "it" : "them"} off the department first.`,
          code: "DEPARTMENT_HAS_OTHER_SITES",
          otherSiteCount: otherSites,
        });
        return;
      }
    }
    updates.siteId = body.siteId;
  }

  const [updated] = await db
    .update(departmentsTable)
    .set(updates)
    .where(eq(departmentsTable.id, id))
    .returning();
  res.json(updated);
});

router.delete("/departments/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Department not found" });
    return;
  }
  if (!canAccessClient(req, existing.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // users and sites use ON DELETE SET NULL. Require an explicit confirmation
  // before that happens, otherwise deleting a department could silently make
  // its staff and sites unscoped.
  const force = req.query.force === "true";
  if (!force) {
    const [[staffCount], [siteCount]] = await Promise.all([
      db
        .select({ value: count() })
        .from(usersTable)
        .where(and(eq(usersTable.clientId, existing.clientId), eq(usersTable.departmentId, id))),
      db
        .select({ value: count() })
        .from(sitesTable)
        .where(and(eq(sitesTable.clientId, existing.clientId), eq(sitesTable.departmentId, id))),
    ]);

    const staff = Number(staffCount?.value ?? 0);
    const sites = Number(siteCount?.value ?? 0);
    if (staff > 0 || sites > 0) {
      res.status(409).json({
        error: "Department has assignments",
        requiresConfirmation: true,
        staffCount: staff,
        siteCount: sites,
        message: `This department has ${staff} staff and ${sites} sites. They will be unassigned if you continue.`,
      });
      return;
    }
  }

  await db.delete(departmentsTable).where(eq(departmentsTable.id, id));
  res.json({ ok: true });
});

export default router;
