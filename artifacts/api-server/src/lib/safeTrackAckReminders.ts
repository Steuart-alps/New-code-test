/**
 * Weekly SafeTrack acknowledgement reminder job (Task #89).
 *
 * Runs every Monday at 09:30. For each active client with the SafeTrack
 * service, finds required SafeTrack documents (risk assessments, SOPs,
 * and handbook entries) where at least one active staff member hasn't
 * acknowledged the document within 7 days of it being published (or at all).
 *
 * Sends a digest email to the client's admin users listing which documents
 * have outstanding acknowledgements, and who still needs to sign.
 *
 * Mirrors the structure of contractorInsuranceExpiryReminders.ts /
 * docAckReminders.ts.
 */

import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl } from "./email";
import { getEntitledServices, isEntitled } from "./services";
import { getNotificationEmails } from "./getNotificationEmails";

/** Only flag docs where staff have been outstanding for at least this many days. */
const OUTSTANDING_THRESHOLD_DAYS = 7;

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface OutstandingDocSummary {
  title: string;
  docType: "Risk Assessment" | "SOP" | "Handbook";
  outstanding: string[];
  acknowledgedCount: number;
  staffTotal: number;
}

export interface SafeTrackAckReminderJobResult {
  clientsChecked: number;
  clientsAlerted: number;
  emailsSent: number;
  errors: number;
}

async function getOutstandingAcks(clientId: number): Promise<OutstandingDocSummary[]> {
  const cutoff = new Date(Date.now() - OUTSTANDING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  // Fetch all active staff for this client
  const staffResult = await db.execute(sql`
    SELECT id, (first_name || ' ' || last_name) AS name
    FROM staff_roster
    WHERE client_id = ${clientId} AND active = true
  `);
  const staff = (staffResult.rows ?? []) as { id: number; name: string }[];
  if (staff.length === 0) return [];

  // Fetch all acknowledgements for this client (across all doc types)
  const acksResult = await db.execute(sql`
    SELECT document_type, document_id, staff_roster_id
    FROM safe_track_acknowledgements
    WHERE client_id = ${clientId}
  `);
  const acked = new Set(
    (acksResult.rows ?? []).map((r: any) => `${r.document_type}:${r.document_id}:${r.staff_roster_id}`),
  );

  const results: OutstandingDocSummary[] = [];

  // Helper: compute outstanding staff for a set of docs from a given table
  async function checkTable(
    tableSql: ReturnType<typeof sql>,
    docType: OutstandingDocSummary["docType"],
    typeKey: string,
  ) {
    const docsResult = await db.execute(tableSql);
    const docs = (docsResult.rows ?? []) as { id: number; title: string }[];

    for (const doc of docs) {
      const outstanding = staff.filter(
        (s) => !acked.has(`${typeKey}:${doc.id}:${s.id}`),
      );
      if (outstanding.length === 0) continue;
      results.push({
        title: doc.title,
        docType,
        outstanding: outstanding.map((s) => s.name),
        acknowledgedCount: staff.length - outstanding.length,
        staffTotal: staff.length,
      });
    }
  }

  await checkTable(
    sql`SELECT id, title FROM safe_risk_assessments
        WHERE client_id = ${clientId}
          AND requires_acknowledgement = true
          AND created_at <= ${cutoff.toISOString()}
        ORDER BY title ASC`,
    "Risk Assessment",
    "ra",
  );
  await checkTable(
    sql`SELECT id, title FROM safe_sops
        WHERE client_id = ${clientId}
          AND requires_acknowledgement = true
          AND created_at <= ${cutoff.toISOString()}
        ORDER BY title ASC`,
    "SOP",
    "sop",
  );
  await checkTable(
    sql`SELECT id, title FROM safe_handbook
        WHERE client_id = ${clientId}
          AND requires_acknowledgement = true
          AND created_at <= ${cutoff.toISOString()}
        ORDER BY title ASC`,
    "Handbook",
    "handbook",
  );

  return results;
}

function buildEmailHtml(docs: OutstandingDocSummary[], appUrl: string): string {
  const rows = docs
    .map(
      (d) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(d.title)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            ${esc(d.docType)} · ${d.acknowledgedCount}/${d.staffTotal} acknowledged
          </div>
          <div style="font-size:12px;color:#b45309;margin-top:4px;">
            Waiting on: ${d.outstanding.map(esc).join(", ")}
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
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">SafeTrack — staff acknowledgements outstanding</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${docs.length} SafeTrack document${docs.length !== 1 ? "s" : ""} ${docs.length !== 1 ? "have" : "has"} staff who haven't yet acknowledged them. Please chase sign-offs or record them in SafeTrack.
      </p>
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;">
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:28px;text-align:center;">
        <a href="${appUrl}/safe-track" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
          Open SafeTrack →
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

export async function runSafeTrackAckReminderJob(): Promise<SafeTrackAckReminderJobResult> {
  const result: SafeTrackAckReminderJobResult = {
    clientsChecked: 0,
    clientsAlerted: 0,
    emailsSent: 0,
    errors: 0,
  };

  const appUrl = getPublicAppUrl();

  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.active, true));

  for (const client of clients) {
    result.clientsChecked++;
    try {
      // Only send for clients that have the SafeTrack service.
      const services = await getEntitledServices(client.id);
      if (!isEntitled(services, "safetrack")) continue;

      const outstanding = await getOutstandingAcks(client.id);
      if (outstanding.length === 0) continue;

      // Resolve notification recipients (client-level email or admin users).
      const { emails } = await getNotificationEmails(client.id);
      if (emails.length === 0) continue;

      const docCount = outstanding.length;
      const subject = `📋 ${docCount} SafeTrack document${docCount !== 1 ? "s" : ""} awaiting staff acknowledgement — ComplyTrack`;
      const html = buildEmailHtml(outstanding, appUrl);

      for (const email of emails) {
        try {
          await sendSystemEmail({ to: email, subject, html });
          result.emailsSent++;
        } catch (err) {
          logger.warn({ err, email, clientId: client.id }, "Failed to send SafeTrack ack reminder email");
          result.errors++;
        }
      }

      result.clientsAlerted++;
      logger.info(
        { clientId: client.id, docs: docCount, emails: emails.length },
        "SafeTrack acknowledgement reminder sent",
      );
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "SafeTrack ack reminder job failed for client");
    }
  }

  return result;
}
