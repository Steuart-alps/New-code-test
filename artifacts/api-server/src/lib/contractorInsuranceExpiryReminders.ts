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
import { sendSystemEmail, getPublicAppUrl, renderEmailLayout } from "./email";
import { getNotificationEmails } from "./getNotificationEmails";
import {
  claimEmailDelivery,
  emailDeliveryIdempotencyKey,
  markEmailDeliverySent,
  pruneSentEmailDeliveries,
  settleEmailDelivery,
} from "./emailDeliveryClaims";

const JOB = "contractor-insurance-digest";

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

  return renderEmailLayout({
    subtitle: `Contractor insurance expiry alert`,
    footerNote: `You are receiving this as an account manager.`,
    bodyHtml: `
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${alerts.length} contractor${alerts.length !== 1 ? "s" : ""} ${alerts.length !== 1 ? "have" : "has"} public liability insurance that is expiring soon or has already expired. Please chase renewals or update the records in ComplyTrack.
      </p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;">
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:28px;text-align:center;">
        <a href="${appUrl}/contractors" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
          View Contractors →
        </a>
      </div>
`,
  });
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
  // The Monday (UTC date) that starts this digest week.
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const weekKey = monday.toISOString().slice(0, 10);
  await pruneSentEmailDeliveries(JOB, 60).catch((err) => logger.warn({ err }, "Could not prune insurance digest markers"));

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

      // One digest per client per week, even when the start-up catch-up and
      // the Monday schedule (or two instances) both run: claim the week first;
      // the claim becomes the week's sent marker once anything was accepted.
      const claim = await claimEmailDelivery(JOB, `${client.id}:${weekKey}`);
      if (!claim) continue;
      let delivered = 0;
      try {
        for (const email of emails) {
          try {
            await sendSystemEmail({ to: email, subject, html, idempotencyKey: emailDeliveryIdempotencyKey(claim, email) });
            delivered++;
            result.emailsSent++;
          } catch (err) {
            logger.warn({ err, email, clientId: client.id }, "Failed to send contractor insurance expiry reminder");
            result.errors++;
          }
        }
      } finally {
        if (delivered > 0) await markEmailDeliverySent(claim).catch(() => {});
        else await settleEmailDelivery(claim).catch(() => {});
      }
      if (delivered === 0) continue;

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
