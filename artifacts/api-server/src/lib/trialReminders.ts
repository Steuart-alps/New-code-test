import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl, escapeHtml } from "./email";
import { countClientSites, getPerSitePrice, quantityForSiteCount } from "./billing";

/**
 * How many days before trial end the reminder fires.
 * 14-day trial → reminder sent on day 10 (≤4 days remaining).
 */
export const TRIAL_REMINDER_LEAD_DAYS = 4;

function daysUntil(date: Date): number {
  return Math.max(1, Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

function buildTrialReminderEmail(opts: {
  recipientName: string;
  companyName: string;
  trialEndsAt: Date;
  siteCount: number;
  monthlyTotal: string | null;
  billingUrl: string;
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

  const priceLine = opts.monthlyTotal
    ? `Based on your current ${opts.siteCount} site${opts.siteCount === 1 ? "" : "s"}, your subscription would be £${opts.monthlyTotal} per month.`
    : "Pricing is per site, per month.";

  const safeRecipientName = escapeHtml(opts.recipientName);
  const safeCompanyName   = escapeHtml(opts.companyName);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Your free trial is ending soon</h2>
      <p>Hi ${safeRecipientName},</p>
      <p>The free trial for <strong>${safeCompanyName}</strong> ends in <strong>${daysPhrase}</strong>, on <strong>${endDateStr}</strong>.</p>
      <p>${priceLine}</p>
      <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
        <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">Subscribe now to keep your compliance tracking, reminders and certificates running without interruption.</p>
        <a href="${opts.billingUrl}" style="display: inline-block; background: #4f46e5; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Set Up Billing</a>
      </div>
      <p>Best regards,<br><strong>ComplyTrack</strong></p>
    </div>
  `;

  const text = `
Your free trial is ending soon

Hi ${opts.recipientName},

The free trial for ${opts.companyName} ends in ${daysPhrase}, on ${endDateStr}.

${priceLine}

Subscribe here to keep everything running without interruption:
${opts.billingUrl}

Best regards,
ComplyTrack
  `.trim();

  return { html, text, subject };
}

/**
 * Send a one-time trial-expiry warning email to every active consultant of each
 * trial client whose trial ends within the next 3 days. The window is a broad
 * band (not an exact 3-day slot) so trials created with <3 days left, or runs
 * delayed by downtime, are never missed; the email wording always reflects the
 * actual days remaining. Deduped via
 * clients.trial_reminder_sent_at, which is claimed atomically BEFORE sending
 * so concurrent runs can never double-email; if every send then fails, the
 * marker is released so the next run retries.
 */
export async function runTrialReminderJob(
  deps: {
    sendEmail?: typeof sendSystemEmail;
  } = {},
): Promise<{
  clientsNotified: number;
  emailsSent: number;
}> {
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  const now = new Date();
  const windowEnd = new Date(now.getTime() + TRIAL_REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select()
    .from(clientsTable)
    .where(
      and(
        eq(clientsTable.active, true),
        sql`${clientsTable.subscriptionStatus} IN ('trial', 'trialing')`,
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

    const consultants = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.clientId, client.id),
          eq(usersTable.role, "consultant"),
          eq(usersTable.active, true),
        ),
      );

    if (consultants.length === 0) {
      logger.warn({ clientId: client.id }, "Trial reminder: no active consultants to email");
      continue;
    }

    // Show what they'd pay so the email doubles as a clear billing preview.
    const siteCount = await countClientSites(client.id);
    const perSite = await getPerSitePrice();
    const quantity = quantityForSiteCount(siteCount);
    const monthlyTotal = perSite
      ? ((perSite.unitAmount * quantity) / 100).toFixed(2)
      : null;

    let sentForClient = 0;
    for (const consultant of consultants) {
      try {
        const { html, text, subject } = buildTrialReminderEmail({
          recipientName: consultant.name,
          companyName: client.name,
          trialEndsAt: client.trialEndsAt!,
          siteCount,
          monthlyTotal,
          billingUrl: `${getPublicAppUrl()}/billing`,
        });
        await sendEmail({
          to: consultant.email,
          subject,
          html,
          text,
        });
        sentForClient++;
      } catch (err) {
        logger.error(
          { err, clientId: client.id, userId: consultant.id },
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
