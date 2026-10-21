/**
 * Certificate follow-up: a contractor visit that has happened but has no
 * certificate on its compliance check a few days later.
 *
 * A visit has happened when its check (one with a contractor) was completed,
 * or when the date the contractor booked through the reminder link has
 * passed. A certificate counts when it was added to the check on or after the
 * visit day, or is dated (issue date) on or after it.
 *
 * Once per visit, FOLLOW_UP_AFTER_DAYS after it:
 *   - the contractor gets a follow-up asking for the certificate, drafted into
 *     Contractor Approvals like the visit reminder (a manager sends it); a
 *     draft still waiting when the certificate arrives is withdrawn;
 *   - the site's Maintenance person is emailed directly (else its Managers,
 *     else the Owner of a business with neither), one email per person per
 *     day listing every visit waiting.
 * Only visits from the last LOOK_BACK_DAYS are followed up, so older history
 * never produces a burst of emails.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { escapeHtml, emailButton, getPublicAppUrl, parseEmailList, sendEmail } from "./email";
import { logger } from "./logger";
import { claimEmailDelivery, markEmailDeliverySent, settleEmailDelivery, type EmailDeliveryClaim } from "./emailDeliveryClaims";
import { siteVisibleSql } from "./departmentSites";

export const FOLLOW_UP_AFTER_DAYS = 3;
export const LOOK_BACK_DAYS = 30;
const JOB = "certificate-follow-up";
export const CERTIFICATE_FOLLOW_UP_EMAIL_TYPE = "certificate_followup";

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
}

/**
 * Visits that happened between LOOK_BACK_DAYS and `afterDays` days ago with
 * no certificate yet (afterDays 0 lists every waiting visit, for display).
 */
export async function getVisitsAwaitingCertificate(
  clientId: number | null,
  { afterDays = FOLLOW_UP_AFTER_DAYS, now = new Date() }: { afterDays?: number; now?: Date } = {},
): Promise<VisitAwaitingCertificate[]> {
  const today = now.toISOString().slice(0, 10);
  const result = await db.execute(sql`
    SELECT * FROM (
      SELECT ci.id AS item_id, ci.client_id, ci.title, ci.site_id, s.name AS site_name,
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
      AND v.visit_day > ${today}::date - ${LOOK_BACK_DAYS}::int
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
  }));
}

interface Person { id: number; email: string; role: string; isMaintenanceManager: boolean }

/**
 * Who hears about a visit's missing certificate: the Maintenance people who
 * cover its site (and the business's maintenance email in Settings), else
 * its Managers, else the Owner when the business
 * has neither. A person covers a site when one of their departments can see
 * it; someone with no department, or a Manager over every department, covers
 * every site.
 */
export async function certificateFollowUpRecipients(
  clientId: number,
  visit: Pick<VisitAwaitingCertificate, "siteId">,
  maintenanceEmailSetting?: string | null,
): Promise<string[]> {
  const siteClause = visit.siteId == null ? sql`TRUE` : sql`(
    (u.department_id IS NULL AND NOT EXISTS (SELECT 1 FROM user_departments ud0 WHERE ud0.user_id = u.id))
    OR (u.role = 'client_manager' AND u.all_departments)
    OR EXISTS (
      SELECT 1 FROM sites s
      JOIN (
        SELECT u.department_id AS department_id
        UNION SELECT ud.department_id FROM user_departments ud WHERE ud.user_id = u.id AND u.role = 'client_manager'
      ) d ON d.department_id IS NOT NULL
      WHERE s.id = ${visit.siteId} AND ${siteVisibleSql(sql`s.id`, sql`s.department_id`, sql`d.department_id`)}
    )
  )`;
  const people = rowsOf<{ id: number; email: string; role: string; is_maintenance_manager: boolean }>(
    await db.execute(sql`
      SELECT u.id, u.email, u.role, u.is_maintenance_manager
      FROM users u
      WHERE u.client_id = ${clientId} AND u.active = true
        AND u.role IN ('client_admin', 'client_manager', 'client_staff')
        AND ${siteClause}
      ORDER BY u.id
    `),
  ).map((row): Person => ({
    id: Number(row.id), email: row.email, role: row.role,
    isMaintenanceManager: row.is_maintenance_manager === true,
  }));
  const emails = (list: string[]) => [...new Set(list.map((email) => email.trim().toLowerCase()).filter(Boolean))];

  const maintenance = emails([
    ...parseEmailList(maintenanceEmailSetting),
    ...people.filter((p) => p.isMaintenanceManager).map((p) => p.email),
  ]);
  if (maintenance.length) return maintenance;
  const managers = emails(people.filter((p) => p.role === "client_manager").map((p) => p.email));
  if (managers.length) return managers;
  // A business with neither: its Owner is the one who deals with contractors.
  return emails(people.filter((p) => p.role === "client_admin").map((p) => p.email));
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
    <p>If the visit didn't go ahead, please let us know so we can rearrange it.</p>
    <p>Best regards,<br><strong>${escapeHtml(companyName)}</strong></p>
  `;
  const text = [
    "Certificate needed", "",
    `Dear ${visit.contractorName},`, "",
    `Thank you for your visit${where} on ${when} for: ${visit.title}`, "",
    `We haven't received the certificate or report for this visit yet. ${replyTo ? `Please email it to ${replyTo}.` : "Please reply with it attached."}`, "",
    "If the visit didn't go ahead, please let us know so we can rearrange it.", "",
    "Best regards,", companyName,
  ].join("\n");
  return { subject: `Certificate needed: ${visit.title}`, html, text };
}

function staffFollowUpEmail(visits: VisitAwaitingCertificate[]) {
  const appUrl = getPublicAppUrl();
  const rows = visits.map((visit) => {
    const where = visit.siteName ? `${visit.siteName} · ` : "";
    const who = [visit.contractorName, visit.contractorCompany].filter(Boolean).join(", ");
    return `<li style="margin:0 0 10px;"><a href="${escapeHtml(`${appUrl}/items/${visit.itemId}`)}" style="color:#2563eb;font-weight:600;">${escapeHtml(visit.title)}</a><br/>
      <span style="color:#64748b;font-size:13px;">${escapeHtml(where)}visited ${escapeHtml(longDate(visit.visitDay))} by ${escapeHtml(who)}</span></li>`;
  }).join("");
  const count = visits.length === 1 ? "A contractor visit has" : `${visits.length} contractor visits have`;
  const html = `
    <h2 style="color:#1e293b;margin:0 0 16px;">Certificates still to come</h2>
    <p>${count} no certificate uploaded ${FOLLOW_UP_AFTER_DAYS} days on:</p>
    <ul style="padding-left:20px;margin:16px 0;">${rows}</ul>
    <p>The contractor has a follow-up waiting in Contractor Approvals. When the certificate arrives, upload it on the check.</p>
    <p style="text-align:center;margin:24px 0;">${emailButton(escapeHtml(`${appUrl}/contractor-approvals`), "Open Contractor Approvals")}</p>
  `;
  const text = [
    "Certificates still to come", "",
    `${count} no certificate uploaded ${FOLLOW_UP_AFTER_DAYS} days on:`, "",
    ...visits.map((visit) => `- ${visit.title}${visit.siteName ? ` (${visit.siteName})` : ""}, visited ${longDate(visit.visitDay)}: ${appUrl}/items/${visit.itemId}`),
    "", "The contractor has a follow-up waiting in Contractor Approvals. When the certificate arrives, upload it on the check.",
  ].join("\n");
  const subject = visits.length === 1 ? `Certificate still to come: ${visits[0].title}` : `${visits.length} certificates still to come`;
  return { subject, html, text };
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
            >= substring(q.idempotency_key from '([0-9]{4}-[0-9]{2}-[0-9]{2})$')::date
      )
    RETURNING q.id
  `);
  return rowsOf(result).length;
}

export interface CertificateFollowUpResult { visits: number; drafted: number; staffEmails: number; withdrawn: number; errors: number }

type Claimed = { visit: VisitAwaitingCertificate; claim: EmailDeliveryClaim; recipients: string[] };

async function followUpBusiness(
  clientId: number, visits: VisitAwaitingCertificate[], claimed: Claimed[],
  send: typeof sendEmail, result: CertificateFollowUpResult,
): Promise<void> {
  const settings = await clientSettings(clientId);
  const companyName = settings["companyName"] ?? "ComplyTrack";
  // Each visit is followed up once: its claim is the permanent marker.
  for (const visit of visits) {
    const claim = await claimEmailDelivery(JOB, `${visit.itemId}:${visit.visitDay}`);
    if (!claim) continue;
    claimed.push({ visit, claim, recipients: await certificateFollowUpRecipients(clientId, visit, settings["maintenanceEmail"]) });
  }

  // Contractor follow-ups wait in Contractor Approvals. A check holds one
  // waiting draft at a time, so a follow-up is not added while a reminder
  // for the same check is still waiting.
  for (const { visit, recipients } of claimed) {
    if (!visit.contractorEmail) continue;
    const email = contractorFollowUpEmail(visit, companyName, recipients[0] ?? null);
    const cc = recipients.filter((address) => address !== visit.contractorEmail!.toLowerCase());
    const queued = await db.execute(sql`
      INSERT INTO contractor_email_queue
        (client_id, entity_type, entity_id, department_id, contractor_id, email_type, mode,
         to_email, subject, body_html, body_text, cc_json, email_preview_json, idempotency_key)
      VALUES (${clientId}, 'compliance', ${visit.itemId}, ${visit.siteDepartmentId ?? visit.departmentId},
        ${visit.contractorId}, ${CERTIFICATE_FOLLOW_UP_EMAIL_TYPE}, 'assign', ${visit.contractorEmail},
        ${email.subject}, ${email.html}, ${email.text}, ${JSON.stringify(cc)}::jsonb,
        ${JSON.stringify({ subject: email.subject, html: email.html, text: email.text })}::jsonb,
        ${`certificate-followup-${clientId}-${visit.itemId}-${visit.visitDay}`})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    if (rowsOf(queued).length) result.drafted++;
  }

  // Staff: one email per person listing every visit waiting.
  const byRecipient = new Map<string, VisitAwaitingCertificate[]>();
  for (const { visit, recipients } of claimed) {
    for (const address of recipients) byRecipient.set(address, [...(byRecipient.get(address) ?? []), visit]);
  }
  const failed = new Set<number>();
  for (const [address, list] of byRecipient) {
    const email = staffFollowUpEmail(list);
    try {
      await send({
        to: address, subject: email.subject, html: email.html, text: email.text, clientId,
        idempotencyKey: `${JOB}:${clientId}:${address}:${list.map((visit) => `${visit.itemId}@${visit.visitDay}`).join(",")}`,
      });
      result.staffEmails++;
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Certificate follow-up email failed");
      for (const visit of list) failed.add(visit.itemId);
    }
  }
  // A visit whose staff email failed is tried again tomorrow; its contractor
  // draft is not duplicated (same idempotency key).
  for (const { visit, claim } of claimed) {
    if (failed.has(visit.itemId)) await settleEmailDelivery(claim);
    else await markEmailDeliverySent(claim);
  }
}

export async function runCertificateFollowUpJob(
  { now = new Date(), send = sendEmail }: { now?: Date; send?: typeof sendEmail } = {},
): Promise<CertificateFollowUpResult> {
  const result: CertificateFollowUpResult = { visits: 0, drafted: 0, staffEmails: 0, withdrawn: 0, errors: 0 };
  result.withdrawn = await withdrawAnsweredDrafts();
  const visits = await getVisitsAwaitingCertificate(null, { now });
  result.visits = visits.length;
  const byClient = new Map<number, VisitAwaitingCertificate[]>();
  for (const visit of visits) byClient.set(visit.clientId, [...(byClient.get(visit.clientId) ?? []), visit]);

  for (const [clientId, clientVisits] of byClient) {
    const claimed: Claimed[] = [];
    try {
      await followUpBusiness(clientId, clientVisits, claimed, send, result);
    } catch (err) {
      result.errors++;
      logger.error({ err, clientId }, "Certificate follow-up failed for a business");
      // Nothing is marked done, so tomorrow's run tries these visits again.
      for (const { claim } of claimed) await settleEmailDelivery(claim).catch(() => {});
    }
  }
  return result;
}
