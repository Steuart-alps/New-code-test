import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { contractorsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  CreateContractorBody,
  GetContractorParams,
  UpdateContractorParams,
  UpdateContractorBody,
  DeleteContractorParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/contractors", async (_req, res) => {
  const contractors = await db.select().from(contractorsTable).orderBy(contractorsTable.name);
  res.json(contractors);
});

router.post("/contractors", async (req, res) => {
  const body = CreateContractorBody.parse(req.body);
  const [contractor] = await db
    .insert(contractorsTable)
    .values({ ...body, updatedAt: new Date() })
    .returning();
  res.status(201).json(contractor);
});

router.get("/contractors/:id", async (req, res) => {
  const { id } = GetContractorParams.parse({ id: Number(req.params.id) });
  const [contractor] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  res.json(contractor);
});

router.put("/contractors/:id", async (req, res) => {
  const { id } = UpdateContractorParams.parse({ id: Number(req.params.id) });
  const body = UpdateContractorBody.parse(req.body);
  const [contractor] = await db
    .update(contractorsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(contractorsTable.id, id))
    .returning();
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  res.json(contractor);
});

router.delete("/contractors/:id", async (req, res) => {
  const { id } = DeleteContractorParams.parse({ id: Number(req.params.id) });
  await db.delete(contractorsTable).where(eq(contractorsTable.id, id));
  res.status(204).send();
});

export default router;
