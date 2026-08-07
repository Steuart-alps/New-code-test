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
import { filterName } from "../lib/contentFilter";

const router: IRouter = Router();

/** Sanitise the trades array from the request body. */
function parseTrades(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter((t): t is string => typeof t === "string")
    .slice(0, 20);
}

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
  const body     = CreateContractorBody.parse(req.body);
  const trades   = parseTrades(req.body?.trades);
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }
  const nameCheck = filterName(body.name);
  if (!nameCheck.ok) {
    res.status(400).json({ error: nameCheck.message });
    return;
  }
  if (body.company) {
    const companyCheck = filterName(body.company);
    if (!companyCheck.ok) {
      res.status(400).json({ error: companyCheck.message });
      return;
    }
  }
  const [contractor] = await db
    .insert(contractorsTable)
    .values({ ...body, clientId, trades, updatedAt: new Date() })
    .returning();
  res.status(201).json(contractor);
});

router.get("/contractors/:id", requireAuth, async (req, res) => {
  const { id } = GetContractorParams.parse({ id: Number(req.params.id) });

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
  const body    = UpdateContractorBody.parse(req.body);

  const nameCheck = filterName(body.name);
  if (!nameCheck.ok) {
    res.status(400).json({ error: nameCheck.message });
    return;
  }
  if (body.company) {
    const companyCheck = filterName(body.company);
    if (!companyCheck.ok) {
      res.status(400).json({ error: companyCheck.message });
      return;
    }
  }

  const existing = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!existing[0] || !canAccessClient(req, existing[0].clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  // Merge trades only when explicitly supplied in the request body
  const updateData: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if ("trades" in req.body) updateData.trades = parseTrades(req.body.trades);

  const [contractor] = await db
    .update(contractorsTable)
    .set(updateData as any)
    .where(and(eq(contractorsTable.id, id), eq(contractorsTable.clientId, existing[0].clientId)))
    .returning();
  res.json(contractor);
});

router.delete("/contractors/:id", requireAuth, requireClientAdmin, async (req, res) => {
  const { id } = DeleteContractorParams.parse({ id: Number(req.params.id) });

  const existing = await db.select().from(contractorsTable).where(eq(contractorsTable.id, id));
  if (!existing[0] || !canAccessClient(req, existing[0].clientId)) {
    res.status(404).json({ error: "Contractor not found" });
    return;
  }

  await db.delete(contractorsTable).where(eq(contractorsTable.id, id));
  res.status(204).send();
});

export default router;
