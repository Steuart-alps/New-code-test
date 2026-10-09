/**
 * Daily contractor-compliance-expiry reminder job.
 *
 * For each active client, alerts the client's managers (client_admin users and
 * maintenance managers) when a contractor's:
 *   - public liability insurance expires within the client's configured lead time or has already expired, or
 *   - entered DBS/PVG expiry or certificate expiry is within 60 or 30 days, or
 *   - a legacy DBS check without an expiry is older than 3 years.
 *
 * Sends an email digest (Resend-based, mirroring fixTrackOverdueAlerts) plus a
 * best-effort mobile push (route hint /contractors).
 *
 * De-duplication: one row per (client, contractor, milestone) in
 * contractor_compliance_reminder_log. The milestone encodes the exact date the
 * reminder was raised against (e.g. "insurance:2025-03-01" or "dbs:2022-01-01"),
 * so a renewed insurance/DBS date produces a new milestone and re-alerts, while
  * the same milestone is never re-sent. DBS/PVG and certificate expiry dates
  * have separate :60 and :30 claims. Rows are claimed BEFORE sending so
 * concurrent runs can't double-send; the claim is released if the send fails.
 */

import { db } from "@workspace/db";
import { appSettingsTable, clientsTable } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendEmail, getPublicAppUrl } from "./email";
import { getNotificationEmails } from "./getNotificationEmails";
import { sendPushToUsers } from "./pushNotifications";
import { digestBearerToken, newBearerToken, encryptTokenPayload } from "./bearerTokens";

/** Insurance is flagged when it expires within this many days (or has expired). */
export const DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS = 30;
export const MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS = 0;
export const MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS = 365;
/** Backwards-compatible name for callers that use the default window. */
export const INSURANCE_LEAD_DAYS = DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS;
/** DBS checks older than this many years are flagged for re-check. */
export const DBS_MAX_AGE_YEARS = 3;
export const CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING = "contractorComplianceLeadTimeDays";

/** Date-only reminder buckets: late runs catch up without sending both at once. */
function expiryReminderBucket(expiryDate: string, now: Date): 60 | 30 | null {
  const expiry = Date.parse(`${expiryDate.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(expiry)) return null;
  const daysLeft = Math.round((expiry - today) / 86_400_000);
  return daysLeft > 60 ? null : daysLeft > 30 ? 60 : 30;
}

export function parseContractorComplianceLeadDays(value: unknown): number | null {
  const normalized = typeof value === "number" ? value : String(value ?? "").trim();
  if (normalized === "") return null;
  const parsed = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isSafeInteger(parsed)
    || parsed < MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS
    || parsed > MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS) {
    return null;
  }
  return parsed;
}

async function getClientContractorComplianceLeadDays(clientId: number): Promise<number> {
  const [setting] = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(
      eq(appSettingsTable.clientId, clientId),
      eq(appSettingsTable.key, CONTRACTOR_COMPLIANCE_LEAD_TIME_SETTING),
    ))
    .limit(1);
  return parseContractorComplianceLeadDays(setting?.value) ?? DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS;
}

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
  dbs_check_date: string | null;
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
  leadDays = DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
): Promise<ContractorComplianceAlert[]> {
  const contractorResult = await db.execute(sql`
    SELECT id, name, email, company,
           public_liability_expiry,
            dbs_check_date, dbs_type, dbs_expiry_date::date::text AS dbs_expiry_date
    FROM contractors
    WHERE client_id = ${clientId}
    ORDER BY name ASC
  `);
  const rows = (contractorResult.rows ?? []) as unknown as ContractorRow[];

  // Also pull contractor certificates with their contractor info joined.
  const certResult = await db.execute(sql`
    SELECT cc.id, cc.contractor_id, cc.certificate_name,
           cc.expiry_date::date::text AS expiry_date,
           c.name AS contractor_name, c.email AS contractor_email, c.company AS contractor_company
    FROM contractor_certificates cc
    JOIN contractors c ON c.id = cc.contractor_id AND c.client_id = cc.client_id
    WHERE cc.client_id = ${clientId}
      AND cc.expiry_date IS NOT NULL
    ORDER BY cc.expiry_date ASC
  `);
  const certRows = (certResult.rows ?? []) as unknown as ContractorCertRow[];

  const normalizedLeadDays = parseContractorComplianceLeadDays(leadDays)
    ?? DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS;
  const insuranceThreshold = new Date(now.getTime() + normalizedLeadDays * 24 * 60 * 60 * 1000);

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

    // Prefer an explicit DBS/PVG expiry date. For older records without one,
    // retain the original rule and alert once the check date reaches 3 years.
    if (c.dbs_type !== "None" && c.dbs_expiry_date) {
      const expiryDate = String(c.dbs_expiry_date).slice(0, 10);
      const bucket = expiryReminderBucket(expiryDate, now);
      if (bucket !== null) {
        const expiry = new Date(`${expiryDate}T00:00:00Z`);
        const expired = expiryDate < now.toISOString().slice(0, 10);
        const label = c.dbs_type ?? "DBS/PVG check";
        alerts.push({
          contractorId: c.id, contractorName: c.name, contractorEmail: c.email, company: c.company,
          kind: "dbs",
          milestone: `dbs-expiry:${expiryDate}:${bucket}`,
          detail: expired
            ? `${label} expired on ${fmtDate(expiry)}`
            : `${label} expires on ${fmtDate(expiry)}`,
        });
      }
    } else if (c.dbs_type !== "None" && !c.dbs_expiry_date && c.dbs_check_date) {
      const checkDate = new Date(c.dbs_check_date);
      if (!Number.isNaN(checkDate.getTime())) {
        const staleAt = new Date(checkDate);
        staleAt.setUTCFullYear(staleAt.getUTCFullYear() + DBS_MAX_AGE_YEARS);
        if (staleAt <= now) {
          const label = c.dbs_type ?? "DBS/PVG check";
          alerts.push({
            contractorId: c.id, contractorName: c.name, contractorEmail: c.email, company: c.company,
            kind: "dbs",
            milestone: `dbs-check:${checkDate.toISOString().slice(0, 10)}`,
            detail: `${label} completed on ${fmtDate(checkDate)} is over ${DBS_MAX_AGE_YEARS} years old`,
          });
        }
      }
    }
  }

  // Contractor certificates.
  for (const cert of certRows) {
    if (!cert.expiry_date) continue;
    const expiryDate = String(cert.expiry_date).slice(0, 10);
    const bucket = expiryReminderBucket(expiryDate, now);
    if (bucket === null) continue;
    const expiry = new Date(`${expiryDate}T00:00:00Z`);
    const expired = expiryDate < now.toISOString().slice(0, 10);
    alerts.push({
      contractorId: cert.contractor_id,
      contractorName: cert.contractor_name,
      contractorEmail: cert.contractor_email,
      company: cert.contractor_company,
      kind: "cert",
      milestone: `cert:${cert.id}:${expiryDate}:${bucket}`,
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
         ${alerts.length} contractor compliance item${alerts.length !== 1 ? "s need" : " needs"} attention — an insurance policy, DBS/PVG check or certificate needs review. Please chase renewals or update the records in ComplyTrack.
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

/**
 * Portal reminders have their own 60/30-day clock, independent of the
 * manager's configurable insurance digest and of manager email availability.
 */
async function queuePortalReminders(clientId: number, clientName: string, now: Date, appUrl: string): Promise<void> {
  const alerts = await getContractorComplianceAlerts(clientId, now, 60);
  const portalAlerts = alerts.flatMap((alert) => {
    let item: string | null = null;
    let expiry: string | null = null;
    if (alert.kind === "insurance") {
      expiry = alert.milestone.slice("insurance:".length);
      item = "insurance";
    } else if (alert.kind === "cert") {
      const match = /^cert:(\d+):(\d{4}-\d{2}-\d{2}):(60|30)$/.exec(alert.milestone);
      if (match) {
        item = `cert:${match[1]}`;
        expiry = match[2];
      }
    } else if (alert.kind === "dbs" && alert.milestone.startsWith("dbs-expiry:")) {
      expiry = alert.milestone.split(":")[1];
      item = "dbs";
    }
    if (!item || !expiry || !alert.contractorEmail) return [];
    const bucket = expiryReminderBucket(expiry, now);
    if (bucket === null) return [];
    return [{ ...alert, milestone: `portal-${bucket}d:${item}:${expiry}`, bucket, item, expiry }];
  });
  const byContractor = new Map<number, typeof portalAlerts>();
  for (const alert of portalAlerts) {
    const group = byContractor.get(alert.contractorId) ?? [];
    group.push(alert);
    byContractor.set(alert.contractorId, group);
  }
  // A renewed/deleted item can remove its contractor from the alert scan
  // entirely. Still inspect pending drafts before they can be approved later.
  const pendingOwners = await db.execute(sql`
    SELECT DISTINCT contractor_id FROM contractor_email_queue
    WHERE client_id=${clientId} AND entity_type='contractor_compliance' AND status='pending'
  `);
  for (const row of pendingOwners.rows) {
    const id = Number(row.contractor_id);
    if (!byContractor.has(id)) byContractor.set(id, []);
  }

  for (const [contractorId, group] of byContractor) {
    // Lock the parent before looking at prior claims, including concurrent job
    // runs. A failed insert, encryption or token write rolls back every claim.
    await db.transaction(async (tx) => {
      const contractor = (await tx.execute(sql`
        SELECT updated_at, email, public_liability_expiry, dbs_type,
          dbs_expiry_date::date::text AS dbs_expiry_date
        FROM contractors
        WHERE client_id=${clientId} AND id=${contractorId} FOR UPDATE
      `)).rows[0] as {
        updated_at: Date; email: string; public_liability_expiry: Date | null;
        dbs_type: string | null; dbs_expiry_date: string | null;
      } | undefined;
      if (!contractor?.email) return;
      // Manager reissue/revoke UPDATE this same canonical row. Hold its lock
      // through draft creation, and never resurrect an explicitly revoked link.
      const canonical = (await tx.execute(sql`
        SELECT id, token_hash, revoked_at FROM contractor_portal_tokens
        WHERE contractor_id=${contractorId} FOR UPDATE
      `)).rows[0] as { id: number; token_hash: string; revoked_at: Date | null } | undefined;
      if (canonical?.revoked_at) return;
      // Lock *all* active drafts before deciding to revoke any of them. The
      // approval endpoint changes pending -> sending via UPDATE, which must
      // contend for this same row lock. If approval won, defer replacement.
      const activeDrafts = await tx.execute(sql`
        SELECT id, status, idempotency_key, email_preview_json FROM contractor_email_queue
        WHERE client_id=${clientId} AND contractor_id=${contractorId}
          AND entity_type='contractor_compliance' AND status IN ('pending','approved','sending')
        ORDER BY id FOR UPDATE
      `);
      if (activeDrafts.rows.some(row => row.status === "approved" || row.status === "sending")) return;
      for (const draft of activeDrafts.rows) {
        const preview = draft.email_preview_json as { complianceItems?: { item: string; expiry: string }[] } | null;
        // Legacy drafts recorded claimed items in the idempotency key. New
        // drafts record every item in their full summary, not only new claims.
        const items = preview?.complianceItems ?? Array.from(
          String(draft.idempotency_key).matchAll(/portal-(?:60|30)d:(insurance|dbs|cert:\d+):(\d{4}-\d{2}-\d{2})/g),
          match => ({ item: match[1], expiry: match[2] }),
        );
        let stale = false;
        for (const item of items) {
          let expiry: string | null = null;
          if (item.item === "insurance") {
            expiry = contractor.public_liability_expiry
              ? new Date(contractor.public_liability_expiry).toISOString().slice(0, 10) : null;
          } else if (item.item === "dbs") {
            expiry = contractor.dbs_type === "None" ? null : contractor.dbs_expiry_date;
          } else if (/^cert:\d+$/.test(item.item)) {
            const cert = (await tx.execute(sql`
              SELECT expiry_date::date::text AS expiry_date FROM contractor_certificates
              WHERE client_id=${clientId} AND contractor_id=${contractorId}
                AND id=${Number(item.item.slice(5))} FOR UPDATE
            `)).rows[0];
            expiry = (cert?.expiry_date as string | null) ?? null;
          }
          if (expiry !== item.expiry || expiryReminderBucket(item.expiry, now) === null) {
            stale = true;
            break;
          }
        }
        if (stale) {
          await tx.execute(sql`
            UPDATE contractor_email_queue SET status='cancelled',
              last_error='Compliance item renewed, removed or no longer due', updated_at=now()
            WHERE id=${draft.id} AND status='pending'
          `);
        }
      }
      const claimed: typeof group = [];
      const currentAlerts: typeof group = [];
      for (const alert of group) {
        // Candidates were scanned outside the transaction. A renewal or
        // deletion while we waited for the parent lock must not queue an old
        // expiry. Lock certificate rows too before checking their date.
        let currentExpiry: string | null = null;
        if (alert.item === "insurance") {
          const insurance = contractor.public_liability_expiry
            ? new Date(contractor.public_liability_expiry) : null;
          currentExpiry = insurance && !Number.isNaN(insurance.getTime())
            ? insurance.toISOString().slice(0, 10) : null;
        } else if (alert.item === "dbs") {
          currentExpiry = contractor.dbs_type === "None" ? null : contractor.dbs_expiry_date;
        } else if (alert.item.startsWith("cert:")) {
          const certId = Number(alert.item.slice("cert:".length));
          const cert = (await tx.execute(sql`
            SELECT expiry_date::date::text AS expiry_date FROM contractor_certificates
            WHERE client_id=${clientId} AND contractor_id=${contractorId}
              AND id=${certId} FOR UPDATE
          `)).rows[0] as { expiry_date: string | null } | undefined;
          currentExpiry = cert?.expiry_date ?? null;
        }
        if (currentExpiry !== alert.expiry) continue;
        currentAlerts.push(alert);
        if (alert.bucket === 30) {
          const previous = (await tx.execute(sql`
            SELECT sent_at FROM contractor_compliance_reminder_log
            WHERE client_id=${clientId} AND contractor_id=${contractorId}
              AND milestone=${`portal-60d:${alert.item}:${alert.expiry}`}
          `)).rows[0] as { sent_at: Date } | undefined;
          // With no earlier claim the 30-day run is a legitimate catch-up.
          if (previous && new Date(contractor.updated_at) > new Date(previous.sent_at)) continue;
        }
        const claim = await tx.execute(sql`
          INSERT INTO contractor_compliance_reminder_log (client_id,contractor_id,milestone,sent_at)
          VALUES (${clientId},${contractorId},${alert.milestone},${now})
          ON CONFLICT (client_id,contractor_id,milestone) DO NOTHING RETURNING id
        `);
        if (claim.rows.length) claimed.push(alert);
      }
      if (!claimed.length) return; // Dedupe must never rotate a valid token.

      // The queue's active-draft index allows only one pending entry per
      // contractor. Cancel stale pending compliance drafts in the same commit
      // that creates the replacement, without invalidating delivered links.
      await tx.execute(sql`
        UPDATE contractor_email_queue SET status='cancelled',
          last_error='Superseded by newer compliance reminder', updated_at=now()
        WHERE client_id=${clientId} AND contractor_id=${contractorId}
          AND entity_type='contractor_compliance' AND status='pending'
      `);
      const token = newBearerToken();
      const portalUrl = `${appUrl}/contractor-portal/${token}`;
      const html = buildContractorEmailHtml(
        group[0].contractorName, currentAlerts, clientName, portalUrl,
      ).replaceAll(portalUrl, "{{PORTAL_URL}}");
      const encryptedPortal = encryptTokenPayload({ portal: portalUrl });
      const subject = "Compliance renewal reminder — please update your details";
      const key = `contractor-portal-${clientId}-${contractorId}-${claimed.map(a => a.milestone).sort().join("-")}`;
      const queued = await tx.execute(sql`
        INSERT INTO contractor_email_queue
          (client_id,entity_type,entity_id,contractor_id,email_type,mode,to_email,
           subject,body_html,email_preview_json,encrypted_token_payload,idempotency_key)
        VALUES (${clientId},'contractor_compliance',${contractorId},${contractorId},
          'reminder','assign',${contractor.email},${subject},${html},
          ${JSON.stringify({ subject, html, text: "", complianceItems: currentAlerts.map(({ item, expiry }) => ({ item, expiry })) })}::jsonb,${encryptedPortal},${key})
        RETURNING id
      `);
      if (!queued.rows.length) throw new Error("Contractor portal reminder was not queued");
      if (canonical) {
        await tx.execute(sql`
          INSERT INTO contractor_portal_reminder_tokens
            (portal_token_id, issuance_hash, token_hash, expires_at)
          VALUES (${canonical.id},${canonical.token_hash},${digestBearerToken(token)},
            ${new Date(now.getTime() + 90 * 86_400_000)})
        `);
      } else {
        // A first scheduler issuance remains compatible with manager issuance.
        // A concurrent manager INSERT wins safely: rollback/retry rather than
        // overwrite its token or revocation state.
        await tx.execute(sql`
        INSERT INTO contractor_portal_tokens (client_id,contractor_id,token,token_hash,expires_at)
        VALUES (${clientId},${contractorId},NULL,${digestBearerToken(token)},
          ${new Date(now.getTime() + 90 * 86_400_000)})
      `);
      }
    });
  }
}

export interface ContractorComplianceJobResult {
  clientsChecked: number;
  clientsAlerted: number;
  emailsSent: number;
  remindersClaimed: number;
  errors: number;
}

type EmailSender = typeof sendEmail;
type PushSender = typeof sendPushToUsers;

export async function runContractorComplianceReminderJob(
  send: EmailSender = sendEmail,
  sendPush: PushSender = sendPushToUsers,
  now: Date = new Date(),
): Promise<ContractorComplianceJobResult> {
  const result: ContractorComplianceJobResult = {
    clientsChecked: 0,
    clientsAlerted: 0,
    emailsSent: 0,
    remindersClaimed: 0,
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
      // Contractor drafts are independent of both the manager's lead-time
      // setting and the presence of any manager notification recipients.
      try {
        await queuePortalReminders(client.id, client.name, now, appUrl);
      } catch (portalErr) {
        result.errors++;
        logger.error({ err: portalErr, clientId: client.id }, "Contractor portal reminder queue failed");
      }
      const leadDays = await getClientContractorComplianceLeadDays(client.id);
      const candidates = await getContractorComplianceAlerts(client.id, now, leadDays);
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

        // Resolve notification recipients (client-level email or admin/maintenance-manager users).
        const { emails, userIds } = await getNotificationEmails(client.id, { includeMaintenanceManagers: true });

        if (emails.length === 0) {
          // No one to notify — release the claims so a later run (once managers
          // exist) can re-send.
          await releaseClaims(client.id, claimed);
          continue;
        }

        const subject = `⚠️ ${claimed.length} contractor compliance item${claimed.length !== 1 ? "s" : ""} need attention — ComplyTrack`;
        await send({ to: emails, subject, html: buildManagerEmailHtml(claimed, appUrl) });
        sent = true;

        // Push managers a matching alert (best-effort; never blocks the job).
        await sendPush(userIds, {
          title: "Contractor compliance expiring",
          body: `${claimed.length} contractor compliance item${claimed.length !== 1 ? "s" : ""} need attention.`,
          data: { route: "/contractors" },
        });

        result.clientsAlerted++;
        result.emailsSent += emails.length;
        logger.info(
          { clientId: client.id, alerts: claimed.length, emails: emails.length },
          "Manager alerts sent and contractor reminders queued for approval",
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
