import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { certificatesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import {
  ListCertificatesParams,
  CreateCertificateParams,
  CreateCertificateBody,
  UpdateCertificateParams,
  UpdateCertificateBody,
  DeleteCertificateParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/contractors/:contractorId/certificates", async (req, res) => {
  const { contractorId } = ListCertificatesParams.parse({ contractorId: Number(req.params.contractorId) });
  const certs = await db
    .select()
    .from(certificatesTable)
    .where(eq(certificatesTable.contractorId, contractorId))
    .orderBy(certificatesTable.createdAt);
  res.json(certs);
});

router.post("/contractors/:contractorId/certificates", async (req, res) => {
  const { contractorId } = CreateCertificateParams.parse({ contractorId: Number(req.params.contractorId) });
  const body = CreateCertificateBody.parse(req.body);
  const [cert] = await db
    .insert(certificatesTable)
    .values({ ...body, contractorId })
    .returning();
  res.status(201).json(cert);
});

router.put("/contractors/:contractorId/certificates/:id", async (req, res) => {
  const { contractorId, id } = UpdateCertificateParams.parse({
    contractorId: Number(req.params.contractorId),
    id: Number(req.params.id),
  });
  const body = UpdateCertificateBody.parse(req.body);
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

router.delete("/contractors/:contractorId/certificates/:id", async (req, res) => {
  const { contractorId, id } = DeleteCertificateParams.parse({
    contractorId: Number(req.params.contractorId),
    id: Number(req.params.id),
  });
  await db
    .delete(certificatesTable)
    .where(and(eq(certificatesTable.id, id), eq(certificatesTable.contractorId, contractorId)));
  res.status(204).send();
});

export default router;
