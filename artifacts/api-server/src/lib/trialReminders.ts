import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { sendSystemEmail, getPublicAppUrl } from "./email";
import { logger } from "./logger";

const REMINDER_LEAD_DAYS = 3;

function daysUntil(date: Date): number {
  return Math.max(1, Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

function buildTrialReminderEmail(opts: {
  recipientName: string;
  companyName: string;
  trialEndsAt: Date;
  appUrl: string;
}) {
  const endDateStr = opts.trialEndsAt.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const daysLeft = daysUntil(opts.trialEndsAt);
  const daysPhrase = `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  const subject = `Your ComplyTrack free trial ends in ${daysPhrase}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Your free trial ends soon</h2>
      <p>Hi ${opts.recipientName},</p>
      <p>The ComplyTrack free trial for <strong>${opts.companyName}</strong> ends in <strong>${daysPhrase}</strong>, on <strong>${endDateStr}</strong>.</p>
      <div style="background: #f1f5f9; border-left: 4px solid #6366f1; padding: 16px; margin: 16px 0;">
        <p style="margin: 0; color: #1e293b;">To keep your compliance tracking, reminders, and contractor records running without interruption, choose a plan before your trial ends.</p>
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${opts.appUrl}" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Choose a plan</a>
      </div>
      <p style="color: #64748b; font-size: 14px;">If you have any questions about plans or pricing, just reply to this email.</p>
      <p>Best regards,<br><strong>ComplyTrack</strong></p>
    </div>
  `;

  const text = `
Your free trial ends soon

Hi ${opts.recipientName},

The ComplyTrack free trial for ${opts.companyName} ends in ${daysPhrase}, on ${endDateStr}.

To keep your compliance tracking, reminders, and contractor records running without interruption, choose a plan before your trial ends:
${opts.appUrl}

Best regards,
ComplyTrack
  `.trim();

  return { html, text, subject };
}

/**
 * Send a one-time trial-expiry warning email to every active admin of each
 * trial client whose trial ends within the next 3 days. The window is a broad
 * band (not an exact 3-day slot) so trials created with <3 days left, or runs
 * delayed by downtime, are never missed; the email wording always reflects the
 * actual days remaining. Deduped via
 * clients.trial_reminder_sent_at, which is claimed atomically BEFORE sending
 * so concurrent runs can never double-email; if every send then fails, the
 * marker is released so the next run retries.
 */
export async function runTrialReminderJob(): Promise<{
  clientsNotified: number;
  emailsSent: number;
}> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select()
    .from(clientsTable)
    .where(
      and(
        eq(clientsTable.active, true),
        eq(clientsTable.subscriptionStatus, "trial"),
        sql`${clientsTable.trialEndsAt} IS NOT NULL`,
        sql`${clientsTable.trialEndsAt} > ${now}`,
        sql`${clientsTable.trialEndsAt} <= ${windowEnd}`,
        sql`${clientsTable.trialReminderSentAt} IS NULL`,
      ),
    );

  let clientsNotified = 0;
  let emailsSent = 0;

  for (const client of candidates) {
    // Atomic claim: only one worker/run may send for this client.
    const claim = await db.execute(sql`
      UPDATE clients
      SET trial_reminder_sent_at = now()
      WHERE id = ${client.id} AND trial_reminder_sent_at IS NULL
      RETURNING id
    `);
    if ((claim.rows ?? []).length === 0) continue;

    const admins = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.clientId, client.id),
          eq(usersTable.role, "client_admin"),
          eq(usersTable.active, true),
        ),
      );

    if (admins.length === 0) {
      logger.warn({ clientId: client.id }, "Trial reminder: no active admins to email");
      continue;
    }

    let sentForClient = 0;
    for (const admin of admins) {
      try {
        const { html, text, subject } = buildTrialReminderEmail({
          recipientName: admin.name,
          companyName: client.name,
          trialEndsAt: client.trialEndsAt!,
          appUrl: getPublicAppUrl(),
        });
        await sendSystemEmail({
          to: admin.email,
          subject,
          html,
          text,
        });
        sentForClient++;
      } catch (err) {
        logger.error(
          { err, clientId: client.id, userId: admin.id },
          "Trial reminder email failed",
        );
      }
    }

    if (sentForClient === 0) {
      // Nothing went out (e.g. email provider down) — release the claim so
      // tomorrow's run retries instead of silently skipping the client.
      await db.execute(sql`
        UPDATE clients SET trial_reminder_sent_at = NULL WHERE id = ${client.id}
      `);
      continue;
    }

    clientsNotified++;
    emailsSent += sentForClient;
    logger.info(
      { clientId: client.id, emails: sentForClient },
      "Trial expiry reminder sent",
    );
  }

  return { clientsNotified, emailsSent };
}
