import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sitesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, canAccessClient } from "../middleware/requireAuth";
import { seedSiteStarterChecks } from "../lib/seedStarterContent";
import { syncClientSubscriptionQuantity } from "../lib/billing";

const router: IRouter = Router();

router.get("/sites", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const sites = await db
    .select()
    .from(sitesTable)
    .where(eq(sitesTable.clientId, clientId))
    .orderBy(sitesTable.name);
  res.json(sites);
});

router.get("/sites/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const [site] = await db.select().from(sitesTable).where(eq(sitesTable.id, id));
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  if (!canAccessClient(req, site.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(site);
});

router.post("/sites", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
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
  const [site] = await db
    .insert(sitesTable)
    .values({
      clientId,
      name,
      responsiblePerson: req.body.responsiblePerson ?? null,
      address: req.body.address ?? null,
      phone: req.body.phone ?? null,
      updatedAt: new Date(),
    })
    .returning();

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
  const user = req.currentUser!;
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
  const [updated] = await db.update(sitesTable).set(updates).where(eq(sitesTable.id, id)).returning();
  res.json(updated);
});

router.delete("/sites/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.currentUser!;
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

  // Per-site billing: removing a site decreases the subscription quantity (with proration).
  await syncClientSubscriptionQuantity(existing.clientId);

  res.status(204).send();
});

export default router;
