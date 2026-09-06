import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { escapeHtml, sendSystemEmail } from "../lib/email";

const router: IRouter = Router();

const feedbackSchema = z.object({
  category: z.enum(["feedback", "bug", "feature"]),
  summary: z.string().trim().min(3).max(160),
  details: z.string().trim().min(10).max(5000),
  pagePath: z.string().trim().max(500).optional().nullable(),
});

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

  const { category, summary, details, pagePath } = parsed.data;
  const inserted = await db.execute(sql`
    INSERT INTO feedback_reports
      (client_id, user_id, category, summary, details, page_path, email_status)
    VALUES
      (${clientId}, ${user.id}, ${category}, ${summary}, ${details}, ${pagePath ?? null}, 'pending')
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
      await sendSystemEmail({
        to: recipient,
        subject: `[ComplyTrack ${label}] ${summary}`,
        text: `${label}\n\nClient: ${clientName}\nSubmitted by: ${user.name} (${user.email})\nPage: ${pagePath ?? "Not supplied"}\n\n${details}`,
        html: `
          <h2>${escapeHtml(label)}</h2>
          <p><strong>Client:</strong> ${escapeHtml(clientName)}</p>
          <p><strong>Submitted by:</strong> ${escapeHtml(user.name)} (${escapeHtml(user.email)})</p>
          <p><strong>Page:</strong> ${escapeHtml(pagePath ?? "Not supplied")}</p>
          <h3>${escapeHtml(summary)}</h3>
          <p style="white-space:pre-wrap">${escapeHtml(details)}</p>
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