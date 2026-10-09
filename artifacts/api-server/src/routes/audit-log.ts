import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, auditLogTable, usersTable } from "@workspace/db";
import { ListAuditLogQueryParams, ListAuditLogResponse } from "@workspace/api-zod";
import { getClientId, requireAuth, requireClientAdmin } from "../middleware/requireAuth";
import { requireAnyService, type ServiceKey } from "../lib/services";

const modules: Record<string, { table: string; services: ServiceKey[] }> = {
  fire: { table: "fire_safety_checks", services: ["firetrack"] },
  legionella: { table: "legionella_checks", services: ["legionellatrack"] },
  kitchen: { table: "food_safety_records", services: ["kitchentrack"] },
  fix: { table: "fix_track_issues", services: ["fixtrack"] },
  safe: { table: "safe_risk_assessments", services: ["safetrack"] },
  train: { table: "train_track_records", services: ["traintrack"] },
  doc: { table: "doc_track_documents", services: ["doctrack", "safetrack"] },
  incidents: { table: "incidents", services: ["incidenttrack"] },
};
const router = Router();
router.get("/", requireAuth, requireClientAdmin, (req, res, next) => {
  const parsed = ListAuditLogQueryParams.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "A valid module is required" });
  return requireAnyService(...modules[parsed.data.module].services)(req, res, next);
}, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const { module } = ListAuditLogQueryParams.parse(req.query);
  const rows = await db.select({
    id: auditLogTable.id, tableName: auditLogTable.tableName, rowId: auditLogTable.rowId,
    action: auditLogTable.action, changedBy: auditLogTable.changedBy,
    changedAt: auditLogTable.changedAt, diff: auditLogTable.diff, actorName: usersTable.name,
  }).from(auditLogTable)
    .leftJoin(usersTable, eq(usersTable.id, auditLogTable.changedBy))
    .where(and(eq(auditLogTable.clientId, clientId), eq(auditLogTable.tableName, modules[module].table)))
    .orderBy(desc(auditLogTable.changedAt), desc(auditLogTable.id)).limit(50);
  res.json(ListAuditLogResponse.parse(rows));
});
export default router;