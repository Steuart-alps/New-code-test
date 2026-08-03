import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull } from "drizzle-orm";
import {
  requireAuth,
  requireClientAdmin,
  getClientId,
  canAccessClient,
  getActiveDepartmentId,
} from "../middleware/requireAuth";
import { seedSiteStarterChecks } from "../lib/seedStarterContent";
import { syncClientSubscriptionQuantity, queueSiteAddedCharge } from "../lib/billing";
import { filterName } from "../lib/contentFilter";

const router: IRouter = Router();

router.get("/sites", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const conditions: ReturnType<typeof eq>[] = [eq(sitesTable.clientId, clientId)];

  // Department scoping: staff/viewers with a department only see sites in their
  // department or sites that have not been assigned to any department.
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null) {
    conditions.push(or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, deptId)) as any);
  }

  const sites = await db
    .select()
    .from(sitesTable)
    .where(and(...conditions))
    .orderBy(sitesTable.name);
  res.json(sites);
});

router.get("/sites/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (!canAccessClient(req, site.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Department scoping: staff/viewers can only read sites in their department
  // (or unassigned sites).
  const deptId = getActiveDepartmentId(req);
  if (deptId !== null && site.departmentId !== null && site.departmentId !== deptId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(site);
});

router.post("/sites", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "Site name is required" });
    return;
  }
  const nameCheck = filterName(name);
  if (!nameCheck.ok) {
    res.status(400).json({ error: nameCheck.message });
    return;
  }
  // The site row and its billing charge intent are created atomically: a
  // crash can never produce an added site that was never billed.
  const site = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(sitesTable)
      .values({
        clientId,
        name,
        departmentId: req.body.departmentId ?? null,
        responsiblePerson: req.body.responsiblePerson ?? null,
        address: req.body.address ?? null,
        phone: req.body.phone ?? null,
        updatedAt: new Date(),
      })
      .returning();
    await queueSiteAddedCharge(tx, clientId, created.id);
    return created;
  });

  // Pre-populate the new site with the starter pack of compliance checks,
  // unless the caller explicitly opted out.
  if (req.body.seedStarterChecks !== false) {
    await seedSiteStarterChecks(clientId, site.id);
  }

  // Per-site billing: a new site increases the subscription quantity (£10/mo more).
  await syncClientSubscriptionQuantity(clientId);

  res.status(201).json(site);
});

router.patch("/sites/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (!canAccessClient(req, existing.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["name", "responsiblePerson", "address", "phone"] as const) {
    if (key in req.body) updates[key] = req.body[key];
  }
  // Allow tagging / un-tagging a site to a department
  if ("departmentId" in req.body) updates.departmentId = req.body.departmentId ?? null;

  const [updated] = await db.update(sitesTable).set(updates).where(eq(sitesTable.id, id)).returning();
  res.json(updated);
});

router.delete("/sites/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (!canAccessClient(req, existing.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db.delete(sitesTable).where(eq(sitesTable.id, id));

  // Per-site billing: removing a site decreases the subscription quantity
  // at the next renewal (no refund or credit for the remainder of the month).
  await syncClientSubscriptionQuantity(existing.clientId);

  res.status(204).send();
});

export default router;
