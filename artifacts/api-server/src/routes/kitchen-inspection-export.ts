import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { ZipArchive } from "archiver";
import { db } from "@workspace/db";
import { sitesTable } from "@workspace/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { requireAuth, getClientId, getActiveDepartmentId } from "../middleware/requireAuth";
import { requireService } from "../lib/services";
import { KitchenRegisterTooLarge, kitchenInspectionRegister } from "../lib/kitchenInspectionRegister";

const router = Router();
const requireKitchenManager: RequestHandler = (req, res, next) => {
  const user = req.currentUser;
  if (user && (user.role === "client_admin" || user.role === "consultant"
    || (user.role === "client_staff" && user.isDepartmentManager === true))) return next();
  res.status(403).json({ error: "Manager access required" });
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() >= 1 && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const query = z.object({
  siteId: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().safe()),
  from: date, to: date,
}).refine(value => value.from <= value.to, "The start date must not be after the end date");

/** GET /api/export/kitchen-register?siteId=N&from=YYYY-MM-DD&to=YYYY-MM-DD
 * ZIP of CSVs. Every row's inspection_date lies in the inclusive requested range.
 * Remediation and evidence inherit their source observation's inspection date.
 */
router.get("/export/kitchen-register", requireAuth, requireKitchenManager, requireService("kitchentrack"), async (req, res) => {
  const clientId = getClientId(req);
  const input = query.safeParse(req.query);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!input.success) return res.status(400).json({ error: "Choose a site and valid, ordered start/end dates" });
  const { siteId, from, to } = input.data;
  const departmentId = getActiveDepartmentId(req);
  const [site] = await db.select().from(sitesTable).where(and(
    eq(sitesTable.id, siteId), eq(sitesTable.clientId, clientId),
    ...(departmentId === null ? [] : [or(isNull(sitesTable.departmentId), eq(sitesTable.departmentId, departmentId))!]),
  ));
  if (!site) return res.status(403).json({ error: "Site not accessible" });
  let files: Record<string, string>;
  try { files = await kitchenInspectionRegister(clientId, siteId, from, to); }
  catch (error) {
    if (error instanceof KitchenRegisterTooLarge) return res.status(413).json({ error: error.message });
    throw error;
  }
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("error", error => { req.log.error({ err: error }, "Kitchen inspection export failed"); res.destroy(error); });
  res.on("close", () => { if (!res.writableFinished) archive.abort(); });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Cache-Control", "private, no-store");
  res.attachment(`kitchentrack-site-${siteId}-${from}-to-${to}.zip`);
  archive.pipe(res);
  archive.append(`KitchenTrack inspection register\nSite: ${site.name} (ID ${siteId})\nInclusive dates: ${from} to ${to}\nGenerated: ${new Date().toISOString()}\n\nOnly this site's records are included; organisation-level legacy records are excluded.\nWeekly reviews are selected by week-commencing date. Daily, probe and sign-off records use their recorded calendar date.\nTemperature failures preserve the original numeric observation and limit snapshot. Older records are not retrospectively reclassified with current rules.\nCorrective actions and their verification evidence use the failed diary's date (manual actions use their UK creation day). Later resolution/review timestamps are audit details, not additional inspection dates.\nDaily diaries contain embedded manager signatures and original corrective notes. Manager-signoffs contains separate daily sign-offs.\nCSV values are protected against spreadsheet formulas; observation JSON preserves the complete recorded rows.\nEvidence references are references only: uploaded documents are not bundled. Empty CSVs mean no records for that section.\nThis register supports record keeping and does not certify compliance.\n`, { name: "README.txt" });
  for (const [name, contents] of Object.entries(files)) archive.append(contents, { name });
  await archive.finalize();
});
export default router;