/**
 * Daily FixTrack overdue / stale-issue alert job.
 *
 * For each active client, emails client admins a digest of open issues that:
 *   - are urgent/high priority and have had no update for more than 24 hours, or
 *   - have passed their target date (regardless of priority).
 *
 * A client/day claim prevents concurrent split digests. Per-issue dated log
 * rows suppress the same issue on the immediately following morning.
 */

import { db } from "@workspace/db";
import { appSettingsTable, clientsTable, usersTable } from "@workspace/db/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { sendPushToUsers } from "./pushNotifications";
import { DEFAULT_FIX_TRACK_STALE_DAYS, parseFixTrackStaleDays } from "./fixTrackAlertSettings";

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface OverdueIssue {
  id: number;
  title: string;
  location: string | null;
  priority: string;
  status: string;
  target_date: string | null;
  reported_date: string;
  created_at: string;
  site_name: string | null;
  contractor_name: string | null;
  issue_type: string;
  days_open: number;
  reason: string; // "overdue" | "stale"
  stale_days: number;
}

interface PendingDigest {
  id: number;
  log_date: string;
  idempotency_key: string;
  issue_snapshot: OverdueIssue[];
  recipient_emails: string[];
  recipient_user_ids: number[];
}

export async function getStaleDays(clientId: number): Promise<number> {
  const [setting] = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(
      eq(appSettingsTable.clientId, clientId),
      eq(appSettingsTable.key, "fixTrackStaleDays"),
    ))
    .limit(1);
  return parseFixTrackStaleDays(setting?.value) ?? DEFAULT_FIX_TRACK_STALE_DAYS;
}

/** Open overdue issues and urgent/high issues inactive beyond the tenant threshold. */
export async function getOverdueUrgentIssues(
  clientId: number,
  staleDays?: number,
): Promise<OverdueIssue[]> {
  const effectiveStaleDays = staleDays ?? await getStaleDays(clientId);
  const result = await db.execute(sql`
    SELECT
      fi.id, fi.title, fi.location, fi.priority, fi.status, fi.issue_type,
      fi.target_date, fi.reported_date, fi.created_at, fi.updated_at,
      s.name AS site_name,
      c.name AS contractor_name,
      GREATEST(0, CURRENT_DATE - fi.reported_date)::int AS days_open,
      ${effectiveStaleDays}::int AS stale_days,
      CASE
        WHEN fi.target_date IS NOT NULL AND fi.target_date < CURRENT_DATE THEN 'overdue'
        ELSE 'stale'
      END AS reason
    FROM  fix_track_issues fi
    LEFT  JOIN sites s ON s.id = fi.site_id AND s.client_id = fi.client_id
    LEFT  JOIN contractors c ON c.id = fi.contractor_id AND c.client_id = fi.client_id
    WHERE fi.client_id = ${clientId}
      AND fi.status IN ('reported', 'in_progress')
      AND (
        (fi.target_date IS NOT NULL AND fi.target_date < CURRENT_DATE)
        OR (
          fi.priority IN ('urgent', 'high')
          AND fi.updated_at < now() - (${effectiveStaleDays} * interval '1 day')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM fix_track_escalation_log fel
        WHERE fel.client_id = fi.client_id
          AND fel.issue_id = fi.id
          AND fel.log_date >= CURRENT_DATE - 1
      )
    ORDER BY fi.issue_type, fi.target_date ASC NULLS LAST, fi.created_at ASC
  `);
  return (result.rows ?? []) as unknown as OverdueIssue[];
}

export function buildFixTrackAlertEmail(issues: OverdueIssue[], appUrl: string): { html: string; text: string } {
  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const groups = new Map<string, OverdueIssue[]>();
  for (const issue of issues) groups.set(issue.issue_type, [...(groups.get(issue.issue_type) ?? []), issue]);
  const sections = [...groups.entries()].map(([trade, tradeIssues]) => {
    const rows = tradeIssues.map((i) => {
      const detail =
        i.reason === "overdue" && i.target_date
          ? `Target date passed (${fmtDate(i.target_date)})`
          : `No update for more than ${i.stale_days} day${i.stale_days === 1 ? "" : "s"}`;
      const issueUrl = `${appUrl}/fix-track/${i.id}`;
      return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(i.title)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            Site: ${esc(i.site_name ?? "No site")} · Contractor: ${esc(i.contractor_name ?? "Unassigned")} · ${i.days_open} day${i.days_open === 1 ? "" : "s"} open
          </div>
          <div style="font-size:12px;color:#b91c1c;margin-top:4px;">${esc(detail)}</div>
          <a href="${issueUrl}" style="display:inline-block;margin-top:6px;color:#2563eb;font-size:12px;font-weight:600;">Open issue →</a>
        </td>
      </tr>`;
    }).join("");
    return `<h3 style="margin:24px 0 8px;color:#0f172a;">${esc(trade.split("_").map(w => w[0]?.toUpperCase() + w.slice(1)).join(" "))}</h3><table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:12px;overflow:hidden;"><tbody>${rows}</tbody></table>`;
  }).join("");

  const html = `
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
      ${sections}
      <div style="margin-top:28px;text-align:center;">
        <a href="${appUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
          Open ComplyTrack →
        </a>
      </div>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;text-align:center;">
      ComplyTrack by ALPS Consulting · You are receiving this as an account administrator.
    </div>
  </div>
</body>
</html>`;
  const text = [...groups.entries()].flatMap(([trade, tradeIssues]) => [
    trade.split("_").map(w => w[0]?.toUpperCase() + w.slice(1)).join(" "),
    ...tradeIssues.map(i => `- ${i.title} — ${i.site_name ?? "No site"} — ${i.contractor_name ?? "Unassigned"} — ${i.days_open} days open — ${appUrl}/fix-track/${i.id}`),
    "",
  ]).join("\n");
  return { html, text };
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
  options: {
    /** Resume persisted work only; do not create a new daily digest. */
    recoverOnly?: boolean;
    /** Test hook for simulating termination after provider acceptance. */
    afterSend?: () => Promise<void>;
  } = {},
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
      // Resume an abandoned pending digest first. Its exact recipients, issue
      // snapshot and provider key are persisted, making crash recovery safe.
      const pendingResult = await db.execute(sql`
        SELECT id, log_date, idempotency_key, issue_snapshot,
               recipient_emails, recipient_user_ids
        FROM fix_track_alert_log
        WHERE client_id = ${client.id}
          AND (
            status = 'pending'
            OR (status = 'sending' AND updated_at < now() - interval '15 minutes')
          )
        ORDER BY log_date, id
        LIMIT 1
      `);
      let digest = ((pendingResult.rows ?? []) as unknown as PendingDigest[])[0];

      if (!digest) {
        if (options.recoverOnly) continue;
        // An actively leased older digest is not yet eligible for recovery, but
        // it must still block creation of a new daily snapshot. Otherwise the
        // same issues could be dispatched under two different daily keys.
        const unsent = await db.execute(sql`
          SELECT 1 FROM fix_track_alert_log
          WHERE client_id = ${client.id} AND status IN ('pending', 'sending')
          LIMIT 1
        `);
        if ((unsent.rows ?? []).length > 0) continue;

        const issues = await getOverdueUrgentIssues(client.id);
        if (issues.length === 0) continue;

        const managers = await db
          .select({ id: usersTable.id, email: usersTable.email })
          .from(usersTable)
          .where(and(
            eq(usersTable.clientId, client.id),
            eq(usersTable.active, true),
            or(eq(usersTable.role, "client_admin"), eq(usersTable.isMaintenanceManager, true)),
          ));
        const emails = [...new Set(managers.map((m) => m.email).filter(Boolean) as string[])];
        const userIds = [...new Set(managers.map((m) => m.id))];
        if (emails.length === 0) continue;

        const today = new Date().toISOString().slice(0, 10);
        const idempotencyKey = `fixtrack-escalation-${client.id}-${today}`;
        const claim = await db.execute(sql`
          INSERT INTO fix_track_alert_log (
            client_id, log_date, status, idempotency_key, issue_snapshot,
            recipient_emails, recipient_user_ids, sent_at, updated_at
          )
          VALUES (
            ${client.id}, CURRENT_DATE, 'pending', ${idempotencyKey},
            ${JSON.stringify(issues)}::jsonb, ${JSON.stringify(emails)}::jsonb,
            ${JSON.stringify(userIds)}::jsonb, NULL, now()
          )
          ON CONFLICT (client_id, log_date) DO NOTHING
          RETURNING id, log_date, idempotency_key, issue_snapshot,
                    recipient_emails, recipient_user_ids
        `);
        digest = ((claim.rows ?? []) as unknown as PendingDigest[])[0];
        if (!digest) continue;
      }

      const claimedIssues = digest.issue_snapshot;
      const emails = digest.recipient_emails;
      const userIds = digest.recipient_user_ids;

      // Only one worker may dispatch this snapshot. A process that dies after
      // acquiring it leaves a recoverable lease rather than a permanent lock.
      const dispatchClaim = await db.execute(sql`
        UPDATE fix_track_alert_log
        SET status = 'sending', updated_at = now()
        WHERE id = ${digest.id}
          AND (
            status = 'pending'
            OR (status = 'sending' AND updated_at < now() - interval '15 minutes')
          )
        RETURNING id
      `);
      if ((dispatchClaim.rows ?? []).length === 0) continue;

      const subject = `⚠️ ${claimedIssues.length} maintenance issue${claimedIssues.length !== 1 ? "s" : ""} need attention — ComplyTrack`;
      const email = buildFixTrackAlertEmail(claimedIssues, appUrl);
      let providerAccepted = false;
      try {
        await send({
          to: emails,
          subject,
          ...email,
          clientId: client.id,
          idempotencyKey: digest.idempotency_key,
        });
        providerAccepted = true;
        await options.afterSend?.();
      } catch (sendErr) {
        if (!providerAccepted) {
          await db.execute(sql`
            UPDATE fix_track_alert_log
            SET status = 'pending', updated_at = now()
            WHERE id = ${digest.id} AND status = 'sending'
          `);
        }
        throw sendErr;
      }

      // Finalize the issue cooldowns and digest state together. If the process
      // dies before commit, the pending snapshot replays with the same provider
      // key, so Resend accepts it idempotently and finalization can retry.
      await db.transaction(async (tx) => {
        for (const issue of claimedIssues) {
          await tx.execute(sql`
            INSERT INTO fix_track_escalation_log (client_id, issue_id, log_date, sent_at)
            SELECT ${client.id}, fi.id, CURRENT_DATE, now()
            FROM fix_track_issues fi
            WHERE fi.id = ${issue.id} AND fi.client_id = ${client.id}
            ON CONFLICT (issue_id, log_date) DO NOTHING
          `);
        }
        await tx.execute(sql`
          UPDATE fix_track_alert_log
          SET status = 'sent', sent_at = now(), updated_at = now()
          WHERE id = ${digest.id} AND status = 'sending'
        `);
      });

      // Push managers a matching alert (best-effort; never blocks the job).
      await sendPushToUsers(userIds, {
        title: "Maintenance issues need attention",
        body: `${claimedIssues.length} issue${claimedIssues.length !== 1 ? "s" : ""} overdue or unactioned in FixTrack.`,
        data: { route: "/(tabs)/issues" },
      });

      result.clientsEmailed++;
      result.emailsSent += emails.length;
      logger.info({ clientId: client.id, issues: claimedIssues.length, emails: emails.length }, "FixTrack overdue alert sent");
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "FixTrack overdue alert failed");
    }
  }

  return result;
}
