/**
 * Overdue bike-hire notification job.
 *
 * Runs hourly. Finds active hires whose expected return time has passed and
 * emails the client's active staff so they can chase the hirer. Each hire is
 * notified at most once (bike_hire_records.overdue_notified_at).
 */

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface OverdueHire {
  id: number;
  client_id: number;
  hirer_name: string;
  hirer_contact: string | null;
  expected_return: string;
  bike_label: string | null;
}

function buildEmailHtml(hires: OverdueHire[], appUrl: string): string {
  const fmtTime = (d: string) =>
    new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const rows = hires
    .map(
      (h) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(h.hirer_name)}${h.bike_label ? ` — ${esc(h.bike_label)}` : ""}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            Due back ${fmtTime(h.expected_return)}${h.hirer_contact ? ` · Contact: ${esc(h.hirer_contact)}` : ""}
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
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">BikeTrack — overdue hire${hires.length !== 1 ? "s" : ""}</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${hires.length} hired bike${hires.length !== 1 ? "s have" : " has"} not been returned by the expected time. Please contact the hirer${hires.length !== 1 ? "s" : ""} or record the return in BikeTrack.
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
      ComplyTrack by ALPS Consulting · Automatic BikeTrack notification.
    </div>
  </div>
</body>
</html>`;
}

export interface BikeOverdueJobResult {
  hiresFound: number;
  clientsEmailed: number;
  emailsSent: number;
  errors: number;
}

type EmailSender = typeof sendEmail;

export async function runBikeOverdueJob(send: EmailSender = sendEmail): Promise<BikeOverdueJobResult> {
  const result: BikeOverdueJobResult = { hiresFound: 0, clientsEmailed: 0, emailsSent: 0, errors: 0 };
  const appUrl = getPublicAppUrl();

  // Active hires past their expected return that we haven't notified yet.
  const overdueResult = await db.execute(sql`
    SELECT h.id, h.client_id, h.guest_name AS hirer_name, h.guest_contact AS hirer_contact,
           h.return_date_expected AS expected_return, b.name AS bike_label
    FROM bike_hire_records h
    LEFT JOIN bikes b ON h.bike_id = b.id
    WHERE h.status = 'active'
      AND h.return_date_expected IS NOT NULL
      AND h.return_date_expected < now()
      AND h.overdue_notified_at IS NULL
    ORDER BY h.client_id, h.return_date_expected
  `);
  const hires = (overdueResult.rows ?? []) as unknown as OverdueHire[];
  result.hiresFound = hires.length;
  if (hires.length === 0) return result;

  // Group by client.
  const byClient = new Map<number, OverdueHire[]>();
  for (const h of hires) {
    const list = byClient.get(h.client_id) ?? [];
    list.push(h);
    byClient.set(h.client_id, list);
  }

  for (const [clientId, clientHires] of byClient) {
    try {
      const users = await db
        .select({ email: usersTable.email })
        .from(usersTable)
        .where(and(eq(usersTable.clientId, clientId), eq(usersTable.active, true)))
        .limit(20);
      const emails = users.map((u) => u.email).filter(Boolean) as string[];
      if (emails.length === 0) continue;

      // Claim the hires first (only rows still unclaimed) so concurrent job
      // runs can't double-send; release the claim if the send fails.
      const ids = clientHires.map((h) => h.id);
      const claimed = await db.execute(sql`
        UPDATE bike_hire_records SET overdue_notified_at = now()
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND overdue_notified_at IS NULL
        RETURNING id
      `);
      const claimedIds = ((claimed as any).rows ?? []).map((r: any) => r.id as number);
      if (claimedIds.length === 0) continue;

      const toSend = clientHires.filter((h) => claimedIds.includes(h.id));
      const subject = `🚲 ${toSend.length} bike hire${toSend.length !== 1 ? "s" : ""} overdue for return — ComplyTrack`;
      try {
        await send({ to: emails, subject, html: buildEmailHtml(toSend, appUrl) });
      } catch (sendErr) {
        await db.execute(sql`
          UPDATE bike_hire_records SET overdue_notified_at = NULL
          WHERE id IN (${sql.join(claimedIds.map((id: number) => sql`${id}`), sql`, `)})
        `);
        throw sendErr;
      }

      result.clientsEmailed++;
      result.emailsSent += emails.length;
      logger.info({ clientId, hires: ids.length, emails: emails.length }, "Bike overdue notification sent");
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Bike overdue notification failed");
    }
  }

  return result;
}
