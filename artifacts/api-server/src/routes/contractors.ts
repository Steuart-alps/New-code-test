import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { contractorsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import {
  CreateContractorBody,
  GetContractorParams,
  UpdateContractorParams,
  UpdateContractorBody,
  DeleteContractorParams,
} from "@workspace/api-zod";
import { requireAuth, requireClientAdmin, getClientId, canAccessClient } from "../middleware/requireAuth";

const router: IRouter = Router();

router.get("/contractors", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const contractors = await db
    .select()
    .from(contractorsTable)
    .where(eq(contractorsTable.clientId, clientId))
    .orderBy(contractorsTable.name);
  res.json(contractors);
});

router.post("/contractors", requireAuth, requireClientAdmin, async (req, res) => {
  const user = req.currentUser!;
  const body = CreateContractorBody.parse(req.body);
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const [contractor] = await db
    .insert(contractorsTable)
    .values({ ...body, clientId, updatedAt: new Date() })
    .returning();
  res.status(201).json(contractor);
});

router.get("/contractors/:id", requireAuth, async (req, res) => {
  const { id } = GetContractorParams.parse({ id: Number(req.params.id) });
  const user = req.currentUser!;

  const [contractor] = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!contractor) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }
  if (!canAccessClient(req, contractor.clientId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(contractor);
});

router.put("/contractors/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = UpdateContractorParams.parse({ id: Number(req.params.id) });
  const body = UpdateContractorBody.parse(req.body);
  const user = req.currentUser!;

  const existing = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!existing[0] || (!canAccessClient(req, existing[0].clientId))) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  const [contractor] = await db
    .update(contractorsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(contractorsTable.id, id))
    .returning();
  res.json(contractor);
});

router.delete("/contractors/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = DeleteContractorParams.parse({ id: Number(req.params.id) });
  const user = req.currentUser!;

  const existing = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!existing[0] || (!canAccessClient(req, existing[0].clientId))) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  await db.delete(contractorsTable).where(eq(contractorsTable.id, id));
  res.status(204).send();
});

export default router;
