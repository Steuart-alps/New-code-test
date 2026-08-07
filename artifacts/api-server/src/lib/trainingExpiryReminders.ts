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
 * the same milestone is never re-sent. Rows are claimed BEFORE sending so
 * concurrent runs can't double-send; the claim is released if the send fails.
 *
 * Mirrors the EXACT structure of contractorComplianceReminders.ts.
 */

import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { sendPushToUsers } from "./pushNotifications";

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

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:#0f172a;padding:32px 40px;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">🛡️ ComplyTrack</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Staff training certificates expiring</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${alerts.length} staff training certificate${alerts.length !== 1 ? "s need" : " needs"} attention — ${alerts.length !== 1 ? "they are" : "it is"} expiring soon or already expired. Please arrange re-training or update the records in TrainTrack.
      </p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;">
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:28px;text-align:center;">
        <a href="${appUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
          Open ComplyTrack →
        </a>
      </div>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;text-align:center;">
      ComplyTrack by ALPS Consulting · You are receiving this as an account manager.
    </div>
  </div>
</body>
</html>`;
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

      // Claim each (record, milestone) first so we never re-send the same
      // reminder, and so concurrent runs can't double-send. Only the newly
      // claimed alerts are then emailed/pushed.
      const claimed: TrainingExpiryAlert[] = [];
      // Any failure after the first successful claim (a later claim insert, the
      // manager lookup, or the email send) must release every claimed row —
      // otherwise the unique dedupe rows would permanently suppress the alert.
      let sent = false;
      try {
        for (const alert of candidates) {
          const claim = await db.execute(sql`
            INSERT INTO training_expiry_reminder_log (client_id, record_id, milestone, sent_at)
            VALUES (${client.id}, ${alert.recordId}, ${alert.milestone}, now())
            ON CONFLICT (client_id, record_id, milestone) DO NOTHING
            RETURNING id
          `);
          if (((claim as any).rows ?? []).length > 0) claimed.push(alert);
        }
        if (claimed.length === 0) continue;
        result.remindersClaimed += claimed.length;

        // Managers: client_admin users OR maintenance managers.
        const managers = await db
          .select({ id: usersTable.id, email: usersTable.email })
          .from(usersTable)
          .where(and(
            eq(usersTable.clientId, client.id),
            eq(usersTable.active, true),
            or(eq(usersTable.role, "client_admin"), eq(usersTable.isMaintenanceManager, true)),
          ))
          .limit(30);
        const emails = [...new Set(managers.map((m) => m.email).filter(Boolean) as string[])];
        const userIds = [...new Set(managers.map((m) => m.id))];

        if (emails.length === 0) {
          // No one to notify — release the claims so a later run (once managers
          // exist) can re-send.
          await releaseClaims(client.id, claimed);
          continue;
        }

        const subject = `⚠️ ${claimed.length} staff training certificate${claimed.length !== 1 ? "s" : ""} expiring — ComplyTrack`;
        await send({ to: emails, subject, html: buildEmailHtml(claimed, appUrl) });
        sent = true;

        // Push managers a matching alert (best-effort; never blocks the job).
        await sendPushToUsers(userIds, {
          title: "Staff training expiring",
          body: `${claimed.length} staff training certificate${claimed.length !== 1 ? "s" : ""} expiring soon or expired.`,
          data: { route: "/train-track" },
        });

        result.clientsAlerted++;
        result.emailsSent += emails.length;
        logger.info(
          { clientId: client.id, alerts: claimed.length, emails: emails.length },
          "Training expiry reminder sent",
        );
      } catch (innerErr) {
        if (!sent && claimed.length > 0) {
          try {
            await releaseClaims(client.id, claimed);
          } catch (releaseErr) {
            logger.error(
              { err: releaseErr, clientId: client.id },
              "Failed to release training expiry claims — these milestones may be suppressed",
            );
          }
        }
        throw innerErr;
      }
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Training expiry reminder failed");
    }
  }

  return result;
}

/** Release previously-claimed reminder rows so a later run retries. */
async function releaseClaims(clientId: number, alerts: TrainingExpiryAlert[]): Promise<void> {
  for (const a of alerts) {
    await db.execute(sql`
      DELETE FROM training_expiry_reminder_log
      WHERE client_id = ${clientId} AND record_id = ${a.recordId} AND milestone = ${a.milestone}
    `);
  }
}
