import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { complianceItemsTable, contractorsTable, appSettingsTable, usersTable, sitesTable } from "@workspace/db/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { sendEmail, sendSystemEmail, parseEmailList } from "../lib/email";
import { buildReminderEmail, buildCalendarInvite, getPublicAppUrl } from "../lib/email";
import { TestEmailBody } from "@workspace/api-zod";
import { randomUUID } from "crypto";
import { requireAuth, requireClientAdmin, getClientId } from "../middleware/requireAuth";
import { digestBearerToken, encryptTokenPayload } from "../lib/bearerTokens";

/**
 * Build the full CC list for a reminder email by combining:
 *   - the comma-separated `maintenanceEmail` setting (one or many)
 *   - all active client_admin user emails when `notifyClientAdmins` is "true"
 *   - any extra `additionalReminderEmails` from settings
 *   - the optional `actorEmail` (the logged-in user who triggered a manual send)
 * Excludes the recipient's own address so they don't see themselves CC'd.
 */
async function buildReminderCcList(opts: {
  clientId: number;
  settings: Record<string, string>;
  recipient: string;
  actorEmail?: string | null;
}): Promise<string[]> {
  const { clientId, settings, recipient, actorEmail } = opts;
  const list: string[] = [
    ...parseEmailList(settings["maintenanceEmail"]),
    ...parseEmailList(settings["additionalReminderEmails"]),
  ];

  if (settings["notifyClientAdmins"] === "true") {
    const admins = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.clientId, clientId), eq(usersTable.role, "client_admin"), eq(usersTable.active, true)));
    for (const a of admins) list.push(a.email);
  }

  if (actorEmail) list.push(actorEmail);

  const recipientLc = recipient.toLowerCase();
  return Array.from(new Set(list.map((e) => e.toLowerCase()))).filter((e) => e !== recipientLc);
}

const router: IRouter = Router();

async function getClientSettings(clientId: number): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.clientId, clientId));
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (row.value != null) settings[row.key] = row.value;
  }
  return settings;
}

async function sendReminderForItem(opts: {
  item: typeof complianceItemsTable.$inferSelect;
  contractor: typeof contractorsTable.$inferSelect;
  companyName: string;
  fromEmail: string;
  ccList: string[];
  defaultLeadTimeDays: number;
  departmentId: number | null;
  now: Date;
}): Promise<boolean> {
  const { item, contractor, companyName, ccList, defaultLeadTimeDays, departmentId, now } = opts;

  const leadTimeDays = item.leadTimeDays ?? defaultLeadTimeDays;
  const dueDate = new Date(item.dueDate!);

  // Generate (or rotate) a single-use schedule token so the contractor can
  // propose a visit date directly from the email.
  const scheduleToken = randomUUID();
  const scheduleLink = `${getPublicAppUrl()}/schedule/${scheduleToken}`;

  const ccDisplay = ccList.length > 0 ? ccList.join(", ") : null;

  const { html, text } = buildReminderEmail({
    contractorName: contractor.name,
    companyName,
    itemTitle: item.title,
    dueDate,
    leadTimeDays,
    notes: item.notes,
    ccMaintenanceEmail: ccDisplay,
    scheduleLink,
  });

  // Reminders use the same approval queue as FixTrack contractor mail. The
  // unique key makes scheduler retries harmless; manager/test mail remains
  // outside this helper and is still sent directly.
  const cycleDate = dueDate.toISOString().slice(0, 10);
  // Store a placeholder in every rendered field and keep the working bearer
  // only in the authenticated queue payload. The approval route hydrates it
  // immediately before manager preview/provider dispatch.
  const safeHtml = html.split(scheduleToken).join("{{BOOKED_TOKEN}}");
  const safeText = text.split(scheduleToken).join("{{BOOKED_TOKEN}}");
  const subject = `Compliance Check Reminder: ${item.title}`;
  const preview = { subject, text: safeText, html: safeHtml };
  const encryptedTokenPayload = encryptTokenPayload({ booked: scheduleToken });

  // The idempotency claim and token issuance are one atomic operation. A retry
  // (or a concurrent runner) that loses the unique-key race leaves the first
  // cycle's token untouched; a failed item update rolls back the queue claim.
  return db.transaction(async (tx) => {
    const queued = await tx.execute(sql`
      INSERT INTO contractor_email_queue
        (client_id, entity_type, entity_id, issue_id, department_id, contractor_id, email_type, mode,
         to_email, subject, body_html, body_text, cc_json, email_preview_json, encrypted_token_payload, idempotency_key)
      VALUES (${item.clientId}, 'compliance', ${item.id}, NULL, ${departmentId}, ${contractor.id},
        'reminder', 'assign', ${contractor.email!}, ${subject}, ${safeHtml}, ${safeText},
        ${JSON.stringify(ccList)}::jsonb, ${JSON.stringify(preview)}::jsonb,
        ${encryptedTokenPayload}, ${`reminder-${item.clientId}-${item.id}-${cycleDate}`})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `);

    if (queued.rows.length === 0) return false;
    const updatedItems = await tx.update(complianceItemsTable)
      // Only the digest is stored; the raw token lives in the encrypted draft.
      .set({ scheduleToken: null, scheduleTokenHash: digestBearerToken(scheduleToken), visitScheduledAt: null })
      .where(and(
        eq(complianceItemsTable.id, item.id),
        eq(complianceItemsTable.clientId, item.clientId),
      ))
      .returning({ id: complianceItemsTable.id });
    if (updatedItems.length !== 1) {
      throw new Error("Compliance item disappeared before its reminder token could be saved");
    }
    return true;
  });
}

export async function runReminderJob(): Promise<{ queued: number; sent: number; skipped: number; errors: number }> {
  const now = new Date();

  const items = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable, siteDepartmentId: sitesTable.departmentId })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .leftJoin(sitesTable, and(
      eq(complianceItemsTable.siteId, sitesTable.id),
      eq(complianceItemsTable.clientId, sitesTable.clientId),
    ))
    .where(isNotNull(complianceItemsTable.contractorId));

  const settingsCache: Record<number, Record<string, string>> = {};

  let queued = 0;
  let skipped = 0;
  let errors = 0;

  for (const { item, contractor, siteDepartmentId } of items) {
    if (!contractor?.email || !item.dueDate || item.status === "completed") { skipped++; continue; }

    const leadTimeDays = item.leadTimeDays ?? 30;
    const dueDate = new Date(item.dueDate);
    const notifyDate = new Date(dueDate.getTime() - leadTimeDays * 24 * 60 * 60 * 1000);

    if (now < notifyDate || item.notificationSentAt) { skipped++; continue; }

    if (!settingsCache[item.clientId]) {
      settingsCache[item.clientId] = await getClientSettings(item.clientId);
    }
    const settings = settingsCache[item.clientId];
    const companyName = settings["companyName"] ?? "ComplyTrack";
    const fromEmail = settings["smtpFrom"] ?? process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
    const defaultLeadTimeDays = parseInt(settings["defaultLeadTimeDays"] ?? "30", 10);
    const ccList = await buildReminderCcList({
      clientId: item.clientId,
      settings,
      recipient: contractor.email!,
    });

    try {
       if (await sendReminderForItem({
         item, contractor, companyName, fromEmail, ccList, defaultLeadTimeDays,
         departmentId: siteDepartmentId ?? item.departmentId, now,
       })) queued++;
      else skipped++;
    } catch {
      errors++;
    }
  }

  return { queued, sent: 0, skipped, errors };
}

router.post("/notifications/send-reminders", requireAuth, requireClientAdmin, async (req, res) => {
  const callerClientId = getClientId(req);
  if (!callerClientId) {
    res.status(400).json({ error: "clientId required" });
    return;
  }

  const now = new Date();

  // Scope to the caller's client only — never iterate across tenants.
  const items = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable, siteDepartmentId: sitesTable.departmentId })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .leftJoin(sitesTable, and(
      eq(complianceItemsTable.siteId, sitesTable.id),
      eq(complianceItemsTable.clientId, sitesTable.clientId),
    ))
    .where(and(
      eq(complianceItemsTable.clientId, callerClientId),
      isNotNull(complianceItemsTable.contractorId),
    ));

  const settingsCache: Record<number, Record<string, string>> = {};

  const results: Array<{
    itemId: number;
    title: string;
    contractorEmail: string;
    status: "queued" | "skipped" | "error";
    reason?: string | null;
  }> = [];

  let queued = 0;
  let skipped = 0;
  let errors = 0;

  for (const { item, contractor, siteDepartmentId } of items) {
    if (!contractor?.email) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: "", status: "skipped", reason: "No contractor email" });
      skipped++; continue;
    }
    if (!item.dueDate) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: "No due date" });
      skipped++; continue;
    }
    if (item.status === "completed") {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: "Item completed" });
      skipped++; continue;
    }

    if (!settingsCache[item.clientId]) {
      settingsCache[item.clientId] = await getClientSettings(item.clientId);
    }
    const settings = settingsCache[item.clientId];
  const companyName = settings["companyName"] ?? "ComplyTrack";
  const fromEmail = settings["smtpFrom"] ?? process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const defaultLeadTimeDays = parseInt(settings["defaultLeadTimeDays"] ?? "30", 10);

    const leadTimeDays = item.leadTimeDays ?? defaultLeadTimeDays;
    const dueDate = new Date(item.dueDate);
    const notifyDate = new Date(dueDate.getTime() - leadTimeDays * 24 * 60 * 60 * 1000);

    if (now < notifyDate) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: `Not yet in notification window (notify from ${notifyDate.toLocaleDateString()})` });
      skipped++; continue;
    }
    if (item.notificationSentAt) {
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "skipped", reason: `Already notified on ${new Date(item.notificationSentAt).toLocaleDateString()}` });
      skipped++; continue;
    }

  const ccList = await buildReminderCcList({
    clientId: item.clientId,
    settings,
    recipient: contractor.email,
    actorEmail: req.currentUser?.email ?? null,
  });

    try {
      const wasQueued = await sendReminderForItem({
        item, contractor, companyName, fromEmail, ccList, defaultLeadTimeDays,
        departmentId: siteDepartmentId ?? item.departmentId, now,
      });
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email,
        status: wasQueued ? "queued" : "skipped",
        reason: wasQueued ? "Awaiting manager approval" : "Already queued for approval" });
      if (wasQueued) queued++; else skipped++;
    } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test email";
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "error", reason: message });
      errors++;
    }
  }

  res.json({ queued, sent: 0, skipped, errors, details: results });
});

router.post("/notifications/send-reminder/:itemId", requireAuth, requireClientAdmin, async (req, res) => {
  const itemId = parseInt(req.params.itemId as string, 10);
  if (!Number.isFinite(itemId)) return void res.status(400).json({ error: "Invalid item id" });

  const callerClientId = getClientId(req);
  if (!callerClientId) return void res.status(400).json({ error: "clientId required" });

  const rows = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable, siteDepartmentId: sitesTable.departmentId })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .leftJoin(sitesTable, and(
      eq(complianceItemsTable.siteId, sitesTable.id),
      eq(complianceItemsTable.clientId, sitesTable.clientId),
    ))
    .where(and(eq(complianceItemsTable.id, itemId), eq(complianceItemsTable.clientId, callerClientId)))
    .limit(1);

  const row = rows[0];
  if (!row) return void res.status(404).json({ error: "This scheduling link is no longer valid." });
  const { item, contractor } = row;
  if (!contractor?.email) return void res.status(400).json({ error: "Contractor record is missing — please contact the business directly." });

  const settings = await getClientSettings(row.item.clientId);
  const companyName = settings["companyName"] ?? "ComplyTrack";
  const fromEmail = settings["smtpFrom"] ?? process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const defaultLeadTimeDays = parseInt(settings["defaultLeadTimeDays"] ?? "30", 10);
  const ccList = await buildReminderCcList({
    clientId: item.clientId,
    settings,
    recipient: contractor.email,
    actorEmail: req.currentUser?.email ?? null,
  });

  const queued = await sendReminderForItem({
    item,
    contractor,
    companyName,
    fromEmail,
    ccList,
    defaultLeadTimeDays,
    departmentId: row.siteDepartmentId ?? item.departmentId,
    now: new Date(),
  });

  // Don't echo individual CC addresses back to the caller — only a count.
  const ccSummary = ccList.length > 0 ? ` (with ${ccList.length} cc'd)` : "";
  res.json({ success: true, queued, sent: false,
    message: queued ? `Reminder queued for manager approval${ccSummary}` : "Reminder is already awaiting manager approval" });
});

// ----- Public scheduling endpoints (no auth — token is the credential) -----
// Only the SHA-256 digest of a scheduling token is stored, so the presented
// token is hashed before lookup; a stolen digest is not itself a valid link.

const SCHEDULE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function scheduleTokenDigest(raw: unknown): string | null {
  return typeof raw === "string" && SCHEDULE_TOKEN.test(raw) ? digestBearerToken(raw) : null;
}

async function findScheduleItem(digest: string) {
  const rows = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.scheduleTokenHash, digest))
    .limit(1);
  return rows[0];
}

/**
 * Public, token-protected scheduling routes. Mounted in routes/index.ts ahead of
 * any router that installs root-level requireAuth, with the public-link rate
 * limits, like the contractor portal.
 */
export const notificationsPublicRouter: IRouter = Router();

notificationsPublicRouter.get("/:token", async (req, res) => {
  const digest = scheduleTokenDigest(req.params.token);
  const row = digest ? await findScheduleItem(digest) : undefined;
  if (!row) return void res.status(404).json({ error: "This scheduling link is no longer valid." });

  const settings = await getClientSettings(row.item.clientId);
  res.json({
    itemTitle: row.item.title,
    notes: row.item.notes,
    dueDate: row.item.dueDate,
    contractorName: row.contractor?.name ?? null,
    companyName: settings["companyName"] ?? "ComplyTrack",
    alreadyScheduled: row.item.visitScheduledAt,
  });
});

notificationsPublicRouter.post("/:token", async (req, res) => {
  const digest = scheduleTokenDigest(req.params.token);
  if (!digest) return void res.status(404).json({ error: "This scheduling link is no longer valid." });
  const { date } = req.body ?? {};
  if (!date || typeof date !== "string") return void res.status(400).json({ error: "Please choose a date." });

  const proposed = new Date(date);
  if (Number.isNaN(proposed.getTime())) return void res.status(400).json({ error: "That date isn't valid." });
  if (proposed.getTime() < Date.now() - 24 * 60 * 60 * 1000) return void res.status(400).json({ error: "Please choose a date in the future." });

  const row = await findScheduleItem(digest);
  if (!row) return void res.status(404).json({ error: "This scheduling link is no longer valid." });
  const { item, contractor } = row;
  if (!contractor?.email) return void res.status(400).json({ error: "Contractor record is missing — please contact the business directly." });

  const settings = await getClientSettings(item.clientId);
  const companyName = settings["companyName"] ?? "ComplyTrack";
  const maintenanceEmail = settings["maintenanceEmail"] ?? null;
  const fromEmail = settings["smtpFrom"] ?? process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

  const ics = buildCalendarInvite({
    itemTitle: item.title,
    dueDate: proposed,
    contractorName: contractor.name,
    contractorEmail: contractor.email,
    companyName,
    fromEmail,
    notes: item.notes,
  });

  const dateStr = proposed.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const safeTitle = item.title.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Visit Confirmed</h2>
      <p>Thank you ${contractor.name}.</p>
      <p>Your visit for <strong>${item.title}</strong> is scheduled for <strong>${dateStr}</strong>.</p>
      <p>Best regards,<br><strong>${companyName}</strong></p>
    </div>`;
  const text = `Visit Confirmed\n\nYour visit for ${item.title} is scheduled for ${dateStr}.\n\n${companyName}`;

  const confirmationSubject = `Visit Confirmed: ${item.title} — ${dateStr}`;
  // Consume the link and queue the confirmation atomically. The conditional
  // update on the digest is the one-time claim: of concurrent submissions
  // only one matches, and a rotated or used link matches none.
  const claimed = await db.transaction(async (tx) => {
    const consumed = await tx
      .update(complianceItemsTable)
      .set({ visitScheduledAt: proposed, scheduleTokenHash: null, scheduleToken: null })
      .where(and(
        eq(complianceItemsTable.id, item.id),
        eq(complianceItemsTable.clientId, item.clientId),
        eq(complianceItemsTable.scheduleTokenHash, digest),
      ))
      .returning({ id: complianceItemsTable.id });
    if (consumed.length === 0) return false;
    await tx.execute(sql`INSERT INTO contractor_email_queue
    (client_id,entity_type,entity_id,contractor_id,email_type,mode,to_email,subject,body_html,body_text,cc_json,ics_content,ics_filename,email_preview_json,idempotency_key)
    VALUES (${item.clientId},'compliance',${item.id},${contractor.id},'reminder','assign',${contractor.email},
      ${confirmationSubject},${html},${text},${JSON.stringify(maintenanceEmail ? [maintenanceEmail] : [])}::jsonb,
      ${ics},${`${safeTitle}.ics`},${JSON.stringify({ subject: confirmationSubject, html, text })}::jsonb,
      ${`schedule-confirmation-${item.clientId}-${item.id}-${proposed.toISOString().slice(0,10)}`})
    ON CONFLICT (idempotency_key) DO NOTHING`);
    return true;
  });
  if (!claimed) return void res.status(404).json({ error: "This scheduling link is no longer valid." });

  res.json({ success: true, message: `Visit scheduled for ${dateStr}.`, scheduledFor: proposed });
});

router.post("/notifications/test-email", requireAuth, requireClientAdmin, async (req, res) => {
  const { to } = TestEmailBody.parse(req.body);
  const callerClientId = getClientId(req);

  try {
    await sendEmail({
      to,
      subject: "ComplyTrack — Test Email",
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1e293b;">Test Email</h2>
        <p>This is a test email from your ComplyTrack system. Your email settings are configured correctly!</p>
        <p style="color: #64748b; font-size: 14px;">Sent via Resend.</p>
      </div>`,
      text: "This is a test email from your ComplyTrack system. Your email settings are configured correctly!",
      clientId: callerClientId,
    });
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test email";
    res.json({ success: false, message });
  }
});

export default router;
