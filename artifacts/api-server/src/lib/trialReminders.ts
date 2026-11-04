import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl, escapeHtml } from "./email";
import { countClientSites, findLiveSubscription, getPerSitePrice, quantityForSiteCount } from "./billing";
import { sendPushToUsers } from "./pushNotifications";
import { BUNDLE_KEY, BUNDLE_LABEL, COMING_SOON_SERVICE_KEYS, SERVICES, SERVICE_CAP_PENCE, type ServiceKey } from "./services";
import { claimEmailDelivery, emailDeliveryIdempotencyKey, settleEmailDelivery } from "./emailDeliveryClaims";

/**
 * How many days before trial end the reminder fires.
 * 14-day trial → reminder sent on day 7 (one week remaining).
 */
export const TRIAL_REMINDER_LEAD_DAYS = 7;

function daysUntil(date: Date): number {
  return Math.max(1, Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

/**
 * What the client would pay per month for the modules it chose at signup
 * (ComplyTrack core plus each selected add-on, or the bundle), capped at the
 * bundle price per site. Null when the core price is not known.
 */
export function quoteSelectedPlan(input: {
  selectedServices: readonly string[] | null;
  coreUnitAmount: number | null;
  siteCount: number;
}): { monthlyTotalPence: number; modules: string[] } | null {
  if (input.coreUnitAmount === null) return null;
  const quantity = quantityForSiteCount(input.siteCount);
  const selected = input.selectedServices ?? [];
  if (selected.includes(BUNDLE_KEY)) {
    return { monthlyTotalPence: SERVICE_CAP_PENCE * quantity, modules: [BUNDLE_LABEL] };
  }
  const addons = [...new Set(selected)].filter((key): key is ServiceKey =>
    key !== "core" && key in SERVICES && !COMING_SOON_SERVICE_KEYS.includes(key));
  const perSite = input.coreUnitAmount + addons.reduce((sum, key) => sum + SERVICES[key].amountPence, 0);
  if (perSite >= SERVICE_CAP_PENCE) {
    return { monthlyTotalPence: SERVICE_CAP_PENCE * quantity, modules: [BUNDLE_LABEL] };
  }
  return {
    monthlyTotalPence: perSite * quantity,
    modules: [SERVICES.core.label, ...addons.map((key) => SERVICES[key].label)],
  };
}

function formatUkDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/London",
  });
}

function buildTrialReminderEmail(opts: {
  recipientName: string;
  companyName: string;
  trialEndsAt: Date;
  siteCount: number;
  monthlyTotal: string | null;
  modules?: string[];
  billingUrl: string;
}) {
  const endDateStr = formatUkDate(opts.trialEndsAt);

  const daysLeft = daysUntil(opts.trialEndsAt);
  const daysPhrase = `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  const subject = `Your ComplyTrack free trial ends in ${daysPhrase}`;

  const modulesPhrase = opts.modules && opts.modules.length > 0 ? ` and the modules you chose (${opts.modules.join(", ")})` : "";
  const priceLine = opts.monthlyTotal
    ? `Based on your current ${opts.siteCount} site${opts.siteCount === 1 ? "" : "s"}${modulesPhrase}, your subscription would be £${opts.monthlyTotal} per month.`
    : "Pricing is per site, per month.";

  const safeRecipientName = escapeHtml(opts.recipientName);
  const safeCompanyName   = escapeHtml(opts.companyName);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Your free trial is ending soon</h2>
      <p>Hi ${safeRecipientName},</p>
      <p>The free trial for <strong>${safeCompanyName}</strong> ends in <strong>${daysPhrase}</strong>, on <strong>${endDateStr}</strong>.</p>
      <p>${escapeHtml(priceLine)}</p>
      <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
        <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">Subscribe now to keep your compliance tracking, reminders and certificates running without interruption.</p>
        <a href="${opts.billingUrl}" style="display: inline-block; background: #2563eb; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Set Up Billing</a>
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

type ClientRow = typeof clientsTable.$inferSelect;

/**
 * A client with a live Stripe subscription is a paying customer, whatever its
 * local status says: record that status (so it is not picked again) and skip.
 * A Stripe error skips the client this run (never emails a possible payer).
 */
async function isPayingCustomer(client: ClientRow, findLive: typeof findLiveSubscription): Promise<boolean> {
  if (!client.stripeCustomerId) return false;
  const live = await findLive(client.stripeCustomerId);
  if (!live) return false;
  await db.execute(sql`
    UPDATE clients SET subscription_status = ${live.status}, stripe_subscription_id = ${live.id}, updated_at = now()
    WHERE id = ${client.id}
  `);
  return true;
}

/**
 * The business's own owners: its Owners (client_admin) and, for accounts
 * signed up before sign-up created Owners, its own consultant.
 */
async function activeConsultants(clientId: number) {
  return db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.clientId, clientId),
        inArray(usersTable.role, ["consultant", "client_admin"]),
        eq(usersTable.active, true),
      ),
    );
}

async function quoteForClient(client: ClientRow) {
  const siteCount = await countClientSites(client.id);
  const perSite = await getPerSitePrice();
  const quote = quoteSelectedPlan({
    selectedServices: client.selectedServices ?? null,
    coreUnitAmount: perSite?.unitAmount ?? null,
    siteCount,
  });
  return {
    siteCount,
    monthlyTotal: quote ? (quote.monthlyTotalPence / 100).toFixed(2) : null,
    modules: quote?.modules ?? [],
  };
}

/**
 * Send a one-time trial-expiry warning email to every active consultant of each
 * trial client whose trial ends within the next few days. The window is a broad
 * band (not an exact slot) so trials created with little time left, or runs
 * delayed by downtime, are never missed; the email wording always reflects the
 * actual days remaining.
 *
 * Delivery is restart-safe: each client is claimed with an expiring lease
 * (never a permanent marker before sending). clients.trial_reminder_sent_at is
 * written only after at least one email was accepted; a total send failure
 * releases the lease so the next run retries, and a crash mid-send leaves the
 * lease to expire and the retry reuses the same provider idempotency keys.
 */
export async function runTrialReminderJob(
  deps: {
    sendEmail?: typeof sendSystemEmail;
    findLiveSubscription?: typeof findLiveSubscription;
    /** Optional internal batch scope; omitted by the production scheduler. */
    clientIds?: readonly number[];
  } = {},
): Promise<{
  clientsNotified: number;
  emailsSent: number;
}> {
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  const findLive = deps.findLiveSubscription ?? findLiveSubscription;
  const now = new Date();
  const windowEnd = new Date(now.getTime() + TRIAL_REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000);
  if (deps.clientIds?.length === 0) return { clientsNotified: 0, emailsSent: 0 };

  const candidates = await db
    .select()
    .from(clientsTable)
    .where(
      and(
        deps.clientIds === undefined ? undefined : inArray(clientsTable.id, [...deps.clientIds]),
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
    try {
      const sent = await sendTrialReminderForClient(client, sendEmail, findLive);
      if (sent > 0) {
        clientsNotified++;
        emailsSent += sent;
      }
    } catch (err) {
      // One client's failure must not stop reminders for the rest.
      logger.error({ err, clientId: client.id }, "Trial reminder failed for client");
    }
  }

  return { clientsNotified, emailsSent };
}

async function sendTrialReminderForClient(
  client: ClientRow,
  sendEmail: typeof sendSystemEmail,
  findLive: typeof findLiveSubscription,
): Promise<number> {
  try {
    if (await isPayingCustomer(client, findLive)) return 0;
  } catch (err) {
    logger.warn({ err, clientId: client.id }, "Trial reminder: Stripe lookup failed; client skipped this run");
    return 0;
  }

  const claim = await claimEmailDelivery("trial-reminder", `${client.id}:${client.trialEndsAt!.toISOString()}`);
  if (!claim) return 0; // another worker is sending
  let sentForClient = 0;
  try {
    // Another worker may have finished between the candidate read and the claim.
    const [current] = await db.select({ sentAt: clientsTable.trialReminderSentAt })
      .from(clientsTable).where(eq(clientsTable.id, client.id)).limit(1);
    if (current?.sentAt) return 0;

    const consultants = await activeConsultants(client.id);
    if (consultants.length === 0) {
      logger.warn({ clientId: client.id }, "Trial reminder: no active consultants to email");
      return 0;
    }

    // Show what they'd pay for what they chose, so the email doubles as a
    // clear billing preview.
    const { siteCount, monthlyTotal, modules } = await quoteForClient(client);
    const day = new Date().toISOString().slice(0, 10);

    for (const consultant of consultants) {
      try {
        const { html, text, subject } = buildTrialReminderEmail({
          recipientName: consultant.name,
          companyName: client.name,
          trialEndsAt: client.trialEndsAt!,
          siteCount,
          monthlyTotal,
          modules,
          billingUrl: `${getPublicAppUrl()}/settings#billing`,
        });
        await sendEmail({
          to: consultant.email,
          subject,
          html,
          text,
          // The day is part of the key: the wording counts down daily.
          idempotencyKey: emailDeliveryIdempotencyKey(claim, `${consultant.id}:${day}`),
        });
        sentForClient++;
      } catch (err) {
        logger.error(
          { err, clientId: client.id, userId: consultant.id },
          "Trial reminder email failed",
        );
      }
    }

    if (sentForClient === 0) return 0; // released below; the next run retries

    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE clients SET trial_reminder_sent_at = now() WHERE id = ${client.id}`);
      await settleEmailDelivery(claim, tx);
    });

    // Push consultants a matching alert (best-effort; never blocks the job).
    const daysLeft = daysUntil(client.trialEndsAt!);
    await sendPushToUsers(
      consultants.map((c) => c.id),
      {
        title: "Free trial ending soon",
        body: `Your ComplyTrack trial for ${client.name} ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
        data: { route: "/(tabs)/profile" },
      },
    ).catch((err) => logger.warn({ err, clientId: client.id }, "Trial reminder push failed"));

    logger.info(
      { clientId: client.id, emails: sentForClient },
      "Trial expiry reminder sent",
    );
    return sentForClient;
  } finally {
    if (sentForClient === 0) await settleEmailDelivery(claim).catch(() => {});
  }
}

// ── Trial ended ────────────────────────────────────────────────────────────────

/** Trials that ended longer ago than this are not emailed (e.g. on first deploy). */
const TRIAL_ENDED_EMAIL_WINDOW_DAYS = 7;

function buildTrialEndedEmail(opts: {
  recipientName: string;
  companyName: string;
  trialEndedAt: Date;
  siteCount: number;
  monthlyTotal: string | null;
  modules: string[];
  billingUrl: string;
}) {
  const endDateStr = formatUkDate(opts.trialEndedAt);
  const subject = "Your ComplyTrack free trial has ended";
  const modulesPhrase = opts.modules.length > 0 ? ` and the modules you chose (${opts.modules.join(", ")})` : "";
  const priceLine = opts.monthlyTotal
    ? `Based on your current ${opts.siteCount} site${opts.siteCount === 1 ? "" : "s"}${modulesPhrase}, your subscription would be £${opts.monthlyTotal} per month.`
    : "Pricing is per site, per month.";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Your free trial has ended</h2>
      <p>Hi ${escapeHtml(opts.recipientName)},</p>
      <p>The free trial for <strong>${escapeHtml(opts.companyName)}</strong> ended on <strong>${escapeHtml(endDateStr)}</strong>.
         Your records are safe, but the account is locked until a subscription is set up.</p>
      <p>${escapeHtml(priceLine)}</p>
      <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
        <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">Subscribe to restore access to your compliance tracking, reminders and certificates.</p>
        <a href="${opts.billingUrl}" style="display: inline-block; background: #2563eb; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Subscribe now</a>
      </div>
      <p>Best regards,<br><strong>ComplyTrack</strong></p>
    </div>
  `;
  const text = `
Your free trial has ended

Hi ${opts.recipientName},

The free trial for ${opts.companyName} ended on ${endDateStr}. Your records are safe, but the account is locked until a subscription is set up.

${priceLine}

Subscribe to restore access:
${opts.billingUrl}

Best regards,
ComplyTrack
  `.trim();
  return { html, text, subject };
}

/**
 * One "your trial has ended" email to the consultants of each client whose
 * trial ended in the last week without a subscription. Same restart-safe
 * lease pattern as the reminder; deduped by clients.trial_ended_email_sent_at.
 */
export async function runTrialEndedEmailJob(
  deps: {
    sendEmail?: typeof sendSystemEmail;
    findLiveSubscription?: typeof findLiveSubscription;
    clientIds?: readonly number[];
  } = {},
): Promise<{ clientsNotified: number; emailsSent: number }> {
  const sendEmail = deps.sendEmail ?? sendSystemEmail;
  const findLive = deps.findLiveSubscription ?? findLiveSubscription;
  const now = new Date();
  const windowStart = new Date(now.getTime() - TRIAL_ENDED_EMAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (deps.clientIds?.length === 0) return { clientsNotified: 0, emailsSent: 0 };

  const candidates = await db
    .select()
    .from(clientsTable)
    .where(
      and(
        deps.clientIds === undefined ? undefined : inArray(clientsTable.id, [...deps.clientIds]),
        eq(clientsTable.active, true),
        sql`${clientsTable.subscriptionStatus} IN ('trial', 'trialing')`,
        sql`${clientsTable.trialEndsAt} IS NOT NULL`,
        sql`${clientsTable.trialEndsAt} <= ${now}`,
        sql`${clientsTable.trialEndsAt} > ${windowStart}`,
        sql`${clientsTable.trialEndedEmailSentAt} IS NULL`,
        sql`${clientsTable.dataDeletedAt} IS NULL`,
      ),
    );

  let clientsNotified = 0;
  let emailsSent = 0;
  for (const client of candidates) {
    let claim: Awaited<ReturnType<typeof claimEmailDelivery>> = null;
    let sentForClient = 0;
    try {
      try {
        if (await isPayingCustomer(client, findLive)) continue;
      } catch (err) {
        logger.warn({ err, clientId: client.id }, "Trial-ended email: Stripe lookup failed; client skipped this run");
        continue;
      }
      claim = await claimEmailDelivery("trial-ended", `${client.id}:${client.trialEndsAt!.toISOString()}`);
      if (!claim) continue;
      const [current] = await db.select({ sentAt: clientsTable.trialEndedEmailSentAt })
        .from(clientsTable).where(eq(clientsTable.id, client.id)).limit(1);
      if (current?.sentAt) continue;
      const consultants = await activeConsultants(client.id);
      if (consultants.length === 0) continue;
      const { siteCount, monthlyTotal, modules } = await quoteForClient(client);
      for (const consultant of consultants) {
        try {
          const { html, text, subject } = buildTrialEndedEmail({
            recipientName: consultant.name,
            companyName: client.name,
            trialEndedAt: client.trialEndsAt!,
            siteCount,
            monthlyTotal,
            modules,
            billingUrl: `${getPublicAppUrl()}/settings#billing`,
          });
          await sendEmail({
            to: consultant.email, subject, html, text,
            idempotencyKey: emailDeliveryIdempotencyKey(claim, consultant.id),
          });
          sentForClient++;
        } catch (err) {
          logger.error({ err, clientId: client.id, userId: consultant.id }, "Trial-ended email failed");
        }
      }
      if (sentForClient > 0) {
        const settled = claim;
        await db.transaction(async (tx) => {
          await tx.execute(sql`UPDATE clients SET trial_ended_email_sent_at = now() WHERE id = ${client.id}`);
          await settleEmailDelivery(settled, tx);
        });
        clientsNotified++;
        emailsSent += sentForClient;
      }
    } catch (err) {
      logger.error({ err, clientId: client.id }, "Trial-ended email failed for client");
    } finally {
      if (claim && sentForClient === 0) await settleEmailDelivery(claim).catch(() => {});
    }
  }
  return { clientsNotified, emailsSent };
}
