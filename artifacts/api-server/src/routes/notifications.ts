import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { complianceItemsTable, contractorsTable, appSettingsTable } from "@workspace/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { sendEmail, sendSystemEmail } from "../lib/email";
import { buildReminderEmail, buildCalendarInvite, getPublicAppUrl } from "../lib/email";
import { TestEmailBody } from "@workspace/api-zod";
import { randomUUID } from "crypto";

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
  maintenanceEmail: string | null;
  defaultLeadTimeDays: number;
  now: Date;
}): Promise<void> {
  const { item, contractor, companyName, fromEmail, maintenanceEmail, defaultLeadTimeDays, now } = opts;

  const leadTimeDays = item.leadTimeDays ?? defaultLeadTimeDays;
  const dueDate = new Date(item.dueDate!);

  // Generate (or rotate) a single-use schedule token so the contractor can
  // propose a visit date directly from the email.
  const scheduleToken = randomUUID();
  const scheduleLink = `${getPublicAppUrl()}/schedule/${scheduleToken}`;

  const { html, text } = buildReminderEmail({
    contractorName: contractor.name,
    companyName,
    itemTitle: item.title,
    dueDate,
    leadTimeDays,
    notes: item.notes,
    ccMaintenanceEmail: maintenanceEmail,
    scheduleLink,
  });

  await sendEmail({
    to: contractor.email!,
    cc: maintenanceEmail ?? undefined,
    subject: `Compliance Check Reminder: ${item.title}`,
    html,
    text,
    clientId: item.clientId,
  });

  await db
    .update(complianceItemsTable)
    .set({ notificationSentAt: now, scheduleToken, visitScheduledAt: null })
    .where(eq(complianceItemsTable.id, item.id));
}

export async function runReminderJob(): Promise<{ sent: number; skipped: number; errors: number }> {
  const now = new Date();

  const items = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(isNotNull(complianceItemsTable.contractorId));

  const settingsCache: Record<number, Record<string, string>> = {};

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const { item, contractor } of items) {
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
    const maintenanceEmail = settings["maintenanceEmail"] ?? null;
    const fromEmail = settings["smtpFrom"] ?? process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
    const defaultLeadTimeDays = parseInt(settings["defaultLeadTimeDays"] ?? "30", 10);

    try {
      await sendReminderForItem({ item, contractor, companyName, fromEmail, maintenanceEmail, defaultLeadTimeDays, now });
      sent++;
    } catch {
      errors++;
    }
  }

  return { sent, skipped, errors };
}

router.post("/notifications/send-reminders", async (req, res) => {
  const now = new Date();

  const items = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(isNotNull(complianceItemsTable.contractorId));

  const settingsCache: Record<number, Record<string, string>> = {};

  const results: Array<{
    itemId: number;
    title: string;
    contractorEmail: string;
    status: "sent" | "skipped" | "error";
    reason?: string | null;
  }> = [];

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const { item, contractor } of items) {
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
    const maintenanceEmail = settings["maintenanceEmail"] ?? null;
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

    try {
      await sendReminderForItem({ item, contractor, companyName, fromEmail, maintenanceEmail, defaultLeadTimeDays, now });
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "sent" });
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({ itemId: item.id, title: item.title, contractorEmail: contractor.email, status: "error", reason: message });
      errors++;
    }
  }

  res.json({ sent, skipped, errors, details: results });
});

router.post("/notifications/send-reminder/:itemId", async (req, res) => {
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(itemId)) return res.status(400).json({ error: "Invalid item id" });

  const rows = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.id, itemId))
    .limit(1);

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Compliance check not found" });
  const { item, contractor } = row;

  if (!contractor) return res.status(400).json({ error: "This check has no contractor assigned." });
  if (!contractor.email) return res.status(400).json({ error: `${contractor.name} does not have an email address on file.` });
  if (!item.dueDate) return res.status(400).json({ error: "This check has no due date set." });

  const settings = await getClientSettings(item.clientId);
  const companyName = settings["companyName"] ?? "ComplyTrack";
  const maintenanceEmail = settings["maintenanceEmail"] ?? null;
  const fromEmail = settings["smtpFrom"] ?? process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const defaultLeadTimeDays = parseInt(settings["defaultLeadTimeDays"] ?? "30", 10);

  await sendReminderForItem({
    item,
    contractor,
    companyName,
    fromEmail,
    maintenanceEmail,
    defaultLeadTimeDays,
    now: new Date(),
  });

  res.json({ success: true, message: `Reminder sent to ${contractor.email}` });
});

// ----- Public scheduling endpoints (no auth — token is the credential) -----

router.get("/notifications/public/schedule/:token", async (req, res) => {
  const token = req.params.token;
  const rows = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.scheduleToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "This scheduling link is no longer valid." });

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

router.post("/notifications/public/schedule/:token", async (req, res) => {
  const token = req.params.token;
  const { date } = req.body ?? {};
  if (!date || typeof date !== "string") return res.status(400).json({ error: "Please choose a date." });

  const proposed = new Date(date);
  if (Number.isNaN(proposed.getTime())) return res.status(400).json({ error: "That date isn't valid." });
  if (proposed.getTime() < Date.now() - 24 * 60 * 60 * 1000) return res.status(400).json({ error: "Please choose a date in the future." });

  const rows = await db
    .select({ item: complianceItemsTable, contractor: contractorsTable })
    .from(complianceItemsTable)
    .leftJoin(contractorsTable, eq(complianceItemsTable.contractorId, contractorsTable.id))
    .where(eq(complianceItemsTable.scheduleToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) return res.status(404).json({ error: "This scheduling link is no longer valid." });
  const { item, contractor } = row;
  if (!contractor?.email) return res.status(400).json({ error: "Contractor record is missing — please contact the business directly." });

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
      <p>A calendar invite is attached — open it to add the appointment to your calendar.</p>
      <p>Best regards,<br><strong>${companyName}</strong></p>
    </div>`;
  const text = `Visit Confirmed\n\nYour visit for ${item.title} is scheduled for ${dateStr}.\n\nA calendar invite is attached.\n\n${companyName}`;

  await sendEmail({
    to: contractor.email,
    cc: maintenanceEmail ?? undefined,
    subject: `Visit Confirmed: ${item.title} — ${dateStr}`,
    html,
    text,
    icsAttachment: ics,
    icsFilename: `${safeTitle}.ics`,
    clientId: item.clientId,
  });

  // Burn the token so the link can't be reused, and record the chosen date.
  await db
    .update(complianceItemsTable)
    .set({ visitScheduledAt: proposed, scheduleToken: null })
    .where(eq(complianceItemsTable.id, item.id));

  res.json({ success: true, message: `Visit scheduled for ${dateStr}.`, scheduledFor: proposed });
});

router.post("/notifications/test-email", async (req, res) => {
  const { to } = TestEmailBody.parse(req.body);

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
    });
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test email";
    res.json({ success: false, message });
  }
});

export default router;
