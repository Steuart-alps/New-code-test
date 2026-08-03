import { Router } from "express";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { getCheckAlerts } from "../lib/checkReminders";

const router = Router();

// GET /check-reminders — aggregated overdue/due-soon check alerts for the authenticated client
router.get("/check-reminders", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  try {
    const alerts = await getCheckAlerts(clientId);
    return res.json(alerts);
  } catch (err) {
    console.error("GET /check-reminders error:", err);
    return res.status(500).json({ error: "Failed to fetch check reminders" });
  }
});

export default router;
