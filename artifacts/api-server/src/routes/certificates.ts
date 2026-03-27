import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { certificatesTable, contractorsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import {
  ListCertificatesParams,
  CreateCertificateParams,
  CreateCertificateBody,
  UpdateCertificateParams,
  UpdateCertificateBody,
  DeleteCertificateParams,
} from "@workspace/api-zod";
import { requireAuth, requireClientAdmin } from "../middleware/requireAuth";

const router: IRouter = Router();

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
