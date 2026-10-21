import { Resend } from "resend";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { randomUUID } from "crypto";
import { appendFile } from "node:fs/promises";

/** Upper bound for one email provider request (a hung connection fails the send). */
const RESEND_REQUEST_TIMEOUT_MS = 15_000;

function getResend(apiKeyOverride?: string | null) {
  const apiKey = apiKeyOverride?.trim() || process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  const resend = new Resend(apiKey);
  // The SDK sends every request through fetchRequest(path, init) without a
  // timeout. Give each one an abort deadline; the SDK reports the abort as an
  // error result, which the senders below turn into a failed send.
  const client = resend as unknown as { fetchRequest?: (path: string, init?: RequestInit) => Promise<unknown> };
  const fetchRequest = client.fetchRequest?.bind(resend);
  if (fetchRequest) {
    client.fetchRequest = (path, init = {}) =>
      fetchRequest(path, { ...init, signal: init.signal ?? AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS) });
  }
  return resend;
}

/**
 * Configuration problems that stop system email reaching customers. Fixed,
 * non-secret strings: reported at start-up and in /readyz details.
 */
export function describeEmailConfigurationIssues(): string[] {
  const issues: string[] = [];
  if (!process.env.RESEND_API_KEY?.trim()) issues.push("RESEND_API_KEY is not set: emails cannot be sent");
  if (!process.env.RESEND_FROM_EMAIL?.trim()) {
    issues.push("RESEND_FROM_EMAIL is not set: mail is sent from onboarding@resend.dev, which only delivers to the Resend account owner");
  }
  return issues;
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

const SENDER_ADDRESS = /^[^\s@<>"(),;:\\[\]]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/**
 * Whether a business may send as `address`. With the platform's provider
 * account, only the business's own registered sending domain is allowed
 * (resendDomainName, set by routes/emailDomain.ts), so one business can never
 * send as another business or as the platform. A business that connected its
 * own provider key sends through that account, which only delivers from
 * domains verified there.
 */
export function isAllowedTenantSender(address: string | null | undefined, settings: Record<string, string | null | undefined>): boolean {
  const domain = address?.trim().match(SENDER_ADDRESS)?.[1]?.toLowerCase();
  if (!domain) return false;
  if (settings["resendApiKey"]?.trim()) return true;
  const ownDomain = settings["resendDomainName"]?.trim().toLowerCase();
  return !!ownDomain && domain === ownDomain;
}

/** A display name safe to place in a From header (no quotes, brackets or line breaks). */
export function sanitizeSenderName(name: string | null | undefined): string {
  return (name ?? "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function senderAddress(settings: Record<string, string>): string {
  // A stored address that is not on the business's own domain (e.g. saved
  // before this check existed) falls back to the platform sender.
  return isAllowedTenantSender(settings["smtpFrom"], settings)
    ? settings["smtpFrom"].trim()
    : process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
}

function buildFrom(settings: Record<string, string>): string {
  const name = sanitizeSenderName(settings["smtpFromName"]) || "ComplyTrack";
  return `${name} <${senderAddress(settings)}>`;
}

/**
 * The bare address a business's email is sent from (the same validated
 * sender as sendEmail's From header), e.g. for a calendar invite organiser.
 * Never the raw stored smtpFrom.
 */
export function getSenderEmail(settings: Record<string, string>): string {
  const address = senderAddress(settings);
  return address.match(/<([^>]+)>/)?.[1]?.trim() ?? address.trim();
}

export async function getClientSenderEmail(clientId: number): Promise<string> {
  return getSenderEmail(await getEmailSettings(clientId));
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

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * MIME type for an invite attachment. Naming the iTIP method lets mail clients
 * such as Outlook and Gmail handle the part as an invitation, so a revision or
 * cancellation with the same UID updates the existing event rather than
 * arriving as a plain file; the charset keeps accented names and emoji intact.
 */
export function calendarAttachmentContentType(ics: string): string {
  const method = ics.match(/^METHOD:([A-Z-]+)\r?$/m)?.[1] ?? "REQUEST";
  return `text/calendar; charset=UTF-8; method=${method}`;
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[];
  icsAttachment?: string;
  icsFilename?: string;
  attachments?: EmailAttachment[];
  clientId?: number | null;
  /** Stable key used by providers to make a retried dispatch non-duplicating. */
  idempotencyKey?: string;
}) {
  const settings = await getEmailSettings(opts.clientId ?? null);
  const resend = getResend(settings["resendApiKey"]);
  const from = buildFrom(settings);

  const icsEntry: EmailAttachment | undefined = opts.icsAttachment
    ? {
        filename: opts.icsFilename ?? "invite.ics",
        content: Buffer.from(opts.icsAttachment, "utf8"),
        contentType: calendarAttachmentContentType(opts.icsAttachment),
      }
    : undefined;

  const attachments =
    icsEntry || opts.attachments?.length
      ? [...(icsEntry ? [icsEntry] : []), ...(opts.attachments ?? [])]
      : undefined;

  const toList = Array.isArray(opts.to) ? opts.to : [opts.to];
  const ccList = opts.cc
    ? Array.isArray(opts.cc)
      ? opts.cc
      : [opts.cc]
    : undefined;

  const payload = {
    from,
    to: toList,
    cc: ccList,
    subject: opts.subject,
    html: applyEmailLayout(opts.html),
    text: opts.text,
    attachments,
  };
  // Resend treats a repeated idempotency key as the same accepted email.
  // Keep this at the common transport boundary so callers cannot accidentally
  // retry an uncertain contractor dispatch with a new provider request.
  const result = await (resend.emails.send as any)(
    payload,
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
  );
  if (result.error) {
    throw new Error(`Email delivery failed: ${result.error.message ?? result.error.name ?? "unknown error"}`);
  }
}

/**
 * Escapes user-supplied text before embedding it in an HTML email.
 * Without this, a name like `<script>…</script>` becomes executable HTML.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Marks HTML that already carries the shared layout, so it is not wrapped twice. */
const EMAIL_LAYOUT_MARKER = 'data-complytrack-email="1"';

/** Brand colours shared by every email. */
export const EMAIL_BRAND = {
  header: "#0f172a",
  button: "#2563eb",
} as const;

/** Call-to-action link styled as the shared blue button. `href` must be safe for an attribute. */
export function emailButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${EMAIL_BRAND.button};color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">${label}</a>`;
}

/**
 * The one design every ComplyTrack email uses: dark header with the
 * ComplyTrack name, a white card for the message, and a footer with the ALPS
 * logo and legal name. `subtitle` and `footerNote` are HTML; callers escape
 * any business text in them.
 */
export function renderEmailLayout(opts: { bodyHtml: string; subtitle?: string; footerNote?: string }): string {
  const appUrl = getPublicAppUrl();
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body ${EMAIL_LAYOUT_MARKER} style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.07);">
    <div style="background:${EMAIL_BRAND.header};padding:32px 40px;">
      <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">🛡️ ComplyTrack</div>
      ${opts.subtitle ? `<div style="font-size:14px;color:#94a3b8;margin-top:6px;">${opts.subtitle}</div>` : ""}
    </div>
    <div style="padding:32px 40px;color:#334155;font-size:15px;line-height:1.5;">
${opts.bodyHtml}
    </div>
    <div style="padding:24px 40px;border-top:1px solid #f1f5f9;font-size:12px;color:#94a3b8;text-align:center;line-height:1.6;">
      <a href="${escapeHtml(appUrl)}" style="color:#94a3b8;text-decoration:none;"><img src="${escapeHtml(appUrl)}/email-assets/alps-logo.png" width="96" height="60" alt="ALPS Consultancy" style="display:block;margin:0 auto 12px;border:0;color:#94a3b8;font-size:12px;"/></a>
      ComplyTrack by ALPS Consultancy${opts.footerNote ? ` · ${opts.footerNote}` : ""}<br/>
      ALPS Consulting Ltd t/as ALPS Consultancy
    </div>
  </div>
</body>
</html>`;
}

/**
 * Put an email body into the shared layout. Bodies built with
 * renderEmailLayout pass through unchanged; a full HTML document keeps only
 * what is inside its <body>.
 */
export function applyEmailLayout(html: string): string {
  if (html.includes(EMAIL_LAYOUT_MARKER)) return html;
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return renderEmailLayout({ bodyHtml: body });
}

/** Extract a bare email address from a value that may include a display name,
 *  e.g. "Name <email@example.com>" → "email@example.com". */
function extractEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim() : raw.trim();
}

const testEmailRejectionOccurrences = new Map<string, number>();

export async function sendSystemEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Stable provider key for workflows which must never duplicate a handoff. */
  idempotencyKey?: string;
}) {
  // Integration tests can inspect exactly what would have been handed to the
  // provider without sending real mail. The same test-only transport can
  // simulate slow or failed delivery. This is deliberately restricted to test
  // mode and an explicitly configured capture file or behavior.
  const html = applyEmailLayout(opts.html);
  const capturePath = process.env.TEST_EMAIL_CAPTURE_PATH;
  const testBehavior = process.env.TEST_EMAIL_BEHAVIOR;
  if (process.env.NODE_ENV === "test" && (capturePath || testBehavior)) {
    if (process.env.TEST_EMAIL_REJECT_SUBJECT === opts.subject) {
      const occurrences = (testEmailRejectionOccurrences.get(opts.subject) ?? 0) + 1;
      testEmailRejectionOccurrences.set(opts.subject, occurrences);
      const rejectAtOccurrence = Number(process.env.TEST_EMAIL_REJECT_SUBJECT_OCCURRENCE ?? 1);
      if (occurrences === rejectAtOccurrence) {
        throw new Error("Simulated email delivery failure for selected subject");
      }
    }
    if (testBehavior === "delay") {
      const delayMs = Number(process.env.TEST_EMAIL_DELAY_MS ?? 2500);
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 2500));
    }
    if (testBehavior === "reject") {
      throw new Error("Simulated email delivery failure");
    }
    if (!capturePath) return;
    await appendFile(capturePath, `${JSON.stringify({
      to: opts.to,
      subject: opts.subject,
      html,
      text: opts.text,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    })}\n`);
    return;
  }

  const resend = getResend();
  const rawFrom = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const email = extractEmail(rawFrom);
  const from = `ComplyTrack <${email}>`;
  const result = await (resend.emails.send as any)({
    from,
    to: opts.to,
    subject: opts.subject,
    html,
    text: opts.text,
  }, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined);
  if (result.error) {
    throw new Error(`Email delivery failed: ${result.error.message ?? result.error.name ?? "unknown error"}`);
  }
}

export interface TwoFactorResetEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Render the security alert for an administrator's two-factor reset. The
 * output depends only on the recipient, their name and the reset time, so a
 * retry renders the identical message. It never includes secrets.
 */
export function buildTwoFactorResetEmail(opts: {
  to: string;
  name: string;
  resetAt: Date;
}): TwoFactorResetEmail {
  const when = opts.resetAt.toISOString();
  return {
    to: opts.to,
    subject: "Security alert: your two-factor authentication was reset",
    text: [
      `Hello ${opts.name},`,
      "",
      `An administrator reset your ComplyTrack two-factor authentication at ${when} (UTC).`,
      "If you did not expect this reset, contact your administrator immediately.",
      "Sign in and re-enrol your authenticator promptly. You must complete two-factor setup before accessing your account.",
      "",
      "ComplyTrack account security",
    ].join("\n"),
    html: `
      <h2>ComplyTrack account security</h2>
      <p>Hello ${escapeHtml(opts.name)},</p>
      <p>An administrator reset your two-factor authentication at <strong>${when} (UTC)</strong>.</p>
      <p>If you did not expect this reset, <strong>contact your administrator immediately</strong>.</p>
      <p>Sign in and re-enrol your authenticator promptly. You must complete two-factor setup before accessing your account.</p>
    `,
  };
}

function toIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeIcs(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

function escapeIcsParameter(str: string): string {
  return str.replace(/[\r\n]/g, "").replace(/\^/g, "^^").replace(/"/g, "^'");
}

function sanitizeIcsAddress(str: string): string {
  return str.replace(/[\r\n]/g, "").trim();
}

function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let limit = 75;
  for (const char of line) {
    if (current && Buffer.byteLength(current + char, "utf8") > limit) {
      parts.push(current);
      current = char;
      // A continuation line begins with one folding-space octet.
      limit = 74;
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts.map((part, index) => index === 0 ? part : ` ${part}`).join("\r\n");
}

export function buildCalendarInvite(opts: {
  itemTitle: string;
  dueDate: Date;
  contractorName: string;
  contractorEmail: string;
  companyName: string;
  fromEmail: string;
  notes?: string | null;
  descriptionLabel?: string;
  extraAttendees?: { name?: string; email: string }[];
  /** Supply a stable UID when later invitations should update the same event. */
  uid?: string;
  /** Increment when updating an invitation with the same UID. */
  sequence?: number;
  /** Date-only work is represented as an all-day event, ending the next day. */
  allDay?: boolean;
  method?: "REQUEST" | "CANCEL";
  eventStatus?: "CONFIRMED" | "CANCELLED";
  /** Override generation time for deterministic compatibility fixtures. */
  generatedAt?: Date;
}): string {
  const uid = opts.uid ?? randomUUID();
  const now = opts.generatedAt ?? new Date();
  const endDate = new Date(opts.dueDate.getTime() + (opts.allDay ? 24 : 1) * 60 * 60 * 1000);
  const toIcsDay = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");

  const description = [
    `${opts.descriptionLabel ?? "Compliance check due"}: ${opts.itemTitle}`,
    opts.notes ? opts.notes : "",
    ``,
    `Scheduled by ${opts.companyName}`,
  ]
    .filter(Boolean)
    .map((part) => escapeIcs(part.replace(/\r/g, "")))
    .join("\\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//ComplyTrack//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.method ?? "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${Math.max(0, Math.trunc(opts.sequence ?? 0))}`,
    `DTSTAMP:${toIcsDate(now)}`,
    opts.allDay ? `DTSTART;VALUE=DATE:${toIcsDay(opts.dueDate)}` : `DTSTART:${toIcsDate(opts.dueDate)}`,
    opts.allDay ? `DTEND;VALUE=DATE:${toIcsDay(endDate)}` : `DTEND:${toIcsDate(endDate)}`,
    `SUMMARY:${escapeIcs(opts.itemTitle)}`,
    `DESCRIPTION:${description}`,
    `ORGANIZER;CN="${escapeIcsParameter(opts.companyName)}":MAILTO:${sanitizeIcsAddress(opts.fromEmail)}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="${escapeIcsParameter(opts.contractorName)}":MAILTO:${sanitizeIcsAddress(opts.contractorEmail)}`,
    ...(opts.extraAttendees ?? []).map(
      (a) => `ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="${escapeIcsParameter(a.name ?? a.email)}":MAILTO:${sanitizeIcsAddress(a.email)}`,
    ),
    `STATUS:${opts.eventStatus ?? "CONFIRMED"}`,
    "BEGIN:VALARM",
    "TRIGGER:-P1D",
    "ACTION:DISPLAY",
    `DESCRIPTION:Reminder: ${escapeIcs(opts.itemTitle)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export function getPublicAppUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL?.replace(/\/+$/, "");
  if (explicit) return explicit;
  // Render sets this to the service's own onrender.com address.
  const render = process.env.RENDER_EXTERNAL_URL?.replace(/\/+$/, "");
  if (render) return render;
  return "http://localhost:5173";
}

/**
 * Visit confirmation sent after a contractor picks a date from the public
 * scheduling link. Contractor, item and company names are business text, so
 * the HTML escapes them; the plain-text body and subject keep them verbatim.
 */
export function buildVisitConfirmationEmail(opts: {
  contractorName: string;
  companyName: string;
  itemTitle: string;
  visitDate: Date;
}): { subject: string; html: string; text: string; dateStr: string } {
  const dateStr = opts.visitDate.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Visit Confirmed</h2>
      <p>Thank you ${escapeHtml(opts.contractorName)}.</p>
      <p>Your visit for <strong>${escapeHtml(opts.itemTitle)}</strong> is scheduled for <strong>${escapeHtml(dateStr)}</strong>.</p>
      <p>Best regards,<br><strong>${escapeHtml(opts.companyName)}</strong></p>
    </div>`;
  const text = `Visit Confirmed\n\nThank you ${opts.contractorName}.\n\nYour visit for ${opts.itemTitle} is scheduled for ${dateStr}.\n\n${opts.companyName}`;
  const subject = `Visit Confirmed: ${opts.itemTitle} — ${dateStr}`;
  return { subject, html, text, dateStr };
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

  // Escape all user-supplied values before embedding in HTML to prevent injection
  const safeContractorName = escapeHtml(opts.contractorName);
  const safeItemTitle      = escapeHtml(opts.itemTitle);
  const safeCompanyName    = escapeHtml(opts.companyName);
  const safeNotes          = opts.notes ? escapeHtml(opts.notes) : null;
  // scheduleLink and ccMaintenanceEmail are system/admin-controlled, not end-user input,
  // but we validate scheduleLink is a real URL and ccMaintenanceEmail is an email address
  const safeScheduleLink   = opts.scheduleLink && /^https?:\/\//.test(opts.scheduleLink) ? opts.scheduleLink : null;
  const safeCcEmail        = opts.ccMaintenanceEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.ccMaintenanceEmail)
    ? opts.ccMaintenanceEmail : null;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Compliance Check Reminder</h2>
      <p>Dear ${safeContractorName},</p>
      <p>This is a reminder that the following compliance check is due in <strong>${opts.leadTimeDays} days</strong> on <strong>${dueDateStr}</strong>:</p>
      <div style="background: #f1f5f9; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0;">
        <h3 style="margin: 0 0 8px; color: #1e293b;">${safeItemTitle}</h3>
        ${safeNotes ? `<p style="color: #64748b; margin: 0;">${safeNotes}</p>` : ""}
      </div>
      ${safeScheduleLink ? `
      <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 8px; padding: 20px; margin: 20px 0; text-align: center;">
        <p style="margin: 0 0 12px; color: #1e293b; font-weight: 600;">Pick a suitable visit date</p>
        <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">Click below to choose the day that works best for you. Once you confirm, a calendar invite will be sent to everyone.</p>
        <a href="${safeScheduleLink}" style="display: inline-block; background: #2563eb; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Propose a Visit Date</a>
      </div>
      ` : `
      <p>Please contact us to arrange your visit or inspection at your earliest convenience.</p>
      <p style="color: #475569;">A calendar appointment has been attached to this email — click it to add the due date directly to your calendar.</p>
      `}
      <p>Best regards,<br><strong>${safeCompanyName}</strong></p>
      ${safeCcEmail ? `<p style="color: #94a3b8; font-size: 12px; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px;">This email has been copied to ${safeCcEmail} for your records.</p>` : ""}
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
