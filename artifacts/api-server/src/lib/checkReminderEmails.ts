/**
 * Daily check-reminder email job.
 *
 * Runs at 08:45. For each active client that has overdue or due-soon safety
 * checks (fire, legionella, pool), sends one digest email to all active users
 * of that client. Uses check_reminder_log to ensure only one email per client
 * per day.
 */

import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { getCheckAlerts, type CheckAlert } from "./checkReminders";

// ── Email HTML builder ────────────────────────────────────────────────────────

function buildEmailHtml(alerts: CheckAlert[], appUrl: string): string {
  const overdue = alerts.filter(a => a.status === "overdue");
  const dueSoon = alerts.filter(a => a.status === "due_soon");

  const rowHtml = (a: CheckAlert) => {
    const badge = a.status === "overdue"
      ? `<span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">Overdue</span>`
      : `<span style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">Due soon</span>`;
    const when = a.daysUntilDue !== null
      ? a.daysUntilDue < 0
        ? `${Math.abs(a.daysUntilDue)} day${Math.abs(a.daysUntilDue) !== 1 ? "s" : ""} overdue`
        : a.daysUntilDue === 0
        ? "Due today"
        : `Due in ${a.daysUntilDue} day${a.daysUntilDue !== 1 ? "s" : ""}`
      : "";
    const last = a.lastDate
      ? `Last: ${new Date(`${a.lastDate}T00:00:00Z`).toLocaleDateString("en-GB")}`
      : "Never completed";
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${a.checkLabel}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">${a.moduleLabel} · ${a.frequencyLabel} · ${last}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap;">
          ${badge}<br/>
          <span style="font-size:12px;color:#64748b;">${when}</span>
        </td>
      </tr>`;
  };

  const allRows = [...overdue, ...dueSoon].map(rowHtml).join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:#0f172a;padding:32px 40px;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
        🛡️ ComplyTrack
      </div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Safety Check Reminders</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:16px;color:#334155;margin:0 0 8px;">
        ${overdue.length > 0
          ? `<strong>${overdue.length} check${overdue.length !== 1 ? "s are" : " is"} overdue</strong>${dueSoon.length > 0 ? ` and ${dueSoon.length} more ${dueSoon.length !== 1 ? "are" : "is"} due soon` : ""}.`
          : `<strong>${dueSoon.length} check${dueSoon.length !== 1 ? "s are" : " is"} due soon</strong>.`}
      </p>
      <p style="font-size:14px;color:#64748b;margin:0 0 24px;">Please log into ComplyTrack and complete the following checks.</p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Check</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Status</th>
          </tr>
        </thead>
        <tbody>${allRows}</tbody>
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

// ── Job ───────────────────────────────────────────────────────────────────────

export interface CheckReminderJobResult {
  clientsChecked: number;
  clientsEmailed: number;
  emailsSent: number;
  errors: number;
}

export async function runCheckReminderEmailJob(): Promise<CheckReminderJobResult> {
  const result: CheckReminderJobResult = { clientsChecked: 0, clientsEmailed: 0, emailsSent: 0, errors: 0 };

  const todayIso = new Date().toISOString().slice(0, 10);
  const appUrl = getPublicAppUrl();

  // Get all active clients
  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.active, true));

  for (const client of clients) {
    result.clientsChecked++;
    try {
      // Skip if already sent today
      const logged = await db.execute(sql`
        SELECT 1 FROM check_reminder_log
        WHERE client_id = ${client.id} AND log_date = ${todayIso}
        LIMIT 1
      `);
      const rows = (logged as any).rows ?? logged as any[];
      if (rows.length > 0) continue;

      // Get alerts (overdue + due_soon only — skip "never")
      const alerts = await getCheckAlerts(client.id);
      const actionable = alerts.filter(a => a.status === "overdue" || a.status === "due_soon");
      if (actionable.length === 0) continue;

      // Get active users for this client
      const users = await db
        .select({ email: usersTable.email, name: usersTable.name })
        .from(usersTable)
        .where(and(eq(usersTable.clientId, client.id), eq(usersTable.active, true)))
        .limit(20);

      if (users.length === 0) continue;

      const emails = users.map(u => u.email).filter(Boolean) as string[];
      if (emails.length === 0) continue;

      const html = buildEmailHtml(actionable, appUrl);
      const overdueCount = actionable.filter(a => a.status === "overdue").length;
      const subject = overdueCount > 0
        ? `⚠️ ${overdueCount} safety check${overdueCount !== 1 ? "s" : ""} overdue — ComplyTrack`
        : `📋 Safety checks due today — ComplyTrack`;

      await sendEmail({ to: emails, subject, html });

      // Log the send
      await db.execute(sql`
        INSERT INTO check_reminder_log (client_id, log_date, sent_at)
        VALUES (${client.id}, ${todayIso}, now())
        ON CONFLICT (client_id, log_date) DO NOTHING
      `);

      result.clientsEmailed++;
      result.emailsSent += emails.length;
      logger.info({ clientId: client.id, alerts: actionable.length, emails: emails.length }, "Check reminder email sent");
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Check reminder email failed");
    }
  }

  return result;
}
