import nodemailer from "nodemailer";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { randomUUID } from "crypto";

export async function getEmailSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(appSettingsTable);
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (row.value !== null && row.value !== undefined) {
      settings[row.key] = row.value;
    }
  }
  return settings;
}

export function createTransporter(settings: Record<string, string>) {
  const host = settings["smtpHost"] ?? "";
  const port = parseInt(settings["smtpPort"] ?? "587", 10);
  const user = settings["smtpUser"] ?? "";
  const pass = settings["smtpPass"] ?? "";

  if (!host) throw new Error("SMTP host not configured. Please configure email settings.");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });
}

function toIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeIcs(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function buildCalendarInvite(opts: {
  itemTitle: string;
  dueDate: Date;
  contractorName: string;
  contractorEmail: string;
  companyName: string;
  fromEmail: string;
  notes?: string | null;
}): string {
  const uid = randomUUID();
  const now = new Date();
  const endDate = new Date(opts.dueDate.getTime() + 60 * 60 * 1000);

  const description = [
    `Compliance check due: ${opts.itemTitle}`,
    opts.notes ? opts.notes : "",
    ``,
    `Scheduled by ${opts.companyName}`,
  ].filter(Boolean).join("\\n");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//ALPS Compliance//EN`,
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcsDate(now)}`,
    `DTSTART:${toIcsDate(opts.dueDate)}`,
    `DTEND:${toIcsDate(endDate)}`,
    `SUMMARY:${escapeIcs(opts.itemTitle)}`,
    `DESCRIPTION:${description}`,
    `ORGANIZER;CN=${escapeIcs(opts.companyName)}:MAILTO:${opts.fromEmail}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=${escapeIcs(opts.contractorName)}:MAILTO:${opts.contractorEmail}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    `DESCRIPTION:Reminder: ${escapeIcs(opts.itemTitle)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  cc?: string;
  icsAttachment?: string;
  icsFilename?: string;
}) {
  const settings = await getEmailSettings();
  const transporter = createTransporter(settings);
  const from = settings["smtpFrom"]
    ? `${settings["smtpFromName"] ?? "ALPS Compliance"} <${settings["smtpFrom"]}>`
    : `"ALPS Compliance" <noreply@alps-compliance.local>`;

  const attachments = opts.icsAttachment
    ? [
        {
          filename: opts.icsFilename ?? "invite.ics",
          content: opts.icsAttachment,
          contentType: "text/calendar; method=REQUEST",
        },
      ]
    : undefined;

  await transporter.sendMail({
    from,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments,
  });
}

export function buildReminderEmail(opts: {
  contractorName: string;
  companyName: string;
  itemTitle: string;
  dueDate: Date;
  leadTimeDays: number;
  notes?: string | null;
  ccMaintenanceEmail?: string | null;
}) {
  const dueDateStr = opts.dueDate.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Compliance Check Reminder</h2>
      <p>Dear ${opts.contractorName},</p>
      <p>This is a reminder that the following compliance check is due in <strong>${opts.leadTimeDays} days</strong> on <strong>${dueDateStr}</strong>:</p>
      <div style="background: #f1f5f9; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0;">
        <h3 style="margin: 0 0 8px; color: #1e293b;">${opts.itemTitle}</h3>
        ${opts.notes ? `<p style="color: #64748b; margin: 0;">${opts.notes}</p>` : ""}
      </div>
      <p>Please contact us to arrange your visit or inspection at your earliest convenience.</p>
      <p style="color: #475569;">A calendar appointment has been attached to this email — click it to add the due date directly to your calendar.</p>
      <p>Best regards,<br><strong>${opts.companyName}</strong></p>
      ${opts.ccMaintenanceEmail ? `<p style="color: #94a3b8; font-size: 12px; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px;">This email has been copied to ${opts.ccMaintenanceEmail} for your records.</p>` : ""}
    </div>
  `;

  const text = `
Compliance Check Reminder

Dear ${opts.contractorName},

This is a reminder that the following compliance check is due in ${opts.leadTimeDays} days on ${dueDateStr}:

${opts.itemTitle}
${opts.notes ? opts.notes : ""}

A calendar appointment is attached — open it to add the due date to your calendar.

Please contact us to arrange your visit or inspection at your earliest convenience.

Best regards,
${opts.companyName}
  `.trim();

  return { html, text };
}
