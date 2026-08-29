import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { auditEventsTable } from "@workspace/db/schema";
import { getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";

const router = Router();

// The trail can contain historical values, so it is intentionally restricted
// to the same management roles that can administer compliance records.
router.get("/", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
  const entityId = Number(req.query.entityId);
  const conditions: any[] = [eq(auditEventsTable.clientId, clientId)];
  if (entityType) conditions.push(eq(auditEventsTable.entityType, entityType));
  if (Number.isInteger(entityId) && entityId > 0) conditions.push(eq(auditEventsTable.entityId, entityId));
  const rows = await db.select().from(auditEventsTable)
    .where(and(...conditions)).orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id)).limit(500);
  res.json(rows);
});

export default router;