/**
 * Daily contractor-compliance-expiry reminder job.
 *
 * For each active client, alerts the client's managers (client_admin users and
 * maintenance managers) when a contractor's:
 *   - public liability insurance expires within 30 days or has already expired, or
 *   - DBS check is older than 3 years (or missing a renewal for that long).
 *
 * Sends an email digest (Resend-based, mirroring fixTrackOverdueAlerts) plus a
 * best-effort mobile push (route hint /contractors).
 *
 * De-duplication: one row per (client, contractor, milestone) in
 * contractor_compliance_reminder_log. The milestone encodes the exact date the
 * reminder was raised against (e.g. "insurance:2025-03-01" or "dbs:2022-01-01"),
 * so a renewed insurance/DBS date produces a new milestone and re-alerts, while
 * the same milestone is never re-sent. Rows are claimed BEFORE sending so
 * concurrent runs can't double-send; the claim is released if the send fails.
 */

import { randomBytes } from "crypto";
import { db } from "@workspace/db";
import { clientsTable, usersTable } from "@workspace/db/schema";
import { and, eq, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { sendPushToUsers } from "./pushNotifications";

/** Insurance is flagged when it expires within this many days (or has expired). */
export const INSURANCE_LEAD_DAYS = 30;
/** DBS checks older than this many years are flagged for re-check. */
export const DBS_MAX_AGE_YEARS = 3;

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** A single compliance issue found for one contractor. */
export interface ContractorComplianceAlert {
  contractorId: number;
  contractorName: string;
  contractorEmail: string;
  company: string | null;
  kind: "insurance" | "indemnity" | "dbs" | "cert";
  /** Stable milestone key for dedupe, e.g. "insurance:2025-03-01". */
  milestone: string;
  /** Human-readable detail line for the email/push. */
  detail: string;
}

interface ContractorRow {
  id: number;
  name: string;
  email: string;
  company: string | null;
  public_liability_expiry: string | null;
  dbs_type: string | null;
  dbs_expiry_date: string | null;
}

interface ContractorCertRow {
  id: number;
  contractor_id: number;
  contractor_name: string;
  contractor_email: string;
  contractor_company: string | null;
  certificate_name: string;
  expiry_date: string | null;
}

/** Compute the compliance alerts due for a client's contractors right now. */
export async function getContractorComplianceAlerts(
  clientId: number,
  now: Date,
): Promise<ContractorComplianceAlert[]> {
  const contractorResult = await db.execute(sql`
    SELECT id, name, email, company,
           public_liability_expiry,
           dbs_type, dbs_expiry_date
    FROM contractors
    WHERE client_id = ${clientId}
    ORDER BY name ASC
  `);
  const rows = (contractorResult.rows ?? []) as unknown as ContractorRow[];

  // Also pull contractor certificates with their contractor info joined.
  const certResult = await db.execute(sql`
    SELECT cc.id, cc.contractor_id, cc.certificate_name, cc.expiry_date,
           c.name AS contractor_name, c.email AS contractor_email, c.company AS contractor_company
    FROM contractor_certificates cc
    JOIN contractors c ON c.id = cc.contractor_id
    WHERE cc.client_id = ${clientId}
      AND cc.expiry_date IS NOT NULL
    ORDER BY cc.expiry_date ASC
  `);
  const certRows = (certResult.rows ?? []) as unknown as ContractorCertRow[];

  const insuranceThreshold = new Date(now.getTime() + INSURANCE_LEAD_DAYS * 24 * 60 * 60 * 1000);

  const alerts: ContractorComplianceAlert[] = [];

  for (const c of rows) {
    // Insurance renewal (single date covers all policies).
    if (c.public_liability_expiry) {
      const expiry = new Date(c.public_liability_expiry);
      if (!Number.isNaN(expiry.getTime()) && expiry <= insuranceThreshold) {
        const expired = expiry < now;
        alerts.push({
          contractorId: c.id, contractorName: c.name, contractorEmail: c.email, company: c.company,
          kind: "insurance",
          milestone: `insurance:${expiry.toISOString().slice(0, 10)}`,
          detail: expired
            ? `Insurance expired on ${fmtDate(expiry)}`
            : `Insurance expires on ${fmtDate(expiry)}`,
        });
      }
    }

    // DBS / PVG expiry date (new field — replaces the old "3 years since check" heuristic).
    if (c.dbs_expiry_date) {
      const expiry = new Date(c.dbs_expiry_date);
      if (!Number.isNaN(expiry.getTime()) && expiry <= insuranceThreshold) {
        const expired = expiry < now;
        const label = c.dbs_type ?? "DBS/PVG check";
        alerts.push({
          contractorId: c.id, contractorName: c.name, contractorEmail: c.email, company: c.company,
          kind: "dbs",
          milestone: `dbs-expiry:${expiry.toISOString().slice(0, 10)}`,
          detail: expired
            ? `${label} expired on ${fmtDate(expiry)}`
            : `${label} expires on ${fmtDate(expiry)}`,
        });
      }
    }
  }

  // Contractor certificates.
  for (const cert of certRows) {
    if (!cert.expiry_date) continue;
    const expiry = new Date(cert.expiry_date);
    if (Number.isNaN(expiry.getTime()) || expiry > insuranceThreshold) continue;
    const expired = expiry < now;
    alerts.push({
      contractorId: cert.contractor_id,
      contractorName: cert.contractor_name,
      contractorEmail: cert.contractor_email,
      company: cert.contractor_company,
      kind: "cert",
      milestone: `cert:${cert.id}:${expiry.toISOString().slice(0, 10)}`,
      detail: expired
        ? `${cert.certificate_name} certificate expired on ${fmtDate(expiry)}`
        : `${cert.certificate_name} certificate expires on ${fmtDate(expiry)}`,
    });
  }

  return alerts;
}

function kindLabel(kind: ContractorComplianceAlert["kind"]): string {
  if (kind === "insurance") return "Insurance";
  if (kind === "indemnity") return "Professional indemnity insurance";
  if (kind === "dbs") return "DBS / PVG check";
  return "Certificate";
}

/**
 * Generate (or refresh) a 90-day self-service portal token for a contractor.
 * One token per contractor — refreshed on each reminder so the link in the
 * latest email is always valid.
 */
export async function generateOrRefreshPortalToken(
  clientId: number,
  contractorId: number,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await db.execute(sql`
    INSERT INTO contractor_portal_tokens (client_id, contractor_id, token, expires_at)
    VALUES (${clientId}, ${contractorId}, ${token}, ${expiresAt})
    ON CONFLICT (contractor_id) DO UPDATE SET
      token      = EXCLUDED.token,
      expires_at = EXCLUDED.expires_at,
      created_at = now()
  `);
  return token;
}

/** Manager-facing digest: lists all contractor compliance alerts for a client. */
function buildManagerEmailHtml(alerts: ContractorComplianceAlert[], appUrl: string): string {
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(a.contractorName)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">
            ${a.company ? `${esc(a.company)} · ` : ""}${kindLabel(a.kind)}
          </div>
          <div style="font-size:12px;color:#b91c1c;margin-top:4px;">${esc(a.detail)}</div>
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
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Contractor compliance expiring</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        ${alerts.length} contractor compliance item${alerts.length !== 1 ? "s need" : " needs"} attention — insurance is expiring or a DBS check is out of date. Please chase renewals or update the records in ComplyTrack.
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

/** Contractor-facing email: includes their expiring items + a link to the self-service portal. */
function buildContractorEmailHtml(
  contractorName: string,
  alerts: ContractorComplianceAlert[],
  clientName: string,
  portalUrl?: string,
): string {
  const items = alerts
    .map((a) => `<li style="margin:6px 0;color:#b91c1c;font-size:14px;">${esc(a.detail)}</li>`)
    .join("");

  if (!items) return "";

  const portalSection = portalUrl
    ? `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:20px 0;">
        <p style="font-size:14px;font-weight:600;color:#166534;margin:0 0 8px;">✅ Update your records online</p>
        <p style="font-size:14px;color:#166534;margin:0 0 14px;">
          Use your personalised link to update your insurance renewal date, DBS details, and upload
          certificate documents directly — no email needed.
        </p>
        <a href="${esc(portalUrl)}" style="display:inline-block;background:#166534;color:#ffffff;text-decoration:none;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:600;">
          Update my details →
        </a>
        <p style="font-size:11px;color:#4ade80;margin:10px 0 0;">Link valid for 90 days · No account needed</p>
      </div>`
    : `
      <p style="font-size:15px;color:#334155;margin:0 0 20px;">
        Please send updated certificates to your account manager at ${esc(clientName)} at your
        earliest convenience so they can update their records.
      </p>`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:#0f172a;padding:32px 40px;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">🛡️ ComplyTrack</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">Compliance renewal reminder</div>
    </div>
    <div style="padding:32px 40px;">
      <p style="font-size:15px;color:#334155;margin:0 0 16px;">Dear ${esc(contractorName)},</p>
      <p style="font-size:15px;color:#334155;margin:0 0 16px;">
        Our records held by <strong>${esc(clientName)}</strong> show that the following item${alerts.length !== 1 ? "s are" : " is"} due for renewal soon:
      </p>
      <ul style="margin:0 0 20px;padding-left:20px;">${items}</ul>
      ${portalSection}
      <p style="font-size:14px;color:#64748b;margin:0;">
        If you have already renewed, you can update the date directly via your portal link above.
      </p>
    </div>
    <div style="padding:20px 40px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;text-align:center;">
      ComplyTrack by ALPS Consulting · Sent on behalf of ${esc(clientName)}.
    </div>
  </div>
</body>
</html>`;
}

export interface ContractorComplianceJobResult {
  clientsChecked: number;
  clientsAlerted: number;
  emailsSent: number;
  remindersClaimed: number;
  errors: number;
}

type EmailSender = typeof sendEmail;

export async function runContractorComplianceReminderJob(
  send: EmailSender = sendEmail,
): Promise<ContractorComplianceJobResult> {
  const result: ContractorComplianceJobResult = {
    clientsChecked: 0,
    clientsAlerted: 0,
    emailsSent: 0,
    remindersClaimed: 0,
    errors: 0,
  };
  const appUrl = getPublicAppUrl();
  const now = new Date();

  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .where(eq(clientsTable.active, true));

  for (const client of clients) {
    result.clientsChecked++;
    try {
      const candidates = await getContractorComplianceAlerts(client.id, now);
      if (candidates.length === 0) continue;

      // Claim each (contractor, milestone) first so we never re-send the same
      // reminder, and so concurrent runs can't double-send. Only the newly
      // claimed alerts are then emailed/pushed.
      const claimed: ContractorComplianceAlert[] = [];
      // Any failure after the first successful claim (a later claim insert, the
      // manager lookup, or the email send) must release every claimed row —
      // otherwise the unique dedupe rows would permanently suppress the alert.
      let sent = false;
      try {
        for (const alert of candidates) {
          const claim = await db.execute(sql`
            INSERT INTO contractor_compliance_reminder_log (client_id, contractor_id, milestone, sent_at)
            VALUES (${client.id}, ${alert.contractorId}, ${alert.milestone}, now())
            ON CONFLICT (client_id, contractor_id, milestone) DO NOTHING
            RETURNING id
          `);
          if (((claim as any).rows ?? []).length > 0) claimed.push(alert);
        }
        if (claimed.length === 0) continue;
        result.remindersClaimed += claimed.length;

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

        if (emails.length === 0) {
          // No one to notify — release the claims so a later run (once managers
          // exist) can re-send.
          await releaseClaims(client.id, claimed);
          continue;
        }

        const subject = `⚠️ ${claimed.length} contractor compliance item${claimed.length !== 1 ? "s" : ""} need attention — ComplyTrack`;
        await send({ to: emails, subject, html: buildManagerEmailHtml(claimed, appUrl) });
        sent = true;

        // Also email each contractor directly about their own expiring items.
        // Group by contractor so each gets one email covering all their alerts.
        const byContractor = new Map<number, ContractorComplianceAlert[]>();
        for (const a of claimed) {
          if (!byContractor.has(a.contractorId)) byContractor.set(a.contractorId, []);
          byContractor.get(a.contractorId)!.push(a);
        }
        for (const [contractorId, contractorAlerts] of byContractor) {
          const { contractorName, contractorEmail } = contractorAlerts[0];
          if (!contractorEmail) continue;
          // Generate / refresh the contractor's self-service portal token.
          let portalUrl: string | undefined;
          try {
            const portalToken = await generateOrRefreshPortalToken(client.id, contractorId);
            portalUrl = `${appUrl}/contractor-portal/${portalToken}`;
          } catch (tokenErr) {
            logger.warn({ err: tokenErr, contractorId }, "Failed to generate contractor portal token — sending email without link");
          }
          const html = buildContractorEmailHtml(contractorName, contractorAlerts, client.name, portalUrl);
          if (!html) continue;
          try {
            await send({
              to: [contractorEmail],
              subject: `Compliance renewal reminder — please update your details`,
              html,
            });
            result.emailsSent++;
          } catch (ctrErr) {
            // Best-effort: never fail the whole job because a contractor email bounced.
            logger.warn({ err: ctrErr, contractorEmail }, "Failed to send contractor compliance reminder");
          }
        }

        // Push managers a matching alert (best-effort; never blocks the job).
        await sendPushToUsers(userIds, {
          title: "Contractor compliance expiring",
          body: `${claimed.length} contractor compliance item${claimed.length !== 1 ? "s" : ""} need attention.`,
          data: { route: "/contractors" },
        });

        result.clientsAlerted++;
        result.emailsSent += emails.length;
        logger.info(
          { clientId: client.id, alerts: claimed.length, emails: emails.length, contractorEmails: byContractor.size },
          "Contractor compliance reminder sent",
        );
      } catch (innerErr) {
        if (!sent && claimed.length > 0) {
          try {
            await releaseClaims(client.id, claimed);
          } catch (releaseErr) {
            logger.error(
              { err: releaseErr, clientId: client.id },
              "Failed to release contractor compliance claims — these milestones may be suppressed",
            );
          }
        }
        throw innerErr;
      }
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId: client.id }, "Contractor compliance reminder failed");
    }
  }

  return result;
}

/** Release previously-claimed reminder rows so a later run retries. */
async function releaseClaims(clientId: number, alerts: ContractorComplianceAlert[]): Promise<void> {
  for (const a of alerts) {
    await db.execute(sql`
      DELETE FROM contractor_compliance_reminder_log
      WHERE client_id = ${clientId} AND contractor_id = ${a.contractorId} AND milestone = ${a.milestone}
    `);
  }
}
