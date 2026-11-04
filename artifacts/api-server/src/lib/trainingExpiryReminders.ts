/**
 * Daily staff-training-expiry reminder job (TrainTrack).
 *
 * For each active client, alerts the client's managers (client_admin users and
 * maintenance managers) when a staff training certificate:
 *   - expires within 30 days, or
 *   - has already expired.
 *
 * Sends an email digest (Resend-based, mirroring contractorComplianceReminders)
 * plus a best-effort mobile push (route hint /train-track).
 *
 * De-duplication: one row per (client, record, milestone) in
 * training_expiry_reminder_log. The milestone encodes the exact expiry date the
 * reminder was raised against (e.g. "expiry:2025-03-01"), so a renewed
 * certificate (new expiry date) produces a new milestone and re-alerts, while
 * the same milestone is never re-sent. Each client is claimed with an expiring
 * delivery lease (lib/emailDeliveryClaims.ts) so concurrent runs can't
 * double-send; the log rows are written only after the provider accepted the
 * email, so a crash mid-send is retried (same idempotency key) after the lease
 * expires instead of being suppressed forever.
 *
 * Mirrors the EXACT structure of contractorComplianceReminders.ts.
 */

import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl, renderEmailLayout } from "./email";
import { sendPushToUsers } from "./pushNotifications";
import { getNotificationEmails } from "./getNotificationEmails";
import { claimEmailDelivery, emailDeliveryIdempotencyKey, settleEmailDelivery } from "./emailDeliveryClaims";
import { createHash } from "crypto";

/** Certificates are flagged when they expire within this many days (or have expired). */
export const TRAINING_LEAD_DAYS = 30;

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** A single training-expiry issue found for one record. */
export interface TrainingExpiryAlert {
  recordId: number;
  staffName: string;
  trainingType: string | null;
  documentTitle: string | null;
  siteName: string | null;
  /** Stable milestone key for dedupe, e.g. "expiry:2025-03-01". */
  milestone: string;
  /** Human-readable detail line for the email/push. */
  detail: string;
}

interface TrainingRow {
  id: number;
  staff_name: string;
  training_type: string | null;
  document_title: string | null;
  expiry_date: string | null;
  site_name: string | null;
}

/** Compute the training-expiry alerts due for a client's records right now. */
export async function getTrainingExpiryAlerts(
  clientId: number,
  now: Date,
): Promise<TrainingExpiryAlert[]> {
  const result = await db.execute(sql`
    SELECT r.id, r.staff_name, r.training_type, r.document_title, r.expiry_date,
           s.name AS site_name
    FROM train_track_records r
    LEFT JOIN sites s ON s.id = r.site_id
    WHERE r.client_id = ${clientId}
      AND r.expiry_date IS NOT NULL
    ORDER BY r.expiry_date ASC
  `);
  const rows = (result.rows ?? []) as unknown as TrainingRow[];

  const threshold = new Date(now.getTime() + TRAINING_LEAD_DAYS * 24 * 60 * 60 * 1000);

  const alerts: TrainingExpiryAlert[] = [];

  for (const r of rows) {
    if (!r.expiry_date) continue;
    const expiry = new Date(r.expiry_date);
    if (Number.isNaN(expiry.getTime()) || expiry > threshold) continue;

    const expired = expiry < now;
    const milestone = `expiry:${expiry.toISOString().slice(0, 10)}`;
    const label = r.training_type || r.document_title || "Training certificate";
    const detail = expired
      ? `${label} expired on ${fmtDate(expiry)}`
      : `${label} expires on ${fmtDate(expiry)}`;
    alerts.push({
      recordId: r.id,
      staffName: r.staff_name,
      trainingType: r.training_type,
      documentTitle: r.document_title,
      siteName: r.site_name,
      milestone,
      detail,
    });
  }

  return alerts;
}

function buildEmailHtml(alerts: TrainingExpiryAlert[], appUrl: string): string {
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(a.staffName)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            ${a.siteName ? `${esc(a.siteName)} · ` : ""}${esc(a.trainingType || a.documentTitle || "Training")}
          </div>
          <div style="font-size:12px;color:#b91c1c;margin-top:4px;">${esc(a.detail)}</div>
        </td>
      </tr>`,
    )
    .join("");

  return renderEmailLayout({
    subtitle: `Staff training certificates expiring`,
    footerNote: `You are receiving this as an account manager.`,
    bodyHtml: `
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${alerts.length} staff training certificate${alerts.length !== 1 ? "s need" : " needs"} attention — ${alerts.length !== 1 ? "they are" : "it is"} expiring soon or already expired. Please arrange re-training or update the records in TrainTrack.
      </p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;">
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:28px;text-align:center;">
        <a href="${appUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:700;">
          Open ComplyTrack →
        </a>
      </div>
`,
  });
}

export interface TrainingExpiryJobResult {
  clientsChecked: number;
  clientsAlerted: number;
  emailsSent: number;
  remindersClaimed: number;
  errors: number;
}

type EmailSender = typeof sendEmail;

export async function runTrainingExpiryReminderJob(
  send: EmailSender = sendEmail,
): Promise<TrainingExpiryJobResult> {
  const result: TrainingExpiryJobResult = {
    clientsChecked: 0,
    clientsAlerted: 0,
    emailsSent: 0,
    remindersClaimed: 0,
    errors: 0,
  };
  const appUrl = getPublicAppUrl();
  const now = new Date();

  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.active, true));

  for (const client of clients) {
    result.clientsChecked++;
    try {
      const candidates = await getTrainingExpiryAlerts(client.id, now);
      if (candidates.length === 0) continue;

      // Lease the client's delivery, then keep only alerts no earlier run
      // has logged. Log rows are written only after the provider accepted the
      // email; a crash in between leaves the lease to expire and be retried.
      const lease = await claimEmailDelivery("training-expiry", String(client.id));
      if (!lease) continue; // another worker is sending for this client
      let settled = false;
      try {
        const logged = await db.execute(sql`
          SELECT record_id, milestone FROM training_expiry_reminder_log WHERE client_id = ${client.id}
        `);
        const seen = new Set(((logged as any).rows ?? []).map((row: any) => `${row.record_id}|${row.milestone}`));
        const claimed = candidates.filter((alert) => !seen.has(`${alert.recordId}|${alert.milestone}`));
        if (claimed.length === 0) continue;
        result.remindersClaimed += claimed.length;

        // Resolve notification recipients (client-level email or admin users).
        const { emails, userIds } = await getNotificationEmails(client.id, { includeMaintenanceManagers: true });

        if (emails.length === 0) {
          // No one to notify — nothing is logged, so a later run (once
          // managers exist) sends it.
          continue;
        }

        const subject = `⚠️ ${claimed.length} staff training certificate${claimed.length !== 1 ? "s" : ""} expiring — ComplyTrack`;
        const alertSet = createHash("sha256")
          .update(claimed.map((alert) => `${alert.recordId}|${alert.milestone}`).sort().join(","))
          .digest("hex").slice(0, 16);
        await send({
          to: emails,
          subject,
          html: buildEmailHtml(claimed, appUrl),
          idempotencyKey: emailDeliveryIdempotencyKey(lease, `${alertSet}:${now.toISOString().slice(0, 10)}`),
        });

        await db.transaction(async (tx) => {
          for (const alert of claimed) {
            await tx.execute(sql`
              INSERT INTO training_expiry_reminder_log (client_id, record_id, milestone, sent_at)
              VALUES (${client.id}, ${alert.recordId}, ${alert.milestone}, now())
              ON CONFLICT (client_id, record_id, milestone) DO NOTHING
            `);
          }
          await settleEmailDelivery(lease, tx);
        });
        settled = true;

        // Push managers a matching alert (best-effort; never blocks the job).
        await sendPushToUsers(userIds, {
          title: "Staff training expiring",
          body: `${claimed.length} staff training certificate${claimed.length !== 1 ? "s" : ""} expiring soon or expired.`,
          data: { route: "/train-track" },
        }).catch((err) => logger.warn({ err, clientId: client.id }, "Training expiry push failed"));

        result.clientsAlerted++;
        result.emailsSent += emails.length;
        logger.info(
          { clientId: client.id, alerts: claimed.length, emails: emails.length },
          "Training expiry reminder sent",
        );
      } finally {
        if (!settled) await settleEmailDelivery(lease).catch(() => {});
      }
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Training expiry reminder failed");
    }
  }

  return result;
}
