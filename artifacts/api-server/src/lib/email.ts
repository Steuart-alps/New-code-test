import { Resend } from "resend";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { randomUUID } from "crypto";

function getResend(apiKeyOverride?: string | null) {
  const apiKey = apiKeyOverride?.trim() || process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  return new Resend(apiKey);
}

export async function getEmailSettings(clientId?: number | null): Promise<Record<string, string>> {
  if (!clientId) return {};
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where((await import("drizzle-orm")).eq(appSettingsTable.clientId, clientId));
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (row.value !== null && row.value !== undefined) {
      settings[row.key] = row.value;
    }
  }
  return settings;
}

function buildFrom(settings: Record<string, string>): string {
  const email = settings["smtpFrom"] ?? process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const name = settings["smtpFromName"] ?? "ComplyTrack";
  return `${name} <${email}>`;
}

/**
 * Normalises a comma / semicolon / whitespace separated list of email
 * addresses into a deduped array. Empty input → [].
 */
export function parseEmailList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /.+@.+\..+/.test(s));
  return Array.from(new Set(parts.map((s) => s.toLowerCase())));
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[];
  icsAttachment?: string;
  icsFilename?: string;
  clientId?: number | null;
}) {
  const settings = await getEmailSettings(opts.clientId ?? null);
  const resend = getResend(settings["resendApiKey"]);
  const from = buildFrom(settings);

  const attachments = opts.icsAttachment
    ? [
        {
          filename: opts.icsFilename ?? "invite.ics",
          content: Buffer.from(opts.icsAttachment),
        },
      ]
    : undefined;

  const toList = Array.isArray(opts.to) ? opts.to : [opts.to];
  const ccList = opts.cc
    ? Array.isArray(opts.cc)
      ? opts.cc
      : [opts.cc]
    : undefined;

  const result = await resend.emails.send({
    from,
    to: toList,
    cc: ccList,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments,
  });
  if (result.error) {
    throw new Error(`Email delivery failed: ${result.error.message ?? result.error.name ?? "unknown error"}`);
  }
}

export async function sendSystemEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  const resend = getResend();
  const email = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const from = `ComplyTrack <${email}>`;
  const result = await resend.emails.send({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
  if (result.error) {
    throw new Error(`Email delivery failed: ${result.error.message ?? result.error.name ?? "unknown error"}`);
  }
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
    `PRODID:-//ComplyTrack//EN`,
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

export function getPublicAppUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (explicit) return explicit;
  const domain = (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim();
  if (domain) return `https://${domain}`;
  return "http://localhost:5173";
}

export function buildReminderEmail(opts: {
  contractorName: string;
  companyName: string;
  itemTitle: string;
  dueDate: Date;
  leadTimeDays: number;
  notes?: string | null;
  ccMaintenanceEmail?: string | null;
  scheduleLink?: string | null;
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
      ${opts.scheduleLink ? `
      <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
        <p style="margin: 0 0 12px; color: #1e293b; font-weight: 600;">Pick a suitable visit date</p>
        <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">Click below to choose the day that works best for you. Once you confirm, a calendar invite will be sent to everyone.</p>
        <a href="${opts.scheduleLink}" style="display: inline-block; background: #4f46e5; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Propose a Visit Date</a>
      </div>
      ` : `
      <p>Please contact us to arrange your visit or inspection at your earliest convenience.</p>
      <p style="color: #475569;">A calendar appointment has been attached to this email — click it to add the due date directly to your calendar.</p>
      `}
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

${opts.scheduleLink ? `Pick a suitable visit date here:\n${opts.scheduleLink}\n\nOnce you confirm, a calendar invite will be sent to everyone.` : "A calendar appointment is attached — open it to add the due date to your calendar.\n\nPlease contact us to arrange your visit or inspection at your earliest convenience."}

Best regards,
${opts.companyName}
  `.trim();

  return { html, text };
}
