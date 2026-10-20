import { Router } from "express";
import { db } from "@workspace/db";
import { dailyChecklistsTable, dailyManagerSignoffsTable, sitesTable } from "@workspace/db/schema";
import { eq, and, or, isNull, inArray, gte, lte } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { getEntitledServices } from "../lib/services";
import { sitesTableVisibleTo } from "../lib/departmentSites";
import { dailyTrackRequirements } from "../lib/dailyChecklistEntitlements";

const router = Router();

function allowedSites(clientId: number, deptId: number) {
  return db.select({ id: sitesTable.id }).from(sitesTable).where(
    and(eq(sitesTable.clientId, clientId), sitesTableVisibleTo(deptId))
  );
}

// GET /api/daily-track-status/history?from=&to= — slim completion history for
// the status page's day grid and month calendar: the requirements this client's
// services enable, and the AM/PM checklists and manager sign-offs behind them.
router.get("/history", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { from, to } = req.query as Record<string, string>;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
    return res.status(400).json({ error: "from and to (YYYY-MM-DD) are required" });
  }
  const requirements = dailyTrackRequirements(await getEntitledServices(clientId));
  const checklistTypes = requirements.filter((requirement) => requirement !== "signoff");
  if (checklistTypes.length === 0) return res.status(403).json({ error: "No daily checklist service is enabled" });

  const deptId = getActiveDepartmentId(req);
  const deptFilter = (siteCol: any) =>
    deptId !== null ? (or(isNull(siteCol), inArray(siteCol, allowedSites(clientId, deptId))) as any) : undefined;

  const clConditions: any[] = [
    eq(dailyChecklistsTable.clientId, clientId),
    inArray(dailyChecklistsTable.checklistType, checklistTypes),
    gte(dailyChecklistsTable.checkDate, from),
    lte(dailyChecklistsTable.checkDate, to),
  ];
  const clDept = deptFilter(dailyChecklistsTable.siteId);
  if (clDept) clConditions.push(clDept);

  const soConditions: any[] = [
    eq(dailyManagerSignoffsTable.clientId, clientId),
    gte(dailyManagerSignoffsTable.signoffDate, from),
    lte(dailyManagerSignoffsTable.signoffDate, to),
  ];
  const soDept = deptFilter(dailyManagerSignoffsTable.siteId);
  if (soDept) soConditions.push(soDept);

  const [checklists, signoffs] = await Promise.all([
    db.select({
      checkDate: dailyChecklistsTable.checkDate,
      siteId: dailyChecklistsTable.siteId,
      checklistType: dailyChecklistsTable.checklistType,
      submittedAt: dailyChecklistsTable.submittedAt,
    }).from(dailyChecklistsTable).where(and(...clConditions)),
    requirements.includes("signoff")
      ? db.select({
        signoffDate: dailyManagerSignoffsTable.signoffDate,
        siteId: dailyManagerSignoffsTable.siteId,
        submittedAt: dailyManagerSignoffsTable.submittedAt,
      }).from(dailyManagerSignoffsTable).where(and(...soConditions))
      : Promise.resolve([]),
  ]);

  res.json({ requirements, checklists, signoffs });
});

export default router;
