/**
 * Weekly SafeTrack acknowledgement reminder job.
 *
 * One tenant-scoped digest is claimed per day before delivery, which prevents
 * concurrent schedulers from sending duplicate notifications.
 */
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendSystemEmail, getPublicAppUrl } from "./email";
import { getEntitledServices, isEntitled } from "./services";
import { getNotificationEmails } from "./getNotificationEmails";

export interface OutstandingDocSummary {
  title: string;
  docType: "Risk Assessment" | "SOP" | "Handbook";
  siteName: string | null;
  outstanding: string[];
  outstandingCount: number;
  acknowledgedCount: number;
  staffTotal: number;
}

export interface OutstandingStaffReminder {
  staffRosterId: number;
  staffName: string;
  email: string;
  documents: Array<{
    title: string;
    docType: OutstandingDocSummary["docType"];
    siteName: string | null;
  }>;
}

interface RequiredDocument {
  id: number;
  title: string;
  site_id: number | null;
  site_name: string | null;
  department_id: number | null;
  document_type: "ra" | "sop" | "handbook";
  doc_type: OutstandingDocSummary["docType"];
}

interface RosterStaff {
  id: number;
  name: string;
  site_id: number | null;
  site_department_id: number | null;
}

function esc(value: string | null | undefined): string {
  return (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Fetch the tenant's due acknowledgement gaps.  Both every document query and
 * every acknowledgement query are constrained by client_id.  A site-scoped
 * document applies only to active staff assigned to that site; an unscoped
 * document applies to the whole tenant.
 */
export async function getOutstandingSafeTrackAcknowledgements(
  clientId: number,
): Promise<OutstandingDocSummary[]> {
  const docsResult = await db.execute(sql`
    SELECT d.id, d.title, d.site_id, s.name AS site_name, d.department_id,
           d.document_type, d.doc_type
    FROM (
      SELECT id, title, site_id, department_id, 'ra'::text AS document_type,
             'Risk Assessment'::text AS doc_type
      FROM safe_risk_assessments
      WHERE client_id = ${clientId} AND requires_acknowledgement = true
      UNION ALL
      SELECT id, title, site_id, department_id, 'sop'::text, 'SOP'::text
      FROM safe_sops
      WHERE client_id = ${clientId} AND requires_acknowledgement = true
      UNION ALL
      SELECT id, title, site_id, department_id, 'handbook'::text,
             'Handbook'::text
      FROM safe_handbook
      WHERE client_id = ${clientId} AND requires_acknowledgement = true
    ) d
    LEFT JOIN sites s ON s.id = d.site_id AND s.client_id = ${clientId}
    ORDER BY d.title ASC
  `);
  const docs = (docsResult.rows ?? []) as unknown as RequiredDocument[];
  if (!docs.length) return [];

  const staffResult = await db.execute(sql`
    SELECT staff.id,
      COALESCE(
        NULLIF(trim(staff.name), ''),
        NULLIF(trim(concat_ws(' ', staff.first_name, staff.last_name)), ''),
        'Unnamed staff member'
      ) AS name,
      staff.site_id, site.department_id AS site_department_id
    FROM staff_roster staff
    LEFT JOIN sites site ON site.id = staff.site_id AND site.client_id = ${clientId}
    WHERE staff.client_id = ${clientId} AND staff.active = true
  `);
  const staff = (staffResult.rows ?? []) as unknown as RosterStaff[];
  if (!staff.length) return [];

  const acksResult = await db.execute(sql`
    SELECT document_type, document_id, staff_roster_id
    FROM safe_track_acknowledgements
    WHERE client_id = ${clientId} AND staff_roster_id IS NOT NULL
  `);
  const acknowledged = new Set(
    (acksResult.rows ?? []).map((row: any) => `${row.document_type}:${row.document_id}:${row.staff_roster_id}`),
  );

  return docs.flatMap((doc) => {
    const siteStaff = doc.site_id === null
      ? staff
      : staff.filter((member) => member.site_id === doc.site_id);
    // Department applicability is based on a staff member's assigned site's
    // authoritative department relationship, never their free-text roster
    // department value (which is descriptive and often inconsistent).
    const relevantStaff = doc.department_id === null
      ? siteStaff
      : siteStaff.filter((member) => member.site_department_id === doc.department_id);
    if (!relevantStaff.length) return [];
    const outstanding = relevantStaff.filter(
      (member) => !acknowledged.has(`${doc.document_type}:${doc.id}:${member.id}`),
    );
    if (!outstanding.length) return [];
    return [{
      title: doc.title,
      docType: doc.doc_type,
      siteName: doc.site_name,
      outstanding: outstanding.map((member) => member.name),
      outstandingCount: outstanding.length,
      acknowledgedCount: relevantStaff.length - outstanding.length,
      staffTotal: relevantStaff.length,
    }];
  });
}

/**
 * Return outstanding required documents grouped by roster member. This is
 * separate from the manager digest so an individual reminder never discloses
 * another staff member's sign-off status.
 */
export async function getOutstandingSafeTrackStaffReminders(
  clientId: number,
): Promise<OutstandingStaffReminder[]> {
  const result = await db.execute(sql`
    SELECT staff.id AS staff_roster_id,
           COALESCE(
             NULLIF(trim(staff.name), ''),
             NULLIF(trim(concat_ws(' ', staff.first_name, staff.last_name)), ''),
             'staff member'
           ) AS staff_name,
           trim(staff.email) AS email,
           d.title,
           d.doc_type,
           doc_site.name AS site_name
    FROM (
      SELECT id, title, site_id, department_id, 'ra'::text AS document_type,
             'Risk Assessment'::text AS doc_type
      FROM safe_risk_assessments
      WHERE client_id = ${clientId} AND requires_acknowledgement = true
      UNION ALL
      SELECT id, title, site_id, department_id, 'sop'::text,
             'SOP'::text
      FROM safe_sops
      WHERE client_id = ${clientId} AND requires_acknowledgement = true
      UNION ALL
      SELECT id, title, site_id, department_id, 'handbook'::text,
             'Handbook'::text
      FROM safe_handbook
      WHERE client_id = ${clientId} AND requires_acknowledgement = true
    ) d
    JOIN staff_roster staff
      ON staff.client_id = ${clientId}
     AND staff.active = true
     AND (d.site_id IS NULL OR staff.site_id = d.site_id)
    LEFT JOIN sites staff_site
      ON staff_site.id = staff.site_id
     AND staff_site.client_id = ${clientId}
    LEFT JOIN sites doc_site
      ON doc_site.id = d.site_id
     AND doc_site.client_id = ${clientId}
    WHERE NULLIF(trim(staff.email), '') IS NOT NULL
      AND (
        d.department_id IS NULL
        OR staff_site.department_id = d.department_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM safe_track_acknowledgements ack
        WHERE ack.client_id = ${clientId}
          AND ack.document_type = d.document_type
          AND ack.document_id = d.id
          AND ack.staff_roster_id = staff.id
      )
    ORDER BY staff.id, d.title
  `);

  const grouped = new Map<number, OutstandingStaffReminder>();
  for (const row of (result.rows ?? []) as any[]) {
    const staffRosterId = Number(row.staff_roster_id);
    const email = String(row.email ?? "").trim().toLowerCase();
    if (!Number.isSafeInteger(staffRosterId) || !email || !/.+@.+\..+/.test(email)) continue;

    let reminder = grouped.get(staffRosterId);
    if (!reminder) {
      reminder = {
        staffRosterId,
        staffName: String(row.staff_name ?? "staff member"),
        email,
        documents: [],
      };
      grouped.set(staffRosterId, reminder);
    }
    reminder.documents.push({
      title: String(row.title),
      docType: row.doc_type as OutstandingDocSummary["docType"],
      siteName: row.site_name ? String(row.site_name) : null,
    });
  }
  return [...grouped.values()];
}

function buildEmailHtml(docs: OutstandingDocSummary[], appUrl: string): string {
  const rows = docs.map((doc) => `
    <tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
      <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(doc.title)}</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px;">
        ${esc(doc.docType)}${doc.siteName ? ` · ${esc(doc.siteName)}` : ""} ·
        ${doc.acknowledgedCount}/${doc.staffTotal} acknowledged
      </div>
      <div style="font-size:12px;color:#b45309;margin-top:4px;">
        Waiting on: ${doc.outstanding.map(esc).join(", ")}
      </div>
    </td></tr>`).join("");
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;">
    <h2 style="color:#0f172a;">SafeTrack acknowledgements outstanding</h2>
    <p>Required SafeTrack documents still need staff acknowledgement. Open the secure register to review and follow up.</p>
    <table style="width:100%;border-collapse:collapse;"><tbody>${rows}</tbody></table>
    <p style="margin-top:24px;"><a href="${appUrl}/safe-track" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">Open SafeTrack</a></p>
    <p style="font-size:12px;color:#64748b;">Sign in to review acknowledgement details and follow up.</p>
  </body></html>`;
}

function buildStaffEmailHtml(
  staffName: string,
  docs: OutstandingStaffReminder["documents"],
  appUrl: string,
): string {
  const rows = docs.map((doc) => `
    <tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">
      <div style="font-weight:600;font-size:14px;color:#0f172a;">${esc(doc.title)}</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px;">
        ${esc(doc.docType)}${doc.siteName ? ` · ${esc(doc.siteName)}` : ""}
      </div>
    </td></tr>`).join("");
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;">
    <h2 style="color:#0f172a;">Your SafeTrack sign-offs are outstanding</h2>
    <p>Hello ${esc(staffName)}, the following required records still need your acknowledgement.</p>
    <table style="width:100%;border-collapse:collapse;"><tbody>${rows}</tbody></table>
    <p style="margin-top:24px;"><a href="${appUrl}/safe-track" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">Open SafeTrack</a></p>
    <p style="font-size:12px;color:#64748b;">Please sign in and complete the outstanding sign-offs.</p>
  </body></html>`;
}

export interface SafeTrackAckReminderJobResult {
  clientsChecked: number;
  clientsAlerted: number;
  emailsSent: number;
  remindersClaimed: number;
  errors: number;
}

export interface SafeTrackAckReminderDependencies {
  now?: () => Date;
  appUrl?: () => string;
  listClients?: () => Promise<{ id: number; name: string }[]>;
  isSafeTrackEntitled?: (clientId: number) => Promise<boolean>;
  getOutstanding?: (clientId: number) => Promise<OutstandingDocSummary[]>;
  getStaffOutstanding?: (clientId: number) => Promise<OutstandingStaffReminder[]>;
  getRecipients?: (clientId: number) => Promise<{ emails: string[] }>;
  claim?: (clientId: number) => Promise<number | null>;
  release?: (claimId: number) => Promise<void>;
  send?: typeof sendSystemEmail;
}

async function claimReminder(clientId: number): Promise<number | null> {
  // The transaction-scoped advisory lock serialises claims for this tenant.
  // The lock is released at commit, after the recent-row check and insert are
  // visible together; concurrent scheduler processes therefore cannot both
  // decide that a weekly reminder is due.
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${clientId}) AS locked`);
    if (!((locked.rows ?? [])[0] as any)?.locked) return null;
    const recent = await tx.execute(sql`
      SELECT 1 FROM safe_track_ack_reminder_log
       WHERE client_id = ${clientId} AND sent_at > now() - interval '7 days'
      LIMIT 1
    `);
    if ((recent.rows ?? []).length) return null;
    const claim = await tx.execute(sql`
      INSERT INTO safe_track_ack_reminder_log (client_id, sent_at)
      VALUES (${clientId}, now())
      RETURNING id
    `);
    return ((claim.rows ?? [])[0] as any)?.id ?? null;
  });
}

async function defaultEntitlement(clientId: number): Promise<boolean> {
  return isEntitled(await getEntitledServices(clientId), "safetrack");
}

/** The dependencies make scheduling and delivery behavior unit-testable. */
export async function runSafeTrackAckReminderJob(
  dependencies: SafeTrackAckReminderDependencies = {},
): Promise<SafeTrackAckReminderJobResult> {
  const result: SafeTrackAckReminderJobResult = {
    clientsChecked: 0, clientsAlerted: 0, emailsSent: 0, remindersClaimed: 0, errors: 0,
  };
  const listClients = dependencies.listClients ?? (() => db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(eq(clientsTable.active, true)));
  const isSafeTrackEntitled = dependencies.isSafeTrackEntitled ?? defaultEntitlement;
  const getOutstanding = dependencies.getOutstanding ?? getOutstandingSafeTrackAcknowledgements;
  const getStaffOutstanding = dependencies.getStaffOutstanding ?? getOutstandingSafeTrackStaffReminders;
  const getRecipients = dependencies.getRecipients ?? getNotificationEmails;
  const claim = dependencies.claim ?? claimReminder;
  const release = dependencies.release ?? (async (claimId: number) => { await db.execute(sql`DELETE FROM safe_track_ack_reminder_log WHERE id = ${claimId}`); });
  const send = dependencies.send ?? sendSystemEmail;
  const appUrl = dependencies.appUrl?.() ?? getPublicAppUrl();

  for (const client of await listClients()) {
    result.clientsChecked++;
    let claimId: number | null = null;
    try {
      if (!await isSafeTrackEntitled(client.id)) continue;
      const outstanding = await getOutstanding(client.id);
      if (!outstanding.length) continue;
      const staffOutstanding = await getStaffOutstanding(client.id);
      const recipients = await getRecipients(client.id);
      const managerEmails = [...new Set(recipients.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
      const staffEmails = [...new Map(staffOutstanding.map((reminder) => [reminder.email, reminder])).values()];
      if (!managerEmails.length && !staffEmails.length) continue;
      claimId = await claim(client.id);
      if (!claimId) continue;
      result.remindersClaimed++;

      let delivered = 0;
      const managerSubject = `SafeTrack: ${outstanding.length} required document${outstanding.length === 1 ? "" : "s"} awaiting acknowledgement`;
      for (const email of managerEmails) {
        try {
          await send({
            to: email,
            subject: managerSubject,
            html: buildEmailHtml(outstanding, appUrl),
            idempotencyKey: `safe-track-manager-${client.id}-${claimId}-${email}`,
          });
          delivered++;
          result.emailsSent++;
        } catch (err) {
          result.errors++;
          logger.warn({ err, clientId: client.id, email }, "Failed to send SafeTrack acknowledgement reminder");
        }
      }
      for (const reminder of staffEmails) {
        try {
          await send({
            to: reminder.email,
            subject: "SafeTrack: your required sign-offs are outstanding",
            html: buildStaffEmailHtml(reminder.staffName, reminder.documents, appUrl),
            idempotencyKey: `safe-track-staff-${client.id}-${claimId}-${reminder.staffRosterId}`,
          });
          delivered++;
          result.emailsSent++;
        } catch (err) {
          result.errors++;
          logger.warn(
            { err, clientId: client.id, staffRosterId: reminder.staffRosterId, email: reminder.email },
            "Failed to send SafeTrack staff acknowledgement reminder",
          );
        }
      }
      if (!delivered) {
        await release(claimId);
        claimId = null;
        continue;
      }
      result.clientsAlerted++;
      logger.info({
        clientId: client.id,
        docs: outstanding.length,
        managerEmails: managerEmails.length,
        staffEmails: staffEmails.length,
      }, "SafeTrack acknowledgement reminders sent");
    } catch (err) {
      if (claimId) {
        try { await release(claimId); } catch (releaseErr) { logger.error({ err: releaseErr, clientId: client.id }, "Failed to release SafeTrack acknowledgement claim"); }
      }
      result.errors++;
      logger.error({ err, clientId: client.id }, "SafeTrack acknowledgement reminder job failed");
    }
  }
  return result;
}