/**
 * Weekly document-acknowledgement reminder job.
 *
 * For each active client that has documents requiring acknowledgement with
 * outstanding staff, emails the client's managers (client_admin users) a
 * digest of who still needs to sign. Throttled to one email per client per
 * 7 days via doc_ack_reminder_log.
 */

import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { docCategoryFilter } from "./docTrackScope";
import { sendEmail, getPublicAppUrl, renderEmailLayout } from "./email";
import { sendPushToUsers } from "./pushNotifications";
import { getNotificationEmails } from "./getNotificationEmails";
import { claimEmailDelivery, emailDeliveryIdempotencyKey, settleEmailDelivery } from "./emailDeliveryClaims";

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

export async function getOutstandingAckSummary(clientId: number, categories: readonly string[] | null = null): Promise<OutstandingDocSummary[]> {
  const docsResult = await db.execute(sql`
    SELECT id, title, department, site_id FROM doc_track_documents
    WHERE client_id = ${clientId} AND requires_acknowledgement = true
      ${docCategoryFilter(sql`category`, categories)}
    ORDER BY title ASC
  `);
  const docs = (docsResult.rows ?? []) as any[];
  if (docs.length === 0) return [];

  const staffResult = await db.execute(sql`
    SELECT id,
      COALESCE(NULLIF(trim(name), ''), NULLIF(trim(concat_ws(' ', first_name, last_name)), '')) AS name,
      department, site_id
    FROM staff_roster
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
      const relevant = staff.filter((s) =>
        (!d.department || s.department === d.department) && (d.site_id == null || s.site_id === d.site_id));
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

  return renderEmailLayout({
    subtitle: `Document acknowledgements outstanding`,
    footerNote: `You are receiving this as an account manager.`,
    bodyHtml: `
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        Some staff still haven't acknowledged required documents. Please chase the sign-offs below or record them in DocTrack.
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

      // Resolve notification recipients (client-level email or admin users).
      const { emails, userIds } = await getNotificationEmails(client.id);
      if (emails.length === 0) continue;

      // Lease first so concurrent job runs can't double-send. The throttle
      // row is written only after the provider accepted the email, so a crash
      // mid-send is retried (same idempotency key) once the lease expires.
      const lease = await claimEmailDelivery("doc-ack", String(client.id));
      if (!lease) continue;
      const docCount = outstanding.length;
      const subject = `📄 ${docCount} document${docCount !== 1 ? "s" : ""} awaiting staff acknowledgement — ComplyTrack`;
      let settled = false;
      try {
        const again = await db.execute(sql`
          SELECT 1 FROM doc_ack_reminder_log
          WHERE client_id = ${client.id} AND sent_at > now() - interval '7 days'
          LIMIT 1
        `);
        if (((again as any).rows ?? []).length > 0) continue;
        await sendEmail({
          to: emails,
          subject,
          html: buildEmailHtml(outstanding, appUrl),
          idempotencyKey: emailDeliveryIdempotencyKey(lease, new Date().toISOString().slice(0, 10)),
        });
        await db.transaction(async (tx) => {
          await tx.execute(sql`INSERT INTO doc_ack_reminder_log (client_id, sent_at) VALUES (${client.id}, now())`);
          await settleEmailDelivery(lease, tx);
        });
        settled = true;
      } finally {
        if (!settled) await settleEmailDelivery(lease).catch(() => {});
      }

      // Push managers a matching alert (best-effort; never blocks the job).
      await sendPushToUsers(userIds, {
        title: "Document sign-offs outstanding",
        body: `${docCount} document${docCount !== 1 ? "s" : ""} awaiting staff acknowledgement.`,
        data: { route: "/(tabs)/docs" },
      }).catch((err) => logger.warn({ err, clientId: client.id }, "Doc acknowledgement push failed"));

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
