import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, requireClientAdmin, requireConsultant, denyViewers, getClientId } from "../middleware/requireAuth";
import { UpdateFeedbackReportBody, ListFeedbackReportsQueryParams } from "@workspace/api-zod";
import { escapeHtml, getPublicAppUrl, sendSystemEmail } from "../lib/email";
import {
  ObjectStorageService, ObjectNotFoundError, ObjectOwnershipError, ObjectContentError, ObjectGenerationError,
  type AllowedUploadType,
} from "../lib/objectStorage";
import { respondObjectStorageDownloadUnavailable, respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { ensureUploadCapacity } from "../lib/storageLimit";

const router: IRouter = Router();
const storage = new ObjectStorageService();

// Screenshots are images only; HEIC from phones is converted to JPEG on finalise.
const SCREENSHOT_TYPES: ReadonlySet<AllowedUploadType> = new Set(["image/png", "image/jpeg", "image/webp"]);
const CROSS_BUSINESS_LIMIT = 500;

const reportColumns = sql`
  f.id, f.client_id AS "clientId", f.category, f.summary, f.details,
  f.page_path AS "pagePath", f.email_status AS "emailStatus", f.created_at AS "createdAt",
  f.status, f.internal_note AS "internalNote", f.updated_by AS "updatedBy",
  (SELECT u.name FROM users u WHERE u.id = f.updated_by) AS "updatedByName",
  f.updated_at AS "updatedAt", f.revision,
  (SELECT u.name FROM users u WHERE u.id = f.user_id) AS "submitterName",
  (SELECT c.name FROM clients c WHERE c.id = f.client_id) AS "clientName",
  f.screenshot_object_path IS NOT NULL AS "hasScreenshot", f.app_version AS "appVersion"
`;

const reportIdParam = z.coerce.number().int().positive().max(2147483647);

router.get("/feedback", requireAuth, requireClientAdmin, async (req, res): Promise<void> => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "Select a client to review feedback." });
    return;
  }
  // clientId has already been checked by the global tenant middleware.
  const parsed = ListFeedbackReportsQueryParams.safeParse({
    category: req.query.category, status: req.query.status,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid feedback type or status filter." });
    return;
  }
  const { category, status } = parsed.data;
  const result = await db.execute(sql`
    SELECT ${reportColumns} FROM feedback_reports f
    WHERE f.client_id = ${clientId}
      ${category ? sql`AND f.category = ${category}` : sql``}
      ${status ? sql`AND f.status = ${status}` : sql``}
    ORDER BY f.created_at DESC, f.id DESC
  `);
  res.json(result.rows);
});

// One list across every business the consultant may open (ALPS platform
// operators see all businesses; other consultancies only their linked ones).
// Owners keep their own per-business inbox above.
router.get("/feedback/all-businesses", requireAuth, requireConsultant, async (req, res): Promise<void> => {
  const parsed = ListFeedbackReportsQueryParams.safeParse({
    category: req.query.category, status: req.query.status,
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid feedback type or status filter." });
    return;
  }
  const ids = new Set(req.allowedClientIds ?? []);
  if (req.currentUser!.clientId) ids.add(req.currentUser!.clientId);
  const clientIds = [...ids].filter(id => Number.isSafeInteger(id) && id > 0);
  if (clientIds.length === 0) {
    res.json([]);
    return;
  }
  const { category, status } = parsed.data;
  const result = await db.execute(sql`
    SELECT ${reportColumns} FROM feedback_reports f
    WHERE f.client_id IN (${sql.join(clientIds.map(id => sql`${id}`), sql`, `)})
      ${category ? sql`AND f.category = ${category}` : sql``}
      ${status ? sql`AND f.status = ${status}` : sql``}
    ORDER BY f.created_at DESC, f.id DESC
    LIMIT ${CROSS_BUSINESS_LIMIT}
  `);
  res.json(result.rows);
});

// Short-lived link to a report's screenshot, for administrators of its business.
router.get("/feedback/:id/screenshot", requireAuth, requireClientAdmin, async (req, res): Promise<void> => {
  const clientId = getClientId(req);
  const id = reportIdParam.safeParse(req.params.id);
  if (!clientId) {
    res.status(400).json({ error: "Select a client to review feedback." });
    return;
  }
  if (!id.success) {
    res.status(400).json({ error: "Invalid feedback report." });
    return;
  }
  const found = await db.execute(sql`
    SELECT screenshot_object_path AS "objectPath", screenshot_file_name AS "fileName"
    FROM feedback_reports WHERE id = ${id.data} AND client_id = ${clientId}
  `);
  const row = found.rows[0] as { objectPath: string | null; fileName: string | null } | undefined;
  if (!row?.objectPath) {
    res.status(404).json({ error: "This report has no screenshot." });
    return;
  }
  try {
    const downloadUrl = await storage.getSignedDownloadURL(row.objectPath, 900, SCREENSHOT_TYPES, clientId);
    res.json({ downloadUrl, fileName: row.fileName ?? "screenshot" });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "Screenshot file not found." }); return; }
    if (err instanceof ObjectOwnershipError) { res.status(403).json({ error: "Screenshot is not available for this account." }); return; }
    if (err instanceof ObjectContentError) { res.status(409).json({ error: "Screenshot failed its content check." }); return; }
    respondObjectStorageDownloadUnavailable(req, res, err, "feedback screenshot download", { reportId: id.data, clientId });
  }
});

// Review history is internal: only administrators/consultants authorised for
// the selected client may read it, and only for that client's reports.
router.get("/feedback/:id/history", requireAuth, requireClientAdmin, async (req, res): Promise<void> => {
  const clientId = getClientId(req);
  const id = reportIdParam.safeParse(req.params.id);
  if (!clientId) {
    res.status(400).json({ error: "Select a client to review feedback." });
    return;
  }
  if (!id.success) {
    res.status(400).json({ error: "Invalid feedback report." });
    return;
  }
  const report = await db.execute(sql`
    SELECT 1 FROM feedback_reports WHERE id = ${id.data} AND client_id = ${clientId}
  `);
  if (report.rows.length === 0) {
    res.status(404).json({ error: "Feedback report not found." });
    return;
  }
  const result = await db.execute(sql`
    SELECT r.id, r.report_id AS "reportId", r.revision, r.actor_id AS "actorId",
      (SELECT u.name FROM users u WHERE u.id = r.actor_id) AS "actorName",
      r.previous_status AS "previousStatus", r.status,
      r.previous_internal_note AS "previousInternalNote", r.internal_note AS "internalNote",
      r.created_at AS "createdAt"
    FROM feedback_report_reviews r
    WHERE r.report_id = ${id.data} AND r.client_id = ${clientId}
    ORDER BY r.revision DESC, r.id DESC
  `);
  res.json(result.rows);
});

type LockedReport = { id: number; status: string; internalNote: string; revision: number };
type UpdateOutcome =
  | { kind: "missing" }
  | { kind: "conflict"; report: Record<string, unknown> }
  | { kind: "saved"; report: Record<string, unknown> };

router.patch("/feedback/:id", requireAuth, denyViewers, requireClientAdmin, async (req, res): Promise<void> => {
  const clientId = getClientId(req);
  const id = reportIdParam.safeParse(req.params.id);
  const parsed = UpdateFeedbackReportBody.strict()
    .refine(body => Number.isInteger(body.expectedRevision) && body.expectedRevision <= 2147483647)
    .safeParse(req.body);
  if (!clientId) {
    res.status(400).json({ error: "Select a client to review feedback." });
    return;
  }
  if (!id.success || !parsed.success
      || (parsed.data.status === undefined && parsed.data.internalNote === undefined)) {
    res.status(400).json({
      error: "Provide the report revision you edited and a valid status or an internal note of at most 5000 characters.",
    });
    return;
  }
  const { status, internalNote, expectedRevision } = parsed.data;
  const actorId = req.currentUser!.id;
  // Lock the report, compare revisions, update it and append its history in
  // one transaction: a stale draft never writes, and an accepted change is
  // never stored without its history entry (or vice versa).
  const outcome = await db.transaction(async (tx): Promise<UpdateOutcome> => {
    const locked = await tx.execute(sql`
      SELECT f.id, f.status, f.internal_note AS "internalNote", f.revision
      FROM feedback_reports f
      WHERE f.id = ${id.data} AND f.client_id = ${clientId}
      FOR UPDATE OF f
    `);
    const current = locked.rows[0] as LockedReport | undefined;
    if (!current) return { kind: "missing" };
    const readReport = async () => (await tx.execute(sql`
      SELECT ${reportColumns} FROM feedback_reports f WHERE f.id = ${current.id}
    `)).rows[0] as Record<string, unknown>;
    if (current.revision !== expectedRevision) return { kind: "conflict", report: await readReport() };
    const nextStatus = status ?? current.status;
    const nextNote = internalNote ?? current.internalNote;
    // Re-saving identical values is accepted without a new revision or entry.
    if (nextStatus === current.status && nextNote === current.internalNote) {
      return { kind: "saved", report: await readReport() };
    }
    const nextRevision = current.revision + 1;
    await tx.execute(sql`
      UPDATE feedback_reports SET
        status = ${nextStatus}, internal_note = ${nextNote},
        updated_by = ${actorId}, updated_at = now(), revision = ${nextRevision}
      WHERE id = ${current.id} AND client_id = ${clientId} AND revision = ${current.revision}
    `);
    await tx.execute(sql`
      INSERT INTO feedback_report_reviews
        (report_id, client_id, revision, actor_id, previous_status, status, previous_internal_note, internal_note)
      VALUES
        (${current.id}, ${clientId}, ${nextRevision}, ${actorId}, ${current.status}, ${nextStatus},
         ${current.internalNote}, ${nextNote})
    `);
    return { kind: "saved", report: await readReport() };
  });
  if (outcome.kind === "missing") {
    res.status(404).json({ error: "Feedback report not found." });
    return;
  }
  if (outcome.kind === "conflict") {
    res.status(409).json({
      error: "Another manager saved this report after you opened it. Your draft has not been saved.",
      report: outcome.report,
    });
    return;
  }
  res.json(outcome.report);
});

const feedbackSchema = z.object({
  category: z.enum(["feedback", "bug", "feature"]),
  summary: z.string().trim().min(3).max(160),
  details: z.string().trim().min(10).max(5000),
  pagePath: z.string().trim().max(500).optional().nullable(),
  appVersion: z.string().trim().max(64).optional().nullable(),
  // Staging path from POST /feedback/screenshot/request-upload.
  screenshot: z.object({
    objectPath: z.string().min(1).max(1000),
    fileName: z.string().trim().max(200).optional().nullable(),
  }).optional().nullable(),
});

// Anyone signed in may attach a screenshot to feedback, Viewers included
// (see middleware/viewerScope). The image is verified when the report is sent.
router.post("/feedback/screenshot/request-upload", requireAuth, async (req, res): Promise<void> => {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = z.object({ contentType: z.string().max(100) }).safeParse(req.body);
  const contentType = parsed.success ? parsed.data.contentType.toLowerCase() : "";
  if (!SCREENSHOT_TYPES.has(contentType as AllowedUploadType)) {
    res.status(400).json({ error: "Attach the screenshot as a PNG, JPEG or WebP image." });
    return;
  }
  try {
    await ensureUploadCapacity(clientId, req.log);
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId, contentType);
    res.json({ uploadUrl, objectPath: storage.normalizeObjectEntityPath(uploadUrl) });
  } catch (err) {
    respondObjectStorageUnavailable(req, res, err, "feedback screenshot upload");
  }
});

/**
 * Verifies a staged screenshot and copies it to a tenant-owned key. Sends the
 * error response and returns null on failure.
 */
async function finalizeScreenshot(
  req: Request, res: Response, clientId: number, objectPath: string,
): Promise<string | null> {
  try {
    return (await storage.finalizeVerifiedTenantUpload(objectPath, clientId, SCREENSHOT_TYPES)).objectPath;
  } catch (err) {
    await storage.discardTenantUpload(objectPath, clientId).catch(() => {});
    if (!(err instanceof ObjectNotFoundError || err instanceof ObjectOwnershipError
      || err instanceof ObjectContentError || err instanceof ObjectGenerationError)) {
      req.log.error({ err }, "Could not finalise feedback screenshot");
      res.status(503).json({ error: "The screenshot could not be saved just now. Remove it and send your feedback without it, or try again later." });
      return null;
    }
    const error = err instanceof ObjectNotFoundError ? "The screenshot upload was not found. Please attach it again."
      : err instanceof ObjectContentError ? "The screenshot must be a PNG, JPEG or WebP image of at most 10 MB."
      : err.message;
    res.status(err instanceof ObjectNotFoundError ? 404
      : err instanceof ObjectContentError ? 400
      : err instanceof ObjectGenerationError ? 409 : 403).json({ error });
    return null;
  }
}

router.post("/feedback", requireAuth, async (req, res): Promise<void> => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please check the feedback form and try again." });
    return;
  }

  const clientId = getClientId(req);
  const user = req.currentUser;
  if (!clientId || !user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const { category, summary, details, pagePath, screenshot } = parsed.data;
  const appVersion = parsed.data.appVersion || null;
  let screenshotPath: string | null = null;
  if (screenshot) {
    screenshotPath = await finalizeScreenshot(req, res, clientId, screenshot.objectPath);
    if (!screenshotPath) return;
  }
  const screenshotName = screenshotPath ? (screenshot?.fileName || "screenshot") : null;
  const inserted = await db.execute(sql`
    INSERT INTO feedback_reports
      (client_id, user_id, category, summary, details, page_path, email_status,
       screenshot_object_path, screenshot_file_name, app_version)
    VALUES
      (${clientId}, ${user.id}, ${category}, ${summary}, ${details}, ${pagePath ?? null}, 'pending',
       ${screenshotPath}, ${screenshotName}, ${appVersion})
    RETURNING id
  `);
  const reportId = Number((inserted.rows[0] as { id: number }).id);

  let emailSent = false;
  const recipient = process.env.FEEDBACK_RECIPIENT_EMAIL;
  if (recipient) {
    try {
      const clientResult = await db.execute(sql`SELECT name FROM clients WHERE id = ${clientId} LIMIT 1`);
      const clientName = (clientResult.rows[0] as { name?: string } | undefined)?.name ?? `Client ${clientId}`;
      const label = category === "bug" ? "Issue report" : category === "feature" ? "Feature request" : "Feedback";
      // The screenshot stays in ComplyTrack (it can show business records);
      // the email only says there is one and where to see it.
      const inboxUrl = `${getPublicAppUrl().replace(/\/+$/, "")}/feedback?view=all`;
      const screenshotLine = screenshotPath ? "Yes, open the Feedback inbox in ComplyTrack to see it" : "None";
      await sendSystemEmail({
        to: recipient,
        subject: `[ComplyTrack ${label}] ${summary}`,
        text: `${label}\n\nClient: ${clientName}\nSubmitted by: ${user.name} (${user.email})\nPage: ${pagePath ?? "Not supplied"}\nApp version: ${appVersion ?? "Not supplied"}\nScreenshot: ${screenshotLine}\n\n${details}\n\nFeedback inbox: ${inboxUrl}`,
        html: `
          <h2>${escapeHtml(label)}</h2>
          <p><strong>Client:</strong> ${escapeHtml(clientName)}</p>
          <p><strong>Submitted by:</strong> ${escapeHtml(user.name)} (${escapeHtml(user.email)})</p>
          <p><strong>Page:</strong> ${escapeHtml(pagePath ?? "Not supplied")}</p>
          <p><strong>App version:</strong> ${escapeHtml(appVersion ?? "Not supplied")}</p>
          <p><strong>Screenshot:</strong> ${escapeHtml(screenshotLine)}</p>
          <h3>${escapeHtml(summary)}</h3>
          <p style="white-space:pre-wrap">${escapeHtml(details)}</p>
          <p><a href="${escapeHtml(inboxUrl)}">Open the Feedback inbox</a></p>
        `,
        idempotencyKey: `feedback-report-${reportId}`,
      });
      emailSent = true;
      await db.execute(sql`UPDATE feedback_reports SET email_status = 'sent' WHERE id = ${reportId}`);
    } catch (err) {
      req.log.error({ err, reportId }, "Feedback saved but support email failed");
      await db.execute(sql`UPDATE feedback_reports SET email_status = 'failed' WHERE id = ${reportId}`);
    }
  } else {
    req.log.warn({ reportId }, "Feedback saved without email because FEEDBACK_RECIPIENT_EMAIL is not configured");
    await db.execute(sql`UPDATE feedback_reports SET email_status = 'not_configured' WHERE id = ${reportId}`);
  }

  res.status(201).json({ id: reportId, emailSent });
});

export default router;