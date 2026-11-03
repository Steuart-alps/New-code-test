/**
 * GET /api/dashboard/frost-warnings?siteId=N
 *
 * The dashboard's frost warning: tonight's sites whose overnight forecast
 * drops below 4°C (lib/frostWarnings.ts), limited to the sites the person can
 * see. Shown from the afternoon check until midday the next day.
 */

import { Router } from "express";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { resolveSiteAccessScope } from "../lib/siteAccessScope";
import { frostWarningsFor } from "../lib/frostWarnings";

const router = Router();

router.get("/dashboard/frost-warnings", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const rawSiteId = req.query.siteId;
  if (rawSiteId !== undefined && !(typeof rawSiteId === "string" && /^\d+$/.test(rawSiteId))) {
    return res.status(400).json({ error: "Invalid site" });
  }
  const scope = await resolveSiteAccessScope(req, res, clientId, rawSiteId === undefined ? undefined : Number(rawSiteId));
  if (!scope) return;
  try {
    res.json(await frostWarningsFor(clientId, scope.sites.map((site) => site.id)));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load frost warnings");
    res.status(500).json({ error: "Unable to load frost warnings" });
  }
});

export default router;
