/**
 * Monthly compliance summary email
 *
 * Runs on the 1st of each month at 08:05. For every active client it:
 *  1. Computes the previous calendar-month compliance figures.
 *  2. Emails all client_admin users a plain-English summary.
 *
 * "Active" means the client has at least one active (non-viewer) user —
 * cancelled/deleted clients will have had their data removed already.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendEmail, getEmailSettings } from "./email";
import { logger } from "./logger";

// ─── Date helpers ────────────────────────────────────────────────────────────

function lastMonthRange(): { from: string; to: string; label: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to   = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month
  const label = from.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return {
    from:  from.toISOString().slice(0, 10),
    to:    to.toISOString().slice(0, 10),
    label,
  };
}

function daysInRange(from: string, to: string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return Math.floor((b - a) / 86400000) + 1;
}

// ─── Compliance queries ───────────────────────────────────────────────────────

interface SiteRow      { id: number; name: string; }
interface ChecklistRow { site_id: number; checklist_type: string; submitted: number; }
interface ModuleRow    { module: string; count: number; }

async function fetchComplianceForClient(clientId: number, from: string, to: string) {
  const totalDays = daysInRange(from, to);

  const [sitesRes, checkRes, modRes] = await Promise.all([
    db.execute(sql`
      SELECT id, name FROM sites
      WHERE client_id = ${clientId}
      ORDER BY name
    `),

    db.execute(sql`
      SELECT
        s.id               AS site_id,
        t.checklist_type,
        COUNT(DISTINCT dc.check_date)::int AS submitted
      FROM sites s
      CROSS JOIN (VALUES ('am'), ('pm')) AS t(checklist_type)
      LEFT JOIN daily_checklists dc
        ON  dc.site_id        = s.id
        AND dc.client_id      = ${clientId}
        AND dc.checklist_type = t.checklist_type
        AND dc.check_date     BETWEEN ${from} AND ${to}
        AND dc.submitted_at IS NOT NULL
      WHERE s.client_id = ${clientId}
      GROUP BY s.id, t.checklist_type
    `),

    db.execute(sql`
      SELECT module, COUNT(*)::int AS count
      FROM (
        SELECT 'FireTrack'      AS module FROM fire_safety_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'LegionellaTrack' FROM legionella_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'TubTrack'        FROM hot_tub_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'TreeTrack'       FROM tree_inspections
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'PremisesTrack'   FROM premises_inspections
          WHERE client_id = ${clientId} AND inspection_date BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'PestTrack'       FROM pest_visits
          WHERE client_id = ${clientId} AND visit_date      BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'IncidentTrack'   FROM incidents
          WHERE client_id = ${clientId} AND incident_date   BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'FoodSafety'      FROM food_safety_records
          WHERE client_id = ${clientId} AND record_date     BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'FixTrack'        FROM fix_track_issues
          WHERE client_id = ${clientId} AND reported_date   BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'KitchenTrack'    FROM kitchen_cleaning_logs
          WHERE client_id = ${clientId} AND log_date        BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'PoolTrack'       FROM pool_checks
          WHERE client_id = ${clientId} AND check_date      BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'SwimTrack'       FROM swim_sessions
          WHERE client_id = ${clientId} AND session_date    BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'PATtrack' FROM pat_tests t
          JOIN pat_appliances a ON a.id = t.appliance_id AND a.client_id = ${clientId}
          WHERE t.test_date BETWEEN ${from} AND ${to}
      ) sub
      GROUP BY module
      ORDER BY module
    `),
  ]);

  const sites  = sitesRes.rows  as unknown as SiteRow[];
  const checks = checkRes.rows  as unknown as ChecklistRow[];
  const mods   = modRes.rows    as unknown as ModuleRow[];

  // Build per-site checklist map
  const checkMap = new Map<string, number>();
  for (const r of checks) checkMap.set(`${r.site_id}:${r.checklist_type}`, Number(r.submitted));

  const siteCompliance = sites.map(s => {
    const amSub = checkMap.get(`${s.id}:am`) ?? 0;
    const pmSub = checkMap.get(`${s.id}:pm`) ?? 0;
    return {
      name:    s.name,
      amPct:   totalDays > 0 ? Math.round((amSub / totalDays) * 100) : 0,
      pmPct:   totalDays > 0 ? Math.round((pmSub / totalDays) * 100) : 0,
      amMiss:  Math.max(0, totalDays - amSub),
      pmMiss:  Math.max(0, totalDays - pmSub),
    };
  });

  const totalRecords = (mods as ModuleRow[]).reduce((acc, r) => acc + Number(r.count), 0);

  return { totalDays, sites: siteCompliance, modules: mods as ModuleRow[], totalRecords };
}

// ─── Email template ──────────────────────────────────────────────────────────

function statusEmoji(pct: number): string {
  if (pct >= 90) return "✅";
  if (pct >= 70) return "⚠️";
  return "❌";
}

function buildEmailHtml(label: string, data: Awaited<ReturnType<typeof fetchComplianceForClient>>): string {
  const { totalDays, sites, modules, totalRecords } = data;

  const siteRows = sites.map(s => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:8px 12px;">${s.name}</td>
      <td style="padding:8px 12px;text-align:center;">${statusEmoji(s.amPct)} ${s.amPct}%${s.amMiss > 0 ? ` <span style="color:#ef4444;font-size:12px;">(${s.amMiss} missed)</span>` : ""}</td>
      <td style="padding:8px 12px;text-align:center;">${statusEmoji(s.pmPct)} ${s.pmPct}%${s.pmMiss > 0 ? ` <span style="color:#ef4444;font-size:12px;">(${s.pmMiss} missed)</span>` : ""}</td>
    </tr>`).join("");

  const modRows = (modules as ModuleRow[]).map(m => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:6px 12px;">${m.module}</td>
      <td style="padding:6px 12px;text-align:right;font-weight:600;">${m.count}</td>
    </tr>`).join("");

  const sitesWithIssues = sites.filter(s => s.amPct < 70 || s.pmPct < 70);
  const alertBanner = sitesWithIssues.length > 0 ? `
    <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:12px 16px;margin:20px 0;border-radius:4px;">
      <strong style="color:#b91c1c;">⚠️ Attention needed:</strong>
      <span style="color:#7f1d1d;"> ${sitesWithIssues.map(s => s.name).join(", ")} ${sitesWithIssues.length === 1 ? "has" : "have"} compliance below 70%.</span>
    </div>` : `
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

function buildEmailText(label: string, data: Awaited<ReturnType<typeof fetchComplianceForClient>>): string {
  const { sites, modules, totalDays } = data;
  const lines = [
    `ComplyTrack — Monthly Compliance Summary`,
    `${label} · ${totalDays} days · ${sites.length} site(s)`,
    "",
    "DAILY CHECKLIST COMPLIANCE",
    ...sites.map(s => `  ${s.name}: AM ${s.amPct}%${s.amMiss > 0 ? ` (${s.amMiss} missed)` : ""} / PM ${s.pmPct}%${s.pmMiss > 0 ? ` (${s.pmMiss} missed)` : ""}`),
    "",
    "MODULE ACTIVITY",
    ...(modules as ModuleRow[]).map(m => `  ${m.module}: ${m.count} records`),
    "",
    "Log in to ComplyTrack to view the full interactive report.",
  ];
  return lines.join("\n");
}

// ─── Job entry point ──────────────────────────────────────────────────────────

export async function runMonthlyComplianceSummaryJob(): Promise<{ sent: number; skipped: number; errors: number }> {
  const { from, to, label } = lastMonthRange();
  let sent = 0, skipped = 0, errors = 0;

  // Get all clients that have at least one admin user
  const clientsRes = await db.execute(sql`
    SELECT DISTINCT u.client_id, c.name AS client_name
    FROM users u
    JOIN clients c ON c.id = u.client_id
    WHERE u.role IN ('client_admin', 'client_staff')
      AND u.active = true
      AND u.client_id IS NOT NULL
    ORDER BY u.client_id
  `);

  const clients = clientsRes.rows as { client_id: number; client_name: string }[];

  for (const { client_id: clientId, client_name: clientName } of clients) {
    try {
      // Get admin email addresses
      const adminsRes = await db.execute(sql`
        SELECT email FROM users
        WHERE client_id = ${clientId}
          AND role = 'client_admin'
          AND active = true
      `);
      const adminEmails = (adminsRes.rows as { email: string }[]).map(r => r.email);

      if (adminEmails.length === 0) {
        skipped++;
        continue;
      }

      const data = await fetchComplianceForClient(clientId, from, to);

      if (data.sites.length === 0) {
        skipped++;
        continue;
      }

      const settings = await getEmailSettings(clientId);
      const subject  = `ComplyTrack Compliance Summary — ${label}`;

      await sendEmail({
        to:       adminEmails,
        subject,
        html:     buildEmailHtml(label, data),
        text:     buildEmailText(label, data),
        clientId,
      });

      logger.info({ clientId, clientName, admins: adminEmails.length }, "Monthly compliance summary sent");
      sent++;
    } catch (err) {
      logger.error({ err, clientId }, "Failed to send monthly compliance summary");
      errors++;
    }
  }

  return { sent, skipped, errors };
}
