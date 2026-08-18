/**
 * Weekly contractor public-liability-insurance expiry reminder job (Task #97).
 *
 * Runs every Monday at 09:00. For each active client, finds contractors whose
 * public_liability_expiry is within the next 30 days or has already expired and
 * sends a digest email to the client's admin users listing which contractors need
 * attention.
 *
 * Mirrors the structure of contractorComplianceReminders.ts / trainingExpiryReminders.ts.
 */

import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl } from "./email";
import { getNotificationEmails } from "./getNotificationEmails";

/** Insurance is flagged when it expires within this many days (or has already expired). */
const LEAD_DAYS = 30;

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

interface ContractorInsuranceRow {
  id: number;
  name: string;
  company: string | null;
  email: string;
  public_liability_expiry: string | null;
}

export interface ContractorInsuranceExpiryJobResult {
  clientsChecked: number;
  clientsAlerted: number;
  emailsSent: number;
  errors: number;
}

function buildEmailHtml(
  alerts: Array<{ name: string; company: string | null; expiry: Date; expired: boolean }>,
  appUrl: string,
): string {
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(a.name)}</div>
          ${a.company ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${esc(a.company)}</div>` : ""}
          <div style="font-size:12px;color:#b91c1c;margin-top:4px;">
            ${a.expired ? `Insurance expired on ${fmtDate(a.expiry)}` : `Insurance expires on ${fmtDate(a.expiry)}`}
          </div>
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
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Contractor insurance expiry alert</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${alerts.length} contractor${alerts.length !== 1 ? "s" : ""} ${alerts.length !== 1 ? "have" : "has"} public liability insurance that is expiring soon or has already expired. Please chase renewals or update the records in ComplyTrack.
      </p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;">
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:28px;text-align:center;">
        <a href="${appUrl}/contractors" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
          View Contractors →
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

export async function runContractorInsuranceExpiryReminderJob(): Promise<ContractorInsuranceExpiryJobResult> {
  const result: ContractorInsuranceExpiryJobResult = {
    clientsChecked: 0,
    clientsAlerted: 0,
    emailsSent: 0,
    errors: 0,
  };

  const appUrl = getPublicAppUrl();
  const now = new Date();
  const threshold = new Date(now.getTime() + LEAD_DAYS * 24 * 60 * 60 * 1000);

  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.active, true));

  for (const client of clients) {
    result.clientsChecked++;
    try {
      // Find contractors with insurance expiring within the lead window or already expired.
      const contractorResult = await db.execute(sql`
        SELECT id, name, company, email, public_liability_expiry
        FROM contractors
        WHERE client_id = ${client.id}
          AND public_liability_expiry IS NOT NULL
          AND public_liability_expiry <= ${threshold}
        ORDER BY public_liability_expiry ASC
      `);
      const rows = (contractorResult.rows ?? []) as unknown as ContractorInsuranceRow[];

      if (rows.length === 0) continue;

      // Build alerts list
      const alerts: Array<{ name: string; company: string | null; expiry: Date; expired: boolean }> = [];
      for (const row of rows) {
        const expiry = new Date(row.public_liability_expiry!);
        if (Number.isNaN(expiry.getTime())) continue;
        alerts.push({
          name: row.name,
          company: row.company,
          expiry,
          expired: expiry < now,
        });
      }

      if (alerts.length === 0) continue;

      // Resolve notification recipients (client-level email or admin users).
      const { emails } = await getNotificationEmails(client.id);
      if (emails.length === 0) continue;

      const subject = `⚠️ ${alerts.length} contractor${alerts.length !== 1 ? "s" : ""} with expiring insurance — ComplyTrack`;
      const html = buildEmailHtml(alerts, appUrl);

      for (const email of emails) {
        try {
          await sendSystemEmail({ to: email, subject, html });
          result.emailsSent++;
        } catch (err) {
          logger.warn({ err, email, clientId: client.id }, "Failed to send contractor insurance expiry reminder");
          result.errors++;
        }
      }

      result.clientsAlerted++;
      logger.info(
        { clientId: client.id, alerts: alerts.length, emails: emails.length },
        "Contractor insurance expiry reminder sent",
      );
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Contractor insurance expiry reminder job failed for client");
    }
  }

  return result;
}
