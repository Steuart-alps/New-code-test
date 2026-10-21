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
 *   - the contractor gets a follow-up asking for the certificate, drafted
 *     into Contractor Approvals like the visit reminder (a manager sends it)
 *     with the people responsible copied in; a draft still waiting when the
 *     certificate arrives is withdrawn, and a new one is not added while the
 *     last is still waiting;
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
        k.id AS contractor_id, k.name AS contractor_name, k.company AS contractor_company, k.email AS contractor_email
      FROM compliance_items ci
      JOIN contractors k ON k.id = ci.contractor_id AND k.client_id = ci.client_id
      LEFT JOIN sites s ON s.id = ci.site_id AND s.client_id = ci.client_id
      WHERE ${clientId == null ? sql`TRUE` : sql`ci.client_id = ${clientId}`}
        AND (ci.completed_at IS NOT NULL OR ci.visit_scheduled_at IS NOT NULL)
    ) v
    WHERE v.visit_day IS NOT NULL
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

function contractorFollowUpEmail(visit: VisitAwaitingCertificate, companyName: string, replyTo: string | null) {
  const when = longDate(visit.visitDay);
  const where = visit.siteName ? ` at ${visit.siteName}` : "";
  const sendTo = replyTo
    ? `Please email it to <a href="mailto:${escapeHtml(replyTo)}">${escapeHtml(replyTo)}</a>.`
    : "Please reply with it attached.";
  const html = `
    <h2 style="color:#1e293b;margin:0 0 16px;">Certificate needed</h2>
    <p>Dear ${escapeHtml(visit.contractorName)},</p>
    <p>Thank you for your visit${escapeHtml(where)} on <strong>${escapeHtml(when)}</strong> for:</p>
    <div style="background:#f1f5f9;border-left:4px solid #3b82f6;padding:16px;margin:16px 0;">
      <strong style="color:#1e293b;">${escapeHtml(visit.title)}</strong>
    </div>
    <p>We haven't received the certificate or report for this visit yet. ${sendTo}</p>
    <p>If it is waiting for your invoice to be paid, please let us know so we can sort that out.</p>
    <p>If the visit didn't go ahead, please let us know so we can rearrange it.</p>
    <p>Best regards,<br><strong>${escapeHtml(companyName)}</strong></p>
  `;
  const text = [
    "Certificate needed", "",
    `Dear ${visit.contractorName},`, "",
    `Thank you for your visit${where} on ${when} for: ${visit.title}`, "",
    `We haven't received the certificate or report for this visit yet. ${replyTo ? `Please email it to ${replyTo}.` : "Please reply with it attached."}`, "",
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
 * Withdraw follow-up drafts still waiting for a manager once the certificate
 * is in (the visit day is the end of the draft's idempotency key).
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

export interface CertificateFollowUpResult { visits: number; drafted: number; withdrawn: number; errors: number }

/** The addresses a business's follow-up names: who the contractor sends the certificate to, then the rest copied in. */
function certificateAddresses(ctx: ResponsibilityContext, visit: VisitAwaitingCertificate, maintenanceEmail: string | undefined): string[] {
  const people = responsibleForCertificate(ctx, visit).map((id) => ctx.eligible.get(id)?.email ?? "");
  // A check given to someone goes to them; otherwise the business's maintenance inbox comes first.
  const shared = visit.assigneeUserId == null ? parseEmailList(maintenanceEmail) : [];
  return [...new Set([...shared, ...people].map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

async function followUpBusiness(
  clientId: number, visits: VisitAwaitingCertificate[], today: string, result: CertificateFollowUpResult,
): Promise<void> {
  const [settings, ctx] = await Promise.all([clientSettings(clientId), loadResponsibilityContext(clientId)]);
  const companyName = settings["companyName"] ?? "ComplyTrack";
  // Contractor follow-ups wait in Contractor Approvals, one per chase (the
  // idempotency key ends in the visit day and chase number). A check holds
  // one waiting draft at a time, so while the last follow-up (or a reminder)
  // for the same check is still waiting, the next is added on a later run.
  for (const visit of visits) {
    if (!visit.contractorEmail) continue;
    const chase = chasesOwed(visit.visitDay, today);
    const addresses = certificateAddresses(ctx, visit, settings["maintenanceEmail"]);
    const email = contractorFollowUpEmail(visit, companyName, addresses[0] ?? null);
    const cc = addresses.filter((address) => address !== visit.contractorEmail!.toLowerCase());
    const queued = await db.execute(sql`
      INSERT INTO contractor_email_queue
        (client_id, entity_type, entity_id, department_id, contractor_id, email_type, mode,
         to_email, subject, body_html, body_text, cc_json, email_preview_json, idempotency_key)
      VALUES (${clientId}, 'compliance', ${visit.itemId}, ${visit.siteDepartmentId ?? visit.departmentId},
        ${visit.contractorId}, ${CERTIFICATE_FOLLOW_UP_EMAIL_TYPE}, 'assign', ${visit.contractorEmail},
        ${email.subject}, ${email.html}, ${email.text}, ${JSON.stringify(cc)}::jsonb,
        ${JSON.stringify({ subject: email.subject, html: email.html, text: email.text })}::jsonb,
        ${`certificate-followup-${clientId}-${visit.itemId}-${visit.visitDay}-${chase}`})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    if (rowsOf(queued).length) result.drafted++;
  }
}

/**
 * Draft the contractor follow-ups due today and withdraw those answered. The
 * person responsible hears in their 08:00 personal reminder
 * (lib/personalReminders.ts), not from this job.
 */
export async function runCertificateFollowUpJob({ now = new Date() }: { now?: Date } = {}): Promise<CertificateFollowUpResult> {
  const result: CertificateFollowUpResult = { visits: 0, drafted: 0, withdrawn: 0, errors: 0 };
  result.withdrawn = await withdrawAnsweredDrafts();
  const today = now.toISOString().slice(0, 10);
  const visits = await getVisitsAwaitingCertificate(null, { today });
  result.visits = visits.length;
  const byClient = new Map<number, VisitAwaitingCertificate[]>();
  for (const visit of visits) byClient.set(visit.clientId, [...(byClient.get(visit.clientId) ?? []), visit]);

  for (const [clientId, clientVisits] of byClient) {
    try {
      await followUpBusiness(clientId, clientVisits, today, result);
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Certificate follow-up failed for a business");
    }
  }
  return result;
}
