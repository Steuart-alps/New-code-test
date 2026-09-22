import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
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
import { ObjectStorageService, ObjectNotFoundError, ObjectOwnershipError } from "../lib/objectStorage";
import { respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { departmentsTable } from "@workspace/db/schema";

const storage = new ObjectStorageService();

const router: IRouter = Router();

async function validateDepartmentForClient(rawDepartmentId: unknown, clientId: number): Promise<number | null | "invalid"> {
  if (rawDepartmentId === undefined || rawDepartmentId === null || rawDepartmentId === "") return null;
  const departmentId = Number(rawDepartmentId);
  if (!Number.isInteger(departmentId) || departmentId <= 0) return "invalid";
  const [department] = await db.select({ id: departmentsTable.id })
    .from(departmentsTable)
    .where(and(eq(departmentsTable.id, departmentId), eq(departmentsTable.clientId, clientId)))
    .limit(1);
  return department ? departmentId : "invalid";
}

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
  const departmentId = await validateDepartmentForClient(req.body?.departmentId, clientId);
  if (departmentId === "invalid") {
    res.status(400).json({ error: "Department does not belong to this client" });
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
        departmentId,
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
  let departmentId: number | null | "invalid" = existing.departmentId;
  if ("departmentId" in req.body) {
    departmentId = await validateDepartmentForClient(req.body.departmentId, existing.clientId);
    if (departmentId === "invalid") {
      res.status(400).json({ error: "Department does not belong to this client" });
      return;
    }
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["name", "responsiblePerson", "address", "phone"] as const) {
    if (key in req.body) updates[key] = req.body[key];
  }
  // Allow tagging / un-tagging a site to a department
  if ("departmentId" in req.body) updates.departmentId = departmentId;

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

// ─── Site Documents ───────────────────────────────────────────────────────────

// Helper: assert site belongs to this client and return the site row
async function getSiteForClient(siteId: number, clientId: number) {
  const [site] = await db
    .select({ id: sitesTable.id, clientId: sitesTable.clientId })
    .from(sitesTable)
    .where(and(eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId)))
    .limit(1);
  return site ?? null;
}

// GET /sites/:id/documents
router.get("/sites/:id/documents", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = Number(req.params.id);
  if (!isFinite(siteId)) return res.status(400).json({ error: "Invalid site id" });

  const site = await getSiteForClient(siteId, clientId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const rows = await db.execute(sql`
    SELECT sd.id, sd.name, sd.object_path, sd.created_at,
           u.name AS uploaded_by_name
    FROM   site_documents sd
    LEFT   JOIN users u ON u.id = sd.uploaded_by
    WHERE  sd.client_id = ${clientId}
    AND    sd.site_id   = ${siteId}
    ORDER  BY sd.created_at DESC
  `);
  res.json(rows.rows);
});

// POST /sites/:id/documents/request-upload  — returns presigned PUT URL
router.post("/sites/:id/documents/request-upload", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = Number(req.params.id);
  if (!isFinite(siteId)) return res.status(400).json({ error: "Invalid site id" });

  const site = await getSiteForClient(siteId, clientId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  try {
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId);
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    res.json({ uploadUrl, objectPath });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "site document upload");
  }
});

// POST /sites/:id/documents  — save a document record after upload
router.post("/sites/:id/documents", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = Number(req.params.id);
  if (!isFinite(siteId)) return res.status(400).json({ error: "Invalid site id" });

  const site = await getSiteForClient(siteId, clientId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  const name = String(req.body?.name ?? "").trim().slice(0, 300);
  const objectPath = String(req.body?.objectPath ?? "").trim();
  if (!name || !objectPath) return res.status(400).json({ error: "name and objectPath are required" });
  try {
    await storage.finalizeTenantUpload(objectPath, clientId);
  } catch (err) {
    const error = err instanceof ObjectNotFoundError ? "Uploaded object not found"
      : err instanceof ObjectOwnershipError ? err.message : "Could not secure uploaded document";
    return res.status(err instanceof ObjectNotFoundError ? 404 : 403).json({ error });
  }

  const userId: number | null = (req.session as any)?.userId ?? null;

  const docInsertResult = await db.execute(sql`
    INSERT INTO site_documents (client_id, site_id, name, object_path, uploaded_by)
    VALUES (${clientId}, ${siteId}, ${name}, ${objectPath}, ${userId})
    RETURNING id, name, object_path, created_at
  `);
  const row = ((docInsertResult as any).rows ?? [])[0];
  res.status(201).json((row as any) ?? {});
});

// DELETE /sites/:id/documents/:docId
router.delete("/sites/:id/documents/:docId", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const siteId = Number(req.params.id);
  const docId  = Number(req.params.docId);
  if (!isFinite(siteId) || !isFinite(docId)) return res.status(400).json({ error: "Invalid id" });

  const site = await getSiteForClient(siteId, clientId);
  if (!site) return res.status(404).json({ error: "Site not found" });

  await db.execute(sql`
    DELETE FROM site_documents
    WHERE id = ${docId} AND client_id = ${clientId} AND site_id = ${siteId}
  `);
  res.status(204).end();
});

export default router;
