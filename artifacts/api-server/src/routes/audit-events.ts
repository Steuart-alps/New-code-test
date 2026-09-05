import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { auditEventsTable, usersTable } from "@workspace/db/schema";
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
  // Join only the actor's public display fields. In particular, do not expose
  // account credentials or tenant membership data through the audit endpoint.
  const rows = await db
    .select({
      id: auditEventsTable.id,
      clientId: auditEventsTable.clientId,
      actorId: auditEventsTable.actorId,
      actorName: usersTable.name,
      entityType: auditEventsTable.entityType,
      entityId: auditEventsTable.entityId,
      action: auditEventsTable.action,
      before: auditEventsTable.before,
      after: auditEventsTable.after,
      metadata: auditEventsTable.metadata,
      createdAt: auditEventsTable.createdAt,
    })
    .from(auditEventsTable)
    .leftJoin(usersTable, eq(auditEventsTable.actorId, usersTable.id))
    // Scope first by the active, authorised tenant. entity IDs are global
    // implementation details and must never be sufficient to retrieve a row.
    .where(and(...conditions))
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
    .limit(500);
  res.json(rows);
});

export default router;