/**
 * Weekly document-acknowledgement reminder job.
 *
 * For each active client that has documents requiring acknowledgement with
 * outstanding staff, emails the client's managers (client_admin users) a
 * digest of who still needs to sign. Throttled to one email per client per
 * 7 days via doc_ack_reminder_log.
 */

import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { sendPushToUsers } from "./pushNotifications";

interface OutstandingDocSummary {
  title: string;
  department: string | null;
  outstanding: string[];
  acknowledgedCount: number;
  staffTotal: number;
}

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function getOutstandingAckSummary(clientId: number): Promise<OutstandingDocSummary[]> {
  const docsResult = await db.execute(sql`
    SELECT id, title, department FROM doc_track_documents
    WHERE client_id = ${clientId} AND requires_acknowledgement = true
    ORDER BY title ASC
  `);
  const docs = (docsResult.rows ?? []) as any[];
  if (docs.length === 0) return [];

  const staffResult = await db.execute(sql`
    SELECT id, (first_name || ' ' || last_name) AS name, department FROM staff_roster
    WHERE client_id = ${clientId} AND active = true
  `);
  const staff = (staffResult.rows ?? []) as any[];
  if (staff.length === 0) return [];

  const acksResult = await db.execute(sql`
    SELECT document_id, staff_roster_id FROM doc_acknowledgements WHERE client_id = ${clientId}
  `);
  const acked = new Set((acksResult.rows ?? []).map((r: any) => `${r.document_id}:${r.staff_roster_id}`));

  return docs
    .map((d) => {
      const relevant = d.department ? staff.filter((s) => s.department === d.department) : staff;
      const outstanding = relevant.filter((s) => !acked.has(`${d.id}:${s.id}`));
      return {
        title: d.title as string,
        department: (d.department ?? null) as string | null,
        outstanding: outstanding.map((s) => s.name as string),
        acknowledgedCount: relevant.length - outstanding.length,
        staffTotal: relevant.length,
      };
    })
    .filter((d) => d.outstanding.length > 0);
}

function buildEmailHtml(docs: OutstandingDocSummary[], appUrl: string): string {
  const rows = docs
    .map(
      (d) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(d.title)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            ${d.department ? `${esc(d.department)} · ` : ""}${d.acknowledgedCount}/${d.staffTotal} acknowledged
          </div>
          <div style="font-size:12px;color:#b45309;margin-top:4px;">Waiting on: ${d.outstanding.map(esc).join(", ")}</div>
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
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Document acknowledgements outstanding</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        Some staff still haven't acknowledged required documents. Please chase the sign-offs below or record them in DocTrack.
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

export interface DocAckReminderJobResult {
  clientsChecked: number;
  clientsEmailed: number;
  emailsSent: number;
  errors: number;
}

export async function runDocAckReminderJob(): Promise<DocAckReminderJobResult> {
  const result: DocAckReminderJobResult = { clientsChecked: 0, clientsEmailed: 0, emailsSent: 0, errors: 0 };
  const appUrl = getPublicAppUrl();

  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.active, true));

  for (const client of clients) {
    result.clientsChecked++;
    try {
      // Throttle: at most one reminder per client per 7 days.
      const recent = await db.execute(sql`
        SELECT 1 FROM doc_ack_reminder_log
        WHERE client_id = ${client.id} AND sent_at > now() - interval '7 days'
        LIMIT 1
      `);
      if (((recent as any).rows ?? []).length > 0) continue;

      const outstanding = await getOutstandingAckSummary(client.id);
      if (outstanding.length === 0) continue;

      // Managers only.
      const managers = await db
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(and(
          eq(usersTable.clientId, client.id),
          eq(usersTable.active, true),
          eq(usersTable.role, "client_admin"),
        ))
        .limit(20);
      const emails = managers.map((m) => m.email).filter(Boolean) as string[];
      const userIds = [...new Set(managers.map((m) => m.id))];
      if (emails.length === 0) continue;

      // Claim first so concurrent job runs can't double-send; release the
      // claim if the send fails so a later run retries.
      const claim = await db.execute(sql`
        INSERT INTO doc_ack_reminder_log (client_id, sent_at)
        SELECT ${client.id}, now()
        WHERE NOT EXISTS (
          SELECT 1 FROM doc_ack_reminder_log
          WHERE client_id = ${client.id} AND sent_at > now() - interval '7 days'
        )
        RETURNING id
      `);
      const claimId = ((claim as any).rows ?? [])[0]?.id;
      if (!claimId) continue;

      const docCount = outstanding.length;
      const subject = `📄 ${docCount} document${docCount !== 1 ? "s" : ""} awaiting staff acknowledgement — ComplyTrack`;
      try {
        await sendEmail({ to: emails, subject, html: buildEmailHtml(outstanding, appUrl) });
      } catch (sendErr) {
        await db.execute(sql`DELETE FROM doc_ack_reminder_log WHERE id = ${claimId}`);
        throw sendErr;
      }

      // Push managers a matching alert (best-effort; never blocks the job).
      await sendPushToUsers(userIds, {
        title: "Document sign-offs outstanding",
        body: `${docCount} document${docCount !== 1 ? "s" : ""} awaiting staff acknowledgement.`,
        data: { route: "/(tabs)/docs" },
      });

      result.clientsEmailed++;
      result.emailsSent += emails.length;
      logger.info({ clientId: client.id, docs: docCount, emails: emails.length }, "Doc acknowledgement reminder sent");
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Doc acknowledgement reminder failed");
    }
  }

  return result;
}
