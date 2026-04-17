import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { certificatesTable, contractorsTable, complianceItemsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import {
  ListCertificatesParams,
  CreateCertificateParams,
  UpdateCertificateParams,
  DeleteCertificateParams,
} from "@workspace/api-zod";
import { z } from "zod";
import { requireAuth, requireClientAdmin } from "../middleware/requireAuth";

// Local schemas that coerce ISO date strings (the OpenAPI-generated zod schemas
// use `z.date()` which does NOT coerce strings, breaking JSON request bodies).
const CreateCertificateBody = z.object({
  name: z.string().min(1),
  fileUrl: z.string().nullish(),
  issueDate: z.coerce.date().nullish(),
  expiryDate: z.coerce.date().nullish(),
  notes: z.string().nullish(),
});

const UpdateCertificateBody = CreateCertificateBody.partial();

const router: IRouter = Router();

async function assertItemAccess(itemId: number, clientId: number | null, role: string) {
  const [item] = await db.select().from(complianceItemsTable).where(eq(complianceItemsTable.id, itemId));
  if (!item) return null;
  if (role !== "consultant" && item.clientId !== clientId) return null;
  return item;
}

// ----- Item-scoped certificates -----

router.get("/items/:itemId/certificates", requireAuth, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const user = req.currentUser!;
  const item = await assertItemAccess(itemId, user.clientId ?? null, user.role);
  if (!item) return res.status(404).json({ error: "Compliance item not found" });
  const certs = await db.select().from(certificatesTable).where(eq(certificatesTable.itemId, itemId)).orderBy(certificatesTable.createdAt);
  res.json(certs);
});

async function syncItemDueDateFromCertificates(itemId: number) {
  const certs = await db
    .select({ expiryDate: certificatesTable.expiryDate })
    .from(certificatesTable)
    .where(eq(certificatesTable.itemId, itemId));
  const expiries = certs
    .map((c) => c.expiryDate)
    .filter((d): d is Date => d != null);
  if (expiries.length === 0) return;
  // Use the latest expiry across all certificates as the item's next due date
  const latest = new Date(Math.max(...expiries.map((d) => d.getTime())));
  await db
    .update(complianceItemsTable)
    .set({ dueDate: latest, updatedAt: new Date() })
    .where(eq(complianceItemsTable.id, itemId));
}

router.post("/items/:itemId/certificates", requireAuth, requireClientAdmin, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const user = req.currentUser!;
  const body = CreateCertificateBody.parse(req.body);
  const item = await assertItemAccess(itemId, user.clientId ?? null, user.role);
  if (!item) return res.status(404).json({ error: "Compliance item not found" });
  const [cert] = await db.insert(certificatesTable).values({ ...body, itemId, contractorId: null }).returning();
  await syncItemDueDateFromCertificates(itemId);
  res.status(201).json(cert);
});

router.put("/items/:itemId/certificates/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const body = UpdateCertificateBody.parse(req.body);
  const item = await assertItemAccess(itemId, user.clientId ?? null, user.role);
  if (!item) return res.status(404).json({ error: "Compliance item not found" });
  const [cert] = await db
    .update(certificatesTable)
    .set(body)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.itemId, itemId)))
    .returning();
  if (!cert) return res.status(404).json({ error: "Certificate not found" });
  await syncItemDueDateFromCertificates(itemId);
  res.json(cert);
});

router.delete("/items/:itemId/certificates/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const id = Number(req.params.id);
  const user = req.currentUser!;
  const item = await assertItemAccess(itemId, user.clientId ?? null, user.role);
  if (!item) return res.status(404).json({ error: "Compliance item not found" });
  await db.delete(certificatesTable).where(and(eq(certificatesTable.id, id), eq(certificatesTable.itemId, itemId)));
  res.status(204).send();
});

async function assertContractorAccess(contractorId: number, clientId: number | null, role: string) {
  const [contractor] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, contractorId));
  if (!contractor) return null;
  if (role !== "consultant" && contractor.clientId !== clientId) return null;
  return contractor;
}

router.get("/contractors/:contractorId/certificates", requireAuth, async (req, res) => {
  const { contractorId } = ListCertificatesParams.parse({ contractorId: Number(req.params.contractorId) });
  const user = req.currentUser!;

  const contractor = await assertContractorAccess(contractorId, user.clientId ?? null, user.role);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  const certs = await db
    .select()
    .from(certificatesTable)
    .where(eq(certificatesTable.contractorId, contractorId))
    .orderBy(certificatesTable.createdAt);
  res.json(certs);
});

router.post("/contractors/:contractorId/certificates", requireAuth, requireClientAdmin, async (req, res) => {
  const { contractorId } = CreateCertificateParams.parse({ contractorId: Number(req.params.contractorId) });
  const user = req.currentUser!;
  const body = CreateCertificateBody.parse(req.body);

  const contractor = await assertContractorAccess(contractorId, user.clientId ?? null, user.role);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  const [cert] = await db
    .insert(certificatesTable)
    .values({ ...body, contractorId })
    .returning();
  res.status(201).json(cert);
});

router.put("/contractors/:contractorId/certificates/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { contractorId, id } = UpdateCertificateParams.parse({
    contractorId: Number(req.params.contractorId),
    id: Number(req.params.id),
  });
  const user = req.currentUser!;
  const body = UpdateCertificateBody.parse(req.body);

  const contractor = await assertContractorAccess(contractorId, user.clientId ?? null, user.role);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  const [cert] = await db
    .update(certificatesTable)
    .set(body)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.contractorId, contractorId)))
    .returning();
  if (!cert) {
    res.status(404).json({ error: "Certificate not found" });
    return;
  }
  res.json(cert);
});

router.delete("/contractors/:contractorId/certificates/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { contractorId, id } = DeleteCertificateParams.parse({
    contractorId: Number(req.params.contractorId),
    id: Number(req.params.id),
  });
  const user = req.currentUser!;

  const contractor = await assertContractorAccess(contractorId, user.clientId ?? null, user.role);
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  await db
    .delete(certificatesTable)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.contractorId, contractorId)));
  res.status(204).send();
});

export default router;
