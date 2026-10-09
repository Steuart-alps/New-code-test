/**
 * Monthly compliance summary email
 *
 * Runs daily at 08:00 UK time. On the 1st, for every active client it:
 *  1. Computes the previous calendar-month compliance figures.
 *  2. Emails all client_admin users a plain-English summary.
 *
 * Restarts within the first week can catch up on an uninitialized month;
 * later days retry deliveries already snapshotted.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendEmail, escapeHtml } from "./email";
import { logger } from "./logger";
import { randomUUID } from "node:crypto";
import { getUnscopedComplianceReport } from "./unscopedComplianceReport";

// ─── Date helpers ────────────────────────────────────────────────────────────

export function lastMonthRange(now = new Date()): { from: string; to: string; label: string } {
  // UTC calendar arithmetic avoids local midnight drifting into the prior day.
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const label = from.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return {
    from:  from.toISOString().slice(0, 10),
    to:    to.toISOString().slice(0, 10),
    label,
  };
}

// The job consumes the same unfiltered calculation as GET /reports/compliance.
async function fetchComplianceForClient(clientId: number, from: string, to: string) {
  const report = await getUnscopedComplianceReport(clientId, from, to);
  const sites = report.sites.map(site => {
    const am = report.dailyChecklists.find(c => c.siteId === site.id && c.type === "am");
    const pm = report.dailyChecklists.find(c => c.siteId === site.id && c.type === "pm");
    return {
      name: site.name, amPct: am?.pct ?? 0, pmPct: pm?.pct ?? 0,
      amMiss: am?.missed ?? report.totalDays, pmMiss: pm?.missed ?? report.totalDays,
    };
  });
  const counts = new Map<string, number>();
  for (const item of report.moduleActivity) {
    counts.set(item.module, (counts.get(item.module) ?? 0) + item.count);
  }
  const modules = [...counts].map(([module, count]) => ({ module, count }));
  const totalRecords = modules.reduce((sum, item) => sum + item.count, 0);
  return { totalDays: report.totalDays, sites, modules, totalRecords };
}

// ─── Email template ──────────────────────────────────────────────────────────

function statusEmoji(pct: number): string {
  if (pct >= 90) return "✅";
  if (pct >= 70) return "⚠️";
  return "❌";
}

export function buildEmailHtml(label: string, data: Awaited<ReturnType<typeof fetchComplianceForClient>>): string {
  const { totalDays, sites, modules, totalRecords } = data;

  const siteRows = sites.map(s => `
    <tr style="border-bottom:1px solid #e5e7eb;">
       <td style="padding:8px 12px;">${escapeHtml(s.name)}</td>
       <td style="padding:8px 12px;text-align:center;${s.amPct < 70 ? "color:#b91c1c;font-weight:700;" : ""}">${statusEmoji(s.amPct)} ${s.amPct}%${s.amMiss > 0 ? ` <span style="color:#ef4444;font-size:12px;">(${s.amMiss} missed)</span>` : ""}</td>
       <td style="padding:8px 12px;text-align:center;${s.pmPct < 70 ? "color:#b91c1c;font-weight:700;" : ""}">${statusEmoji(s.pmPct)} ${s.pmPct}%${s.pmMiss > 0 ? ` <span style="color:#ef4444;font-size:12px;">(${s.pmMiss} missed)</span>` : ""}</td>
    </tr>`).join("");

  const modRows = modules.map(m => `
    <tr style="border-bottom:1px solid #e5e7eb;">
       <td style="padding:6px 12px;">${escapeHtml(m.module)}</td>
      <td style="padding:6px 12px;text-align:right;font-weight:600;">${m.count}</td>
    </tr>`).join("");

  const sitesWithIssues = sites.filter(s => s.amPct < 70 || s.pmPct < 70);
  const alertBanner = sitesWithIssues.length > 0 ? `
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;margin:20px 0;border-radius:4px;">
      <strong style="color:#b91c1c;">⚠️ Attention needed:</strong>
       <span style="color:#7f1d1d;"> ${sitesWithIssues.map(s => escapeHtml(s.name)).join(", ")} ${sitesWithIssues.length === 1 ? "has" : "have"} AM or PM checklist completion below 70%.</span>
     </div>` : sites.length === 0 ? `<p>No sites were available for this month.</p>` : `
    <div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:12px 16px;margin:20px 0;border-radius:4px;">
      <strong style="color:#15803d;">✅ Great work!</strong>
      <span style="color:#166534;"> All sites are at 70% compliance or above.</span>
    </div>`;

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#1e3a5f;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:20px;">ComplyTrack — Monthly Compliance Summary</h1>
    <p style="color:#93c5fd;margin:4px 0 0;">${label} · ${totalDays} days · ${sites.length} site${sites.length !== 1 ? "s" : ""}</p>
  </div>

  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
    ${alertBanner}

    <h2 style="font-size:16px;margin:24px 0 12px;">Daily Checklist Compliance</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
          <th style="padding:8px 12px;text-align:left;">Site</th>
          <th style="padding:8px 12px;text-align:center;">AM</th>
          <th style="padding:8px 12px;text-align:center;">PM</th>
        </tr>
      </thead>
      <tbody>${siteRows || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#6b7280;">No sites found</td></tr>'}</tbody>
    </table>

    ${modules.length > 0 ? `
    <h2 style="font-size:16px;margin:24px 0 12px;">Module Activity (${totalRecords} total records)</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f9fafb;border-bottom:2px solid #e5e7eb;">
          <th style="padding:6px 12px;text-align:left;">Module</th>
          <th style="padding:6px 12px;text-align:right;">Records logged</th>
        </tr>
      </thead>
      <tbody>${modRows}</tbody>
    </table>` : `<p style="color:#6b7280;font-size:14px;">No module records were logged this month.</p>`}

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="color:#6b7280;font-size:12px;margin:0;">
      This summary was generated automatically by ComplyTrack. Log in to view the full report with filters and export options.
    </p>
  </div>
</body>
</html>`;
}

export function buildEmailText(label: string, data: Awaited<ReturnType<typeof fetchComplianceForClient>>): string {
  const { sites, modules, totalDays } = data;
  const lines = [
    `ComplyTrack — Monthly Compliance Summary`,
    `${label} · ${totalDays} days · ${sites.length} site(s)`,
    "",
    "DAILY CHECKLIST COMPLIANCE",
    ...sites.map(s => `  ${s.amPct < 70 || s.pmPct < 70 ? "ATTENTION (<70%): " : ""}${s.name}: AM ${s.amPct}%${s.amMiss > 0 ? ` (${s.amMiss} missed)` : ""} / PM ${s.pmPct}%${s.pmMiss > 0 ? ` (${s.pmMiss} missed)` : ""}`),
    "",
    "MODULE ACTIVITY",
    ...modules.map(m => `  ${m.module}: ${m.count} records`),
    "",
    "Log in to ComplyTrack to view the full interactive report.",
  ];
  return lines.join("\n");
}

// ─── Job entry point ──────────────────────────────────────────────────────────

type MonthlyDelivery = {
  id: number;
  user_id: number;
  recipient_email: string;
  subject: string;
  html: string;
  body_text: string;
};

export async function runMonthlyComplianceSummaryJob(
  send: typeof sendEmail = sendEmail,
  now = new Date(),
): Promise<{ sent: number; skipped: number; errors: number }> {
  const { from, to, label } = lastMonthRange(now);
  const monthKey = from.slice(0, 7);
  // A short catch-up window handles downtime on the 1st without sending
  // stale summaries weeks later. Once a batch exists, retries are independent
  // of this window.
  const londonDay = Number(new Intl.DateTimeFormat("en-GB", {
    day: "numeric", timeZone: "Europe/London",
  }).format(now));
  const canInitialize = londonDay <= 7;
  let sent = 0, skipped = 0, errors = 0;

  // Get all clients that have at least one admin user
  const clientsRes = await db.execute(sql`
    SELECT id AS client_id, name AS client_name
    FROM clients
    WHERE active = true
    ORDER BY id
  `);

  const clients = clientsRes.rows as { client_id: number; client_name: string }[];

  for (const { client_id: clientId, client_name: clientName } of clients) {
    try {
      const batch = await db.execute(sql`
        SELECT 1 FROM monthly_compliance_batches
        WHERE client_id = ${clientId} AND month_key = ${monthKey}
      `);
      if (batch.rows.length === 0 && canInitialize) {
        const adminsRes = await db.execute(sql`
          SELECT id, email FROM users
          WHERE client_id = ${clientId} AND role = 'client_admin' AND active = true
          ORDER BY id
        `);
        const admins = adminsRes.rows as { id: number; email: string }[];
        if (admins.length > 0) {
          const data = await fetchComplianceForClient(clientId, from, to);
          const subject = `ComplyTrack Compliance Summary — ${label}`;
          const html = buildEmailHtml(label, data);
          const text = buildEmailText(label, data);
          // A single transaction publishes the complete recipient snapshot.
          // If the process dies before commit, neither batch nor individual
          // rows are visible; the next run can safely initialize it again.
          await db.transaction(async tx => {
            const inserted = await tx.execute(sql`
              INSERT INTO monthly_compliance_batches (client_id, month_key)
              VALUES (${clientId}, ${monthKey})
              ON CONFLICT (client_id, month_key) DO NOTHING
              RETURNING id
            `);
            if (inserted.rows.length === 0) return;
            for (const admin of admins) {
              await tx.execute(sql`
                INSERT INTO monthly_compliance_deliveries
                  (client_id, user_id, month_key, recipient_email, subject, html, body_text)
                VALUES (${clientId}, ${admin.id}, ${monthKey}, ${admin.email}, ${subject}, ${html}, ${text})
                ON CONFLICT (client_id, user_id, month_key) DO NOTHING
              `);
            }
          });
        }
      }
      const pending = await db.execute(sql`
        SELECT id, user_id, recipient_email, subject, html, body_text
        FROM monthly_compliance_deliveries
        WHERE client_id = ${clientId} AND month_key = ${monthKey}
          AND state <> 'sent'
        ORDER BY id
      `);
      if (pending.rows.length === 0) {
        skipped++;
        continue;
      }
      for (const entry of pending.rows as unknown as MonthlyDelivery[]) {
          const admin = { id: entry.user_id };
         try {
           const leaseToken = randomUUID();
           const claim = await db.execute(sql`
             UPDATE monthly_compliance_deliveries
             SET state = 'sending', lease_token = ${leaseToken},
                 lease_expires_at = now() + interval '15 minutes'
             WHERE client_id = ${clientId} AND user_id = ${admin.id} AND month_key = ${monthKey}
               AND (state = 'pending' OR
                    (state = 'sending' AND lease_expires_at < now()))
             RETURNING id, user_id, recipient_email, subject, html, body_text
           `);
           const delivery = (claim.rows as unknown as MonthlyDelivery[])[0];
           if (!delivery) {
             skipped++;
             continue;
           }
           let accepted = false;
           try {
             await send({
               to: delivery.recipient_email,
               subject: delivery.subject,
               html: delivery.html,
               text: delivery.body_text,
               clientId,
               idempotencyKey: `monthly-compliance-${clientId}-${admin.id}-${monthKey}`,
             });
             accepted = true;
             await db.execute(sql`
               UPDATE monthly_compliance_deliveries
               SET state = 'sent', sent_at = now(), lease_token = NULL,
                   lease_expires_at = NULL
               WHERE id = ${delivery.id} AND lease_token = ${leaseToken}
             `);
             sent++;
           } catch (err) {
             if (!accepted) {
               await db.execute(sql`
                 UPDATE monthly_compliance_deliveries
                 SET state = 'pending', lease_token = NULL, lease_expires_at = NULL
                 WHERE id = ${delivery.id} AND lease_token = ${leaseToken}
               `);
             }
             throw err;
           }
         } catch (err) {
           logger.error({ err, clientId, userId: admin.id }, "Failed to send monthly compliance summary");
           errors++;
         }
       }
        logger.info({ clientId, clientName, recipients: pending.rows.length }, "Monthly compliance summary processed");
    } catch (err) {
      logger.error({ err, clientId }, "Failed to send monthly compliance summary");
      errors++;
    }
  }

  return { sent, skipped, errors };
}
