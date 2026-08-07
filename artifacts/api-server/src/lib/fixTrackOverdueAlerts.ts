/**
 * Daily FixTrack overdue / stale-issue alert job.
 *
 * For each active client, emails the client's managers (client_admin users
 * and maintenance managers) a digest of open issues that either:
 *   - are URGENT and past their target date OR without an update in 7+ days, or
 *   - (any priority) have been open/unactioned — no status change or notes, i.e.
 *     no update — for N days (default 7, configurable per-client via the
 *     app_settings key `fixTrackStaleDays`).
 *
 * `updated_at` is bumped on every status change / notes edit, so "no update in N
 * days" is our proxy for "unactioned for N days".
 *
 * Throttled to one email per client per day via fix_track_alert_log (claim-first
 * dedupe, mirroring docAckReminders / bikeOverdueReminders).
 */

import { db } from "@workspace/db";
import { clientsTable, usersTable, appSettingsTable } from "@workspace/db/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { sendPushToUsers } from "./pushNotifications";

/** Default days an open issue may sit unactioned before it's chased. */
export const DEFAULT_STALE_DAYS = 7;

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Read the per-client "stale after N days" threshold from app_settings
 * (key `fixTrackStaleDays`), falling back to the default. Clamped to a sane
 * range so a bad value can't disable or spam the job.
 */
export async function getStaleDays(clientId: number): Promise<number> {
  const [row] = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, "fixTrackStaleDays")))
    .limit(1);
  const parsed = row?.value ? Number.parseInt(row.value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_STALE_DAYS;
  return Math.min(parsed, 365);
}

interface OverdueIssue {
  id: number;
  title: string;
  location: string | null;
  priority: string;
  status: string;
  target_date: string | null;
  updated_at: string;
  site_name: string | null;
  reason: string; // "overdue" | "stale"
}

/**
 * Open issues that need a chase, either because they are URGENT and past target
 * date / stale, OR (any priority) have had no update (status change or notes)
 * for `staleDays` days.
 */
export async function getOverdueUrgentIssues(
  clientId: number,
  staleDays: number = DEFAULT_STALE_DAYS,
): Promise<OverdueIssue[]> {
  const result = await db.execute(sql`
    SELECT
      fi.id, fi.title, fi.location, fi.priority, fi.status,
      fi.target_date, fi.updated_at,
      s.name AS site_name,
      CASE
        WHEN fi.target_date IS NOT NULL AND fi.target_date < CURRENT_DATE THEN 'overdue'
        ELSE 'stale'
      END AS reason
    FROM  fix_track_issues fi
    LEFT  JOIN sites s ON s.id = fi.site_id
    WHERE fi.client_id = ${clientId}
      AND fi.status IN ('reported', 'in_progress')
      AND (
        -- URGENT issues: past target date or stale for 7+ days.
        (
          fi.priority = 'urgent'
          AND (
            (fi.target_date IS NOT NULL AND fi.target_date < CURRENT_DATE)
            OR fi.updated_at < now() - interval '7 days'
          )
        )
        -- Any issue left unactioned (no update) for the configured window.
        OR fi.updated_at < now() - (${staleDays} * interval '1 day')
      )
    ORDER BY fi.target_date ASC NULLS LAST, fi.updated_at ASC
  `);
  return (result.rows ?? []) as unknown as OverdueIssue[];
}

function buildEmailHtml(issues: OverdueIssue[], appUrl: string): string {
  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const rows = issues
    .map((i) => {
      const detail =
        i.reason === "overdue" && i.target_date
          ? `Target date passed (${fmtDate(i.target_date)})`
          : `No update since ${fmtDate(i.updated_at)}`;
      return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(i.title)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            ${i.site_name ? `${esc(i.site_name)} · ` : ""}${i.location ? `${esc(i.location)} · ` : ""}${esc(i.status)}
          </div>
          <div style="font-size:12px;color:#b91c1c;margin-top:4px;">${esc(detail)}</div>
        </td>
      </tr>`;
    })
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:#0f172a;padding:32px 40px;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">🛡️ ComplyTrack</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">FixTrack — issue${issues.length !== 1 ? "s" : ""} needing attention</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${issues.length} maintenance issue${issues.length !== 1 ? "s are" : " is"} overdue or have been left unactioned. Please review and take action in FixTrack.
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
      ComplyTrack by ALPS Consulting · You are receiving this as a maintenance manager.
    </div>
  </div>
</body>
</html>`;
}

export interface FixTrackOverdueJobResult {
  clientsChecked: number;
  clientsEmailed: number;
  emailsSent: number;
  errors: number;
}

type EmailSender = typeof sendEmail;

export async function runFixTrackOverdueAlertJob(
  send: EmailSender = sendEmail,
): Promise<FixTrackOverdueJobResult> {
  const result: FixTrackOverdueJobResult = { clientsChecked: 0, clientsEmailed: 0, emailsSent: 0, errors: 0 };
  const appUrl = getPublicAppUrl();

  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.active, true));

  for (const client of clients) {
    result.clientsChecked++;
    try {
      // Throttle: at most one alert per client per day.
      const recent = await db.execute(sql`
        SELECT 1 FROM fix_track_alert_log
        WHERE client_id = ${client.id} AND log_date = CURRENT_DATE
        LIMIT 1
      `);
      if (((recent as any).rows ?? []).length > 0) continue;

      const staleDays = await getStaleDays(client.id);
      const issues = await getOverdueUrgentIssues(client.id, staleDays);
      if (issues.length === 0) continue;

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
      if (emails.length === 0) continue;

      // Claim first so concurrent job runs can't double-send; release the
      // claim (delete the log row) if the send fails so a later run retries.
      const claim = await db.execute(sql`
        INSERT INTO fix_track_alert_log (client_id, log_date, sent_at)
        VALUES (${client.id}, CURRENT_DATE, now())
        ON CONFLICT (client_id, log_date) DO NOTHING
        RETURNING id
      `);
      const claimId = ((claim as any).rows ?? [])[0]?.id;
      if (!claimId) continue;

      const subject = `⚠️ ${issues.length} maintenance issue${issues.length !== 1 ? "s" : ""} need attention — ComplyTrack`;
      try {
        await send({ to: emails, subject, html: buildEmailHtml(issues, appUrl) });
      } catch (sendErr) {
        await db.execute(sql`DELETE FROM fix_track_alert_log WHERE id = ${claimId}`);
        throw sendErr;
      }

      // Push managers a matching alert (best-effort; never blocks the job).
      await sendPushToUsers(userIds, {
        title: "Maintenance issues need attention",
        body: `${issues.length} issue${issues.length !== 1 ? "s" : ""} overdue or unactioned in FixTrack.`,
        data: { route: "/(tabs)/issues" },
      });

      result.clientsEmailed++;
      result.emailsSent += emails.length;
      logger.info({ clientId: client.id, issues: issues.length, emails: emails.length }, "FixTrack overdue alert sent");
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "FixTrack overdue alert failed");
    }
  }

  return result;
}
