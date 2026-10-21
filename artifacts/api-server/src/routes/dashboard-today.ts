/**
 * GET /api/dashboard/today-by-department?siteId=N
 *
 * The dashboard's "Today by department" card: today's checks per site and
 * department as done / not done yet / failed (lib/todayByDepartment.ts).
 * Owners choose which roles see it (Settings); 403 for everyone else.
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import {
  TODAY_BY_DEPARTMENT_ROLES_SETTING,
  canSeeTodayByDepartment,
  getTodayByDepartment,
  parseTodayByDepartmentRoles,
  todayDepartmentScope,
} from "../lib/todayByDepartment";

const router = Router();

router.get("/dashboard/today-by-department", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const user = req.currentUser!;

  const [setting] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, TODAY_BY_DEPARTMENT_ROLES_SETTING)))
    .limit(1);
  if (!canSeeTodayByDepartment(user, parseTodayByDepartmentRoles(setting?.value))) {
    return res.status(403).json({ error: "This card is not shown for your role", code: "TODAY_BY_DEPARTMENT_HIDDEN" });
  }

  const rawSiteId = req.query.siteId as string | undefined;
  const siteId = rawSiteId && /^\d+$/.test(rawSiteId) ? Number(rawSiteId) : null;
  try {
    // A site outside the person's scope simply comes back with no groups.
    const departmentIds = todayDepartmentScope(user, req.departmentIds);
    res.json(await getTodayByDepartment({ clientId, siteId, departmentIds }));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load today by department");
    res.status(500).json({ error: "Unable to load today's department status" });
  }
});

export default router;
