/**
 * Certificate follow-up: a contractor visit that has happened but has no
 * certificate on its compliance check two weeks later. Certificates often
 * aren't issued until the contractor's invoice is paid, so the first chase
 * waits FOLLOW_UP_AFTER_DAYS.
 *
 * A visit has happened when its check (one with a contractor) was completed,
 * or when the date the contractor booked through the reminder link has
 * passed. A certificate counts when it was added to the check on or after the
 * visit day, or is dated (issue date) on or after it.
 *
 * FOLLOW_UP_AFTER_DAYS after the visit, then every FOLLOW_UP_EVERY_DAYS
 * while it is still missing:
 *   - the contractor is emailed asking for the certificate, with the people
 *     responsible copied in. It goes automatically, with no approval step
 *     (Steuart, 2026-10-21): the worst case is the contractor replying that
 *     they already sent it. Each send is recorded in contractor_email_queue;
 *     one that fails is left pending in Contractor Approvals for a manager,
 *     and is withdrawn if the certificate arrives first;
 *   - the people responsible (lib/dueItems.ts responsibleForCertificate: the
 *     person assigned, the site's Maintenance managers and heads of
 *     department; with none, its Managers, else the Owners) see it under
 *     "Certificates outstanding" in their 08:00 personal reminder that day.
 * Every Owner and Manager update lists the certificates outstanding for the
 * sites it covers, however old, until they are uploaded. No separate email.
 * Only visits from the last LOOK_BACK_DAYS are chased (six chases), so older
 * history never produces a burst of emails.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { loadResponsibilityContext, responsibleForCertificate, type ResponsibilityContext } from "./dueItems";
import { escapeHtml, parseEmailList } from "./email";
import { dispatchStoredContractorEmail } from "./fixTrackNotifications";
import { encryptTokenPayload, newBearerToken } from "./bearerTokens";
import {
  CERTIFICATE_UPLOAD_PLACEHOLDER, certificateReplyToFor, certificateUploadBlock, certificateUploadUrl, issueCertificateUploadLink,
} from "./certificateInbox";
import { logger } from "./logger";

export const FOLLOW_UP_AFTER_DAYS = 14;
export const FOLLOW_UP_EVERY_DAYS = 14;
export const LOOK_BACK_DAYS = 90;
export const CERTIFICATE_FOLLOW_UP_EMAIL_TYPE = "certificate_followup";

/** The chase due `today` for a visit (1 = the first), or null on other days. */
export function certificateChaseOn(visitDay: string, today: string): number | null {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${visitDay}T00:00:00Z`)) / 86_400_000);
  if (days < FOLLOW_UP_AFTER_DAYS || days >= LOOK_BACK_DAYS || (days - FOLLOW_UP_AFTER_DAYS) % FOLLOW_UP_EVERY_DAYS !== 0) return null;
  return (days - FOLLOW_UP_AFTER_DAYS) / FOLLOW_UP_EVERY_DAYS + 1;
}

/** The latest chase a visit is owed by `today` (1 = the first). */
function chasesOwed(visitDay: string, today: string): number {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${visitDay}T00:00:00Z`)) / 86_400_000);
  return Math.floor((days - FOLLOW_UP_AFTER_DAYS) / FOLLOW_UP_EVERY_DAYS) + 1;
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);
const day = (value: unknown) =>
  value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
});

export interface VisitAwaitingCertificate {
  itemId: number;
  clientId: number;
  title: string;
  siteId: number | null;
  siteName: string | null;
  siteDepartmentId: number | null;
  departmentId: number | null;
  visitDay: string;
  contractorId: number;
  contractorName: string;
  contractorCompany: string | null;
  contractorEmail: string | null;
  /** The person picked on the check ("Assigned to"). */
  assigneeUserId: number | null;
}

/**
 * Visits that happened at least `afterDays` days ago with no certificate yet:
 * within `lookBackDays` (default LOOK_BACK_DAYS, the chase window), or of any
 * age with `lookBackDays: null` (the Owner and Manager updates).
 */
export async function getVisitsAwaitingCertificate(
  clientId: number | null,
  {
    afterDays = FOLLOW_UP_AFTER_DAYS, today = new Date().toISOString().slice(0, 10), lookBackDays = LOOK_BACK_DAYS,
  }: { afterDays?: number; today?: string; lookBackDays?: number | null } = {},
): Promise<VisitAwaitingCertificate[]> {
  const result = await db.execute(sql`
    SELECT * FROM (
      SELECT ci.id AS item_id, ci.client_id, ci.title, ci.site_id, s.name AS site_name, ci.assignee_user_id,
        s.department_id AS site_department_id, ci.department_id,
        GREATEST(
          (ci.completed_at AT TIME ZONE 'UTC')::date,
          CASE WHEN (ci.visit_scheduled_at AT TIME ZONE 'UTC')::date <= ${today}::date
            THEN (ci.visit_scheduled_at AT TIME ZONE 'UTC')::date END
        ) AS visit_day,
        CASE WHEN ci.completed_in_house_by IS NOT NULL THEN (ci.completed_at AT TIME ZONE 'UTC')::date END AS in_house_day,
        k.id AS contractor_id, k.name AS contractor_name, k.company AS contractor_company, k.email AS contractor_email
      FROM compliance_items ci
      JOIN contractors k ON k.id = ci.contractor_id AND k.client_id = ci.client_id
      LEFT JOIN sites s ON s.id = ci.site_id AND s.client_id = ci.client_id
      WHERE ${clientId == null ? sql`TRUE` : sql`ci.client_id = ${clientId}`}
        AND (ci.completed_at IS NOT NULL OR ci.visit_scheduled_at IS NOT NULL)
    ) v
    WHERE v.visit_day IS NOT NULL
      -- Done in house by a competent person (lib/certificateOutcomes.ts).
      AND v.visit_day IS DISTINCT FROM v.in_house_day
      AND v.visit_day <= ${today}::date - ${afterDays}::int
      ${lookBackDays == null ? sql`` : sql`AND v.visit_day > ${today}::date - ${lookBackDays}::int`}
      AND NOT EXISTS (
        SELECT 1 FROM certificates c
        WHERE c.item_id = v.item_id
          AND ((c.created_at AT TIME ZONE 'UTC')::date >= v.visit_day
            OR (c.issue_date AT TIME ZONE 'UTC')::date >= v.visit_day)
      )
    ORDER BY v.client_id, v.visit_day, v.item_id
  `);
  return rowsOf<Record<string, unknown>>(result).map((row) => ({
    itemId: Number(row.item_id),
    clientId: Number(row.client_id),
    title: String(row.title),
    siteId: row.site_id == null ? null : Number(row.site_id),
    siteName: (row.site_name as string | null) ?? null,
    siteDepartmentId: row.site_department_id == null ? null : Number(row.site_department_id),
    departmentId: row.department_id == null ? null : Number(row.department_id),
    visitDay: day(row.visit_day)!,
    contractorId: Number(row.contractor_id),
    contractorName: String(row.contractor_name),
    contractorCompany: (row.contractor_company as string | null) ?? null,
    contractorEmail: (row.contractor_email as string | null)?.trim() || null,
    assigneeUserId: row.assignee_user_id == null ? null : Number(row.assignee_user_id),
  }));
}

function contractorFollowUpEmail(
  visit: VisitAwaitingCertificate, companyName: string, sendTo: string | null, certificateAddress: string | null,
) {
  const when = longDate(visit.visitDay);
  const where = visit.siteName ? ` at ${visit.siteName}` : "";
  // The upload link and (when the business has one) its certificate address;
  // otherwise the person responsible, as before.
  const request = certificateUploadBlock({ uploadUrl: certificateUploadUrl(), address: certificateAddress, heading: "Send us the certificate" });
  const sendToLine = certificateAddress
    ? "You can also reply to this email with it attached."
    : sendTo
    ? `Or email it to <a href="mailto:${escapeHtml(sendTo)}">${escapeHtml(sendTo)}</a>.`
    : "Or reply with it attached.";
  const sendToText = certificateAddress
    ? "You can also reply to this email with it attached."
    : sendTo ? `Or email it to ${sendTo}.` : "Or reply with it attached.";
  const html = `
    <h2 style="color:#1e293b;margin:0 0 16px;">Certificate needed</h2>
    <p>Dear ${escapeHtml(visit.contractorName)},</p>
    <p>Thank you for your visit${escapeHtml(where)} on <strong>${escapeHtml(when)}</strong> for:</p>
    <div style="background:#f1f5f9;border-left:4px solid #3b82f6;padding:16px;margin:16px 0;">
      <strong style="color:#1e293b;">${escapeHtml(visit.title)}</strong>
    </div>
    <p>We haven't received the certificate or report for this visit yet.</p>
    ${request.html}
    <p>${sendToLine}</p>
    <p>If it is waiting for your invoice to be paid, please let us know so we can sort that out.</p>
    <p>If the visit didn't go ahead, please let us know so we can rearrange it.</p>
    <p>Best regards,<br><strong>${escapeHtml(companyName)}</strong></p>
  `;
  const text = [
    "Certificate needed", "",
    `Dear ${visit.contractorName},`, "",
    `Thank you for your visit${where} on ${when} for: ${visit.title}`, "",
    "We haven't received the certificate or report for this visit yet.", "",
    request.text, sendToText, "",
    "If it is waiting for your invoice to be paid, please let us know so we can sort that out.", "",
    "If the visit didn't go ahead, please let us know so we can rearrange it.", "",
    "Best regards,", companyName,
  ].join("\n");
  return { subject: `Certificate needed: ${visit.title}`, html, text };
}

async function clientSettings(clientId: number): Promise<Record<string, string>> {
  const result = await db.execute(sql`SELECT key, value FROM app_settings WHERE client_id = ${clientId}`);
  return Object.fromEntries(rowsOf<{ key: string; value: string | null }>(result)
    .filter((row) => row.value != null).map((row) => [row.key, row.value!]));
}

/**
 * Withdraw follow-ups still waiting for a manager (a send that failed, or a
 * draft from before chases went automatically) once the certificate is in
 * (the visit day is the end of the draft's idempotency key).
 */
async function withdrawAnsweredDrafts(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE contractor_email_queue q
    SET status = 'cancelled', last_error = 'Certificate received', updated_at = now()
    WHERE q.status = 'pending' AND q.entity_type = 'compliance'
      AND q.email_type = ${CERTIFICATE_FOLLOW_UP_EMAIL_TYPE}
      AND EXISTS (
        SELECT 1 FROM certificates c
        WHERE c.item_id = q.entity_id
          AND GREATEST((c.created_at AT TIME ZONE 'UTC')::date, (c.issue_date AT TIME ZONE 'UTC')::date)
            >= substring(q.idempotency_key from '([0-9]{4}-[0-9]{2}-[0-9]{2})(-[0-9]+)?$')::date
      )
    RETURNING q.id
  `);
  return rowsOf(result).length;
}

export interface CertificateFollowUpResult { visits: number; sent: number; failed: number; withdrawn: number; errors: number }

type SendContractorEmail = typeof dispatchStoredContractorEmail;

/** The addresses a business's follow-up names: who the contractor sends the certificate to, then the rest copied in. */
function certificateAddresses(ctx: ResponsibilityContext, visit: VisitAwaitingCertificate, maintenanceEmail: string | undefined): string[] {
  const people = responsibleForCertificate(ctx, visit).map((id) => ctx.eligible.get(id)?.email ?? "");
  // A check given to someone goes to them; otherwise the business's maintenance inbox comes first.
  const shared = visit.assigneeUserId == null ? parseEmailList(maintenanceEmail) : [];
  return [...new Set([...shared, ...people].map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

async function followUpBusiness(
  clientId: number, visits: VisitAwaitingCertificate[], today: string, result: CertificateFollowUpResult, send: SendContractorEmail,
): Promise<void> {
  const [settings, ctx] = await Promise.all([clientSettings(clientId), loadResponsibilityContext(clientId)]);
  const companyName = settings["companyName"] ?? "ComplyTrack";
  // Replies to a chase go to the business's certificate address, when it has one.
  const certificateAddress = await certificateReplyToFor(clientId);
  // One follow-up per chase (the idempotency key ends in the visit day and
  // chase number), recorded as it is sent. A check holds one active queue
  // row at a time, so while a reminder for the same check is waiting for
  // approval the chase goes on a later run.
  for (const visit of visits) {
    if (!visit.contractorEmail) continue;
    const chase = chasesOwed(visit.visitDay, today);
    const key = `certificate-followup-${clientId}-${visit.itemId}-${visit.visitDay}-${chase}`;
    const addresses = certificateAddresses(ctx, visit, settings["maintenanceEmail"]);
    const email = contractorFollowUpEmail(visit, companyName, addresses[0] ?? null, certificateAddress);
    const uploadToken = newBearerToken();
    const sendable = {
      subject: email.subject,
      html: email.html.split(CERTIFICATE_UPLOAD_PLACEHOLDER).join(uploadToken),
      text: email.text.split(CERTIFICATE_UPLOAD_PLACEHOLDER).join(uploadToken),
    };
    const cc = addresses.filter((address) => address !== visit.contractorEmail!.toLowerCase());
    const claimed = await db.transaction(async (tx) => {
      // An earlier follow-up still waiting for approval is replaced by this one.
      await tx.execute(sql`
        UPDATE contractor_email_queue SET status = 'cancelled', last_error = 'Replaced by a later follow-up', updated_at = now()
        WHERE client_id = ${clientId} AND entity_type = 'compliance' AND entity_id = ${visit.itemId}
          AND email_type = ${CERTIFICATE_FOLLOW_UP_EMAIL_TYPE} AND status = 'pending' AND idempotency_key <> ${key}
      `);
      const queued = rowsOf<{ id: number }>(await tx.execute(sql`
        INSERT INTO contractor_email_queue
          (client_id, entity_type, entity_id, department_id, contractor_id, email_type, mode, status, approved_at,
           to_email, subject, body_html, body_text, cc_json, email_preview_json, encrypted_token_payload, idempotency_key)
        VALUES (${clientId}, 'compliance', ${visit.itemId}, ${visit.siteDepartmentId ?? visit.departmentId},
          ${visit.contractorId}, ${CERTIFICATE_FOLLOW_UP_EMAIL_TYPE}, 'assign', 'sending', now(), ${visit.contractorEmail},
          ${email.subject}, ${email.html}, ${email.text}, ${JSON.stringify(cc)}::jsonb,
          ${JSON.stringify({ subject: email.subject, html: email.html, text: email.text })}::jsonb,
          ${encryptTokenPayload({ certUpload: uploadToken })}, ${key})
        ON CONFLICT DO NOTHING
        RETURNING id
      `))[0];
      if (queued) {
        await issueCertificateUploadLink(tx, { clientId, itemId: visit.itemId, contractorId: visit.contractorId }, uploadToken);
      }
      return queued;
    });
    if (!claimed) continue;
    try {
      await send({
        to: visit.contractorEmail, subject: sendable.subject, html: sendable.html, text: sendable.text,
        cc: cc.length ? cc : undefined, clientId, idempotencyKey: key, replyTo: certificateAddress ?? undefined,
      });
      await db.execute(sql`UPDATE contractor_email_queue SET status = 'sent', sent_at = now(), updated_at = now()
        WHERE id = ${claimed.id} AND status = 'sending'`);
      result.sent++;
    } catch (err) {
      // Left for a manager to send from Contractor Approvals; the key is
      // unchanged, so a retry cannot deliver twice.
      await db.execute(sql`UPDATE contractor_email_queue SET status = 'pending', approved_at = NULL,
        last_error = ${err instanceof Error ? err.message.slice(0, 500) : "Send failed"}, updated_at = now()
        WHERE id = ${claimed.id} AND status = 'sending'`);
      result.failed++;
      logger.warn({ err, clientId, itemId: visit.itemId }, "Certificate follow-up could not be sent; left in Contractor Approvals");
    }
  }
}

/**
 * Send the contractor follow-ups due today and withdraw any waiting ones that
 * have been answered. The person responsible hears in their 08:00 personal
 * reminder (lib/personalReminders.ts), not from this job.
 */
export async function runCertificateFollowUpJob(
  { now = new Date(), send = dispatchStoredContractorEmail }: { now?: Date; send?: SendContractorEmail } = {},
): Promise<CertificateFollowUpResult> {
  const result: CertificateFollowUpResult = { visits: 0, sent: 0, failed: 0, withdrawn: 0, errors: 0 };
  result.withdrawn = await withdrawAnsweredDrafts();
  const today = now.toISOString().slice(0, 10);
  const visits = await getVisitsAwaitingCertificate(null, { today });
  result.visits = visits.length;
  const byClient = new Map<number, VisitAwaitingCertificate[]>();
  for (const visit of visits) byClient.set(visit.clientId, [...(byClient.get(visit.clientId) ?? []), visit]);

  for (const [clientId, clientVisits] of byClient) {
    try {
      await followUpBusiness(clientId, clientVisits, today, result, send);
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Certificate follow-up failed for a business");
    }
  }
  return result;
}
