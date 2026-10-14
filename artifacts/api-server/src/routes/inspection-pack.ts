import { Router } from "express";
import { z } from "zod";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { logger } from "../lib/logger";
import { buildInspectionPack } from "../lib/inspectionPack";
import { writeInspectionPackPdf } from "../lib/inspectionPackPdf";
import {
  addCalendarMonths, inclusiveDays, isCalendarDate, resolveSiteAccessScope,
} from "../lib/siteAccessScope";

const router = Router();

const dateOnly = z.string().refine(isCalendarDate, "Dates must be real calendar dates (YYYY-MM-DD)");
const querySchema = z.object({
  from: dateOnly,
  to: dateOnly,
  siteId: z.coerce.number().int().positive().optional(),
});

function fileSlug(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";
}

// GET /reports/inspection-pack?siteId=&from=&to=
// Read-only, so viewers may download it too. Tenant comes from getClientId and
// the site must be in the user's department scope.
router.get("/reports/inspection-pack", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid params" });
  const { from, to, siteId } = parsed.data;
  if (from > to) return res.status(400).json({ error: "The start date must not be after the end date" });
  if (to >= addCalendarMonths(from, 12)) {
    return res.status(400).json({ error: "Choose a period of 12 months or less" });
  }

  const scope = await resolveSiteAccessScope(req, res, clientId, siteId);
  if (!scope) return;

  const pack = await buildInspectionPack({
    scope, from, to,
    totalDays: inclusiveDays(from, to),
    generatedBy: req.currentUser?.name ?? "",
  });
  const where = scope.siteId === null ? "all-sites" : fileSlug(scope.sites[0]?.name ?? "site");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="inspection-pack-${where}-${from}-to-${to}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  const doc = writeInspectionPackPdf(pack, res);
  doc.on("error", (error) => {
    logger.error({ err: error, clientId }, "Inspection pack PDF failed while streaming");
    res.destroy(error);
  });
});

export default router;
