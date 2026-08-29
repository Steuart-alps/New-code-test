import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { departmentsTable, sitesTable, usersTable } from "@workspace/db/schema";
import { and, count, eq } from "drizzle-orm";
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

  const rows = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.clientId, clientId));
  res.json(rows);
});

router.post("/departments", requireAuth, requireClientAdmin, async (req, res) => {
  const body = UpsertDepartmentBody.parse(req.body);
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const rows = await db
    .insert(departmentsTable)
    .values({
      name: body.name,
      description: body.description ?? null,
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
  const updates: { name?: string; description?: string | null } = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;

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
