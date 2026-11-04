import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { getCheckAlerts } from "../lib/checkReminders";
import { visibleSiteIdsSql } from "../lib/departmentSites";

const router = Router();

// GET /check-reminders — aggregated overdue/due-soon check alerts for the authenticated client
router.get("/check-reminders", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  try {
    const departmentId = getActiveDepartmentId(req);
    const accessibleSiteIds = departmentId == null ? null :
      (await db.execute(visibleSiteIdsSql(clientId, departmentId))).rows.map(row => Number(row.id));
    const alerts = await getCheckAlerts(clientId, { accessibleSiteIds });
    return res.json(alerts);
  } catch (err) {
    console.error("GET /check-reminders error:", err);
    return res.status(500).json({ error: "Failed to fetch check reminders" });
  }
});

export default router;
