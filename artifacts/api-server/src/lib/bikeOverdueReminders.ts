/**
 * Overdue bike-hire notification job.
 *
 * Runs daily, sends the initial alert after a missed return, then repeats only
 * at the client's configured cadence while the hire remains active. Database
 * claims make delivery safe when multiple scheduler instances run at once.
 */

import { db } from "@workspace/db";
import { sql, type SQLWrapper } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { sendPushToUsers } from "./pushNotifications";
import { getNotificationEmails } from "./getNotificationEmails";

const BIKE_OVERDUE_REPEAT_SETTING = "bike_overdue_repeat_interval_days";
/** Available client-selected repeat intervals; zero means one alert only. */
export const BIKE_OVERDUE_REPEAT_INTERVALS_DAYS = [1, 3, 7, 14] as const;
const BIKE_OVERDUE_INTERVAL_OPTIONS = ["1", "3", "7", "14"] as const;

export function parseBikeOverdueRepeatInterval(value: unknown): number | null {
  if (value === "0") return 0;
  if (typeof value !== "string" || !(BIKE_OVERDUE_INTERVAL_OPTIONS as readonly string[]).includes(value)) return null;
  return Number(value);
}

function configuredRepeatDays(clientId: SQLWrapper) {
  return sql<number>`COALESCE((
    SELECT CASE setting.value
      WHEN '1' THEN 1 WHEN '3' THEN 3 WHEN '7' THEN 7 WHEN '14' THEN 14
      ELSE 0
    END
    FROM app_settings setting
    WHERE setting.client_id = ${clientId} AND setting.key = ${BIKE_OVERDUE_REPEAT_SETTING}
    LIMIT 1
  ), 0)`;
}
/** An abandoned worker's claim may be retried after this lease expires. */
const CLAIM_LEASE_MINUTES = 30;

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface OverdueHire {
  id: number;
  client_id: number;
  hirer_name: string;
  hirer_contact: string | null;
  expected_return: string;
  bike_ref: string;
  days_overdue: number;
}

function buildEmailHtml(hires: OverdueHire[], appUrl: string): string {
  const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
  const rows = hires.map((h) => `
      <tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(h.bike_ref)} — ${esc(h.hirer_name)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px;">
          Due back ${fmtDate(h.expected_return)} · ${h.days_overdue} day${h.days_overdue === 1 ? "" : "s"} overdue${h.hirer_contact ? ` · Contact: ${esc(h.hirer_contact)}` : ""}
        </div>
      </td></tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:#0f172a;padding:32px 40px;"><div style="font-size:22px;font-weight:700;color:#ffffff;">🛡️ ComplyTrack</div><div style="font-size:14px;color:#94a3b8;margin-top:6px;">BikeTrack — overdue hire${hires.length !== 1 ? "s" : ""}</div></div>
    <div style="padding:32px 40px;"><p style="font-size:15px;color:#334155;margin:0 0 20px;">${hires.length} hired bike${hires.length !== 1 ? "s have" : " has"} not been returned by the expected time. Please contact the hirer${hires.length !== 1 ? "s" : ""} or record the return in BikeTrack.</p><table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;"><tbody>${rows}</tbody></table><div style="margin-top:28px;text-align:center;"><a href="${appUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">Open ComplyTrack →</a></div></div>
    <div style="padding:20px 40px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;text-align:center;">ComplyTrack by ALPS Consulting · Automatic BikeTrack notification.</div>
  </div>
</body></html>`;
}

export interface BikeOverdueJobResult {
  hiresFound: number;
  clientsEmailed: number;
  emailsSent: number;
  errors: number;
}

type EmailSender = typeof sendEmail;
type PushSender = typeof sendPushToUsers;

export async function runBikeOverdueJob(
  deps: { sendEmail?: EmailSender; sendPush?: PushSender } = {},
): Promise<BikeOverdueJobResult> {
  const send = deps.sendEmail ?? sendEmail;
  const sendPush = deps.sendPush ?? sendPushToUsers;
  const result: BikeOverdueJobResult = { hiresFound: 0, clientsEmailed: 0, emailsSent: 0, errors: 0 };
  const appUrl = getPublicAppUrl();

  // Missing or invalid configuration means a single alert only. The UPDATE
  // below independently rechecks cadence and active hire status under claim.
  const candidateRepeatDays = configuredRepeatDays(sql.raw("h.client_id"));
  const overdueResult = await db.execute(sql`
    SELECT h.id, h.client_id, h.guest_name AS hirer_name, h.guest_contact AS hirer_contact,
           h.return_date_expected AS expected_return, b.ref AS bike_ref,
           (CURRENT_DATE - h.return_date_expected)::integer AS days_overdue
    FROM bike_hire_records h
    LEFT JOIN bikes b ON h.bike_id = b.id
    WHERE h.status = 'active' AND h.return_date_expected IS NOT NULL
      AND h.return_date_expected < CURRENT_DATE
      AND (
        h.overdue_notified_at IS NULL OR
        (${candidateRepeatDays} > 0 AND h.overdue_notified_at <= now() - (${candidateRepeatDays} * interval '1 day'))
      )
    ORDER BY h.client_id, h.return_date_expected
  `);
  const hires = (overdueResult.rows ?? []) as unknown as OverdueHire[];
  result.hiresFound = hires.length;
  if (!hires.length) return result;

  const byClient = new Map<number, OverdueHire[]>();
  for (const hire of hires) byClient.set(hire.client_id, [...(byClient.get(hire.client_id) ?? []), hire]);

  for (const [clientId, clientHires] of byClient) {
    try {
      const repeatDays = configuredRepeatDays(sql`${clientId}`);
      // This helper both scopes users to this tenant and includes active account
      // admins plus explicitly configured operational managers.
      const { emails, userIds } = await getNotificationEmails(clientId, { includeMaintenanceManagers: true });
      if (!emails.length) continue;

      const ids = clientHires.map((h) => h.id);
      const claimToken = crypto.randomUUID();
      const claimed = await db.execute(sql`
        UPDATE bike_hire_records
        SET overdue_notification_claim_token = ${claimToken}, overdue_notification_claimed_at = now()
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND client_id = ${clientId} AND status = 'active'
          AND return_date_expected IS NOT NULL AND return_date_expected < CURRENT_DATE
          AND (
            overdue_notified_at IS NULL OR
            (${repeatDays} > 0 AND overdue_notified_at <= now() - (${repeatDays} * interval '1 day'))
          )
          AND (overdue_notification_claim_token IS NULL OR overdue_notification_claimed_at < now() - (${CLAIM_LEASE_MINUTES} * interval '1 minute'))
        RETURNING id
      `);
      const claimedIds = new Set(((claimed as any).rows ?? []).map((row: any) => row.id as number));
      if (!claimedIds.size) continue;

      // Recheck status after claiming: returns recorded before dispatch are
      // suppressed. Only this worker's token may be released or finalised.
      const active = await db.execute(sql`
        SELECT id FROM bike_hire_records
        WHERE client_id = ${clientId} AND status = 'active'
          AND overdue_notification_claim_token = ${claimToken}
          AND return_date_expected IS NOT NULL AND return_date_expected < CURRENT_DATE
          AND (
            overdue_notified_at IS NULL OR
            (${repeatDays} > 0 AND overdue_notified_at <= now() - (${repeatDays} * interval '1 day'))
          )
      `);
      const activeIds = new Set(((active as any).rows ?? []).map((row: any) => row.id as number));
      const toSend = clientHires.filter((h) => claimedIds.has(h.id) && activeIds.has(h.id));
      if (!toSend.length) {
        await db.execute(sql`UPDATE bike_hire_records SET overdue_notification_claim_token = NULL, overdue_notification_claimed_at = NULL WHERE client_id = ${clientId} AND overdue_notification_claim_token = ${claimToken}`);
        continue;
      }

      try {
        await send({
          to: emails,
          subject: `🚲 ${toSend.length} bike hire${toSend.length !== 1 ? "s" : ""} overdue for return — ComplyTrack`,
          html: buildEmailHtml(toSend, appUrl),
        });
      } catch (sendErr) {
        // No successful email is recorded on failure, so a later job retries.
        await db.execute(sql`UPDATE bike_hire_records SET overdue_notification_claim_token = NULL, overdue_notification_claimed_at = NULL WHERE client_id = ${clientId} AND overdue_notification_claim_token = ${claimToken}`);
        throw sendErr;
      }

      // Complete before push dispatch. A push failure is a partial failure and
      // must not make a successfully emailed repeat eligible again.
      await db.execute(sql`
        UPDATE bike_hire_records
        SET overdue_notified_at = now(), overdue_notification_claim_token = NULL, overdue_notification_claimed_at = NULL
        WHERE client_id = ${clientId} AND status = 'active' AND overdue_notification_claim_token = ${claimToken}
      `);
      try {
        await sendPush(userIds, {
          title: "Bike hire overdue",
          body: `${toSend.length} bike hire${toSend.length !== 1 ? "s have" : " has"} not been returned on time.`,
          data: { route: "/(tabs)" },
        });
      } catch (pushErr) {
        logger.warn({ err: pushErr, clientId }, "Bike overdue push notification failed after email delivery");
      }

      result.clientsEmailed++;
      result.emailsSent += emails.length;
      logger.info({ clientId, hires: toSend.length, emails: emails.length }, "Bike overdue notification sent");
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Bike overdue notification failed");
    }
  }
  return result;
}