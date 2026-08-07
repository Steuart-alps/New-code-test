import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { departmentsTable, usersTable, sitesTable } from "@workspace/db/schema";
import { eq, count } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, canAccessClient } from "../middleware/requireAuth";
import { nameIsClean } from "../lib/contentFilter";

const router = Router();

const UpsertDepartmentBody = z.object({
  name: z.string().min(1).refine(nameIsClean, { message: "Please use an appropriate name." }),
  description: z.string().nullable().optional(),
  clientId: z.number().optional(),
});

router.get("/departments", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  const clientId = getClientId(req);

  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  if (!canAccessClient(req, clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await db
    .select()
    .from(departmentsTable)
    .where(eq(departmentsTable.clientId, clientId));
  res.json(rows);
});

router.post("/departments", requireAuth, requireClientAdmin, async (req, res) => {
  const actor = req.currentUser!;
  const body = UpsertDepartmentBody.parse(req.body);

  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const rows = await db
    .insert(departmentsTable)
    .values({ name: body.name, description: body.description ?? null, clientId })
    .returning();
  res.status(201).json(rows[0]);
});

router.put("/departments/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const actor = req.currentUser!;
  const id = Number(req.params.id);

  const existing = await db.select().from(departmentsTable).where(eq(departmentsTable.id, id));
  if (!existing[0]) {
    res.status(404).json({ error: "Department not found" });
    return;
  }

  if (!canAccessClient(req, existing[0].clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = UpsertDepartmentBody.partial().parse(req.body);
  const rows = await db
    .update(departmentsTable)
    .set(body)
    .where(eq(departmentsTable.id, id))
    .returning();
  res.json(rows[0]);
});

router.delete("/departments/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const actor = req.currentUser!;
  const id = Number(req.params.id);

  const existing = await db.select().from(departmentsTable).where(eq(departmentsTable.id, id));
  if (!existing[0]) {
    res.status(404).json({ error: "Department not found" });
    return;
  }

  if (!canAccessClient(req, existing[0].clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Deleting a department nulls out staff/site assignments (FK onDelete: set
  // null). Warn admins first: unless ?force=true is supplied, block with 409 and
  // return the counts so the web UI can show a confirm dialog, then retry with
  // force. Compliance items are also unassigned but not surfaced in the warning.
  const force = req.query.force === "true";
  if (!force) {
    const [staffCount] = await db
      .select({ n: count() })
      .from(usersTable)
      .where(eq(usersTable.departmentId, id));
    const [siteCount] = await db
      .select({ n: count() })
      .from(sitesTable)
      .where(eq(sitesTable.departmentId, id));

    const staff = Number(staffCount?.n ?? 0);
    const sites = Number(siteCount?.n ?? 0);

    if (staff > 0 || sites > 0) {
      res.status(409).json({
        error: "Department has assignments",
        requiresConfirmation: true,
        staffCount: staff,
        siteCount: sites,
        message: `This department has ${staff} staff and ${sites} sites — they will be unassigned.`,
      });
      return;
    }
  }

  await db.delete(departmentsTable).where(eq(departmentsTable.id, id));
  res.json({ ok: true });
});

export default router;
