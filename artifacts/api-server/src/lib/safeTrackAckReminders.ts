/**
 * Daily SafeTrack acknowledgement reminder job.
 *
 * One tenant-scoped digest is claimed per day before delivery, which prevents
 * concurrent schedulers from sending duplicate manager notifications.
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
       WHERE client_id = ${clientId} AND sent_at > now() - interval '1 day'
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
      const recipients = await getRecipients(client.id);
      const emails = [...new Set(recipients.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
      if (!emails.length) continue;
      claimId = await claim(client.id);
      if (!claimId) continue;
      result.remindersClaimed++;

      const subject = `SafeTrack: ${outstanding.length} required document${outstanding.length === 1 ? "" : "s"} awaiting acknowledgement`;
      const html = buildEmailHtml(outstanding, appUrl);
      let delivered = 0;
      for (const email of emails) {
        try {
          await send({ to: email, subject, html });
          delivered++;
          result.emailsSent++;
        } catch (err) {
          result.errors++;
          logger.warn({ err, clientId: client.id, email }, "Failed to send SafeTrack acknowledgement reminder");
        }
      }
      if (!delivered) {
        await release(claimId);
        claimId = null;
        continue;
      }
      result.clientsAlerted++;
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