import { randomBytes } from "crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { consultantClientsTable, privacyRightsRequestsTable, usersTable } from "@workspace/db/schema";
import { escapeHtml, getPublicAppUrl, sendSystemEmail } from "./email";
import { logger } from "./logger";

/** Form-link tokens are 32 random bytes, base64url encoded. */
export const INTAKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newIntakeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function intakeUrl(token: string): string {
  return `${getPublicAppUrl()}/privacy-request/${token}`;
}

// No 0/O/1/I so a reference read out over the phone is unambiguous.
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Reference shown to the requester, e.g. PR-7KQ4M2XD. Not derived from any id. */
export function newPublicReference(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `PR-${code}`;
}

/** One calendar month after receipt, clamped to the month's last day. */
export function addCalendarMonth(value: Date): Date {
  const result = new Date(value);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}

export interface PrivacyAdministrator {
  id: number;
  name: string;
  email: string;
}

/**
 * People who can manage this business's Privacy Centre: its active client
 * admins, and active consultants who belong to it or are linked to it
 * (self-signup owners are consultants linked to their own business).
 */
export async function privacyAdministrators(clientId: number): Promise<PrivacyAdministrator[]> {
  const linked = await db
    .select({ userId: consultantClientsTable.userId })
    .from(consultantClientsTable)
    .where(eq(consultantClientsTable.clientId, clientId));
  const linkedIds = linked.map((row) => row.userId);
  const rows = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(and(
      eq(usersTable.active, true),
      or(
        and(eq(usersTable.clientId, clientId), inArray(usersTable.role, ["client_admin", "consultant"])),
        linkedIds.length ? and(eq(usersTable.role, "consultant"), inArray(usersTable.id, linkedIds)) : undefined,
      ),
    ))
    .limit(50);
  return rows
    .filter((row) => Boolean(row.email))
    .map((row) => ({ id: row.id, name: row.name, email: row.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const REQUEST_TYPE_LABELS: Record<string, string> = {
  access: "Access to personal data",
  rectification: "Correction of personal data",
  erasure: "Deletion of personal data",
  restriction: "Restriction of processing",
  portability: "Data portability",
  objection: "Objection to processing",
  other: "Other privacy request",
};

export function requestTypeLabel(type: string): string {
  return REQUEST_TYPE_LABELS[type] ?? type;
}

/**
 * Tell the assigned administrator (or, with none assigned, every
 * administrator) that an online request arrived. The email names the request
 * type and deadline only: the requester's name, contact and details stay in
 * the Privacy Centre behind sign-in.
 */
export async function notifyPrivacyAdministrators(opts: {
  clientId: number;
  requestId: number;
  requestType: string;
  publicReference: string;
  receivedAt: Date;
  dueAt: Date;
  assigneeId: number | null;
  businessName: string;
}): Promise<void> {
  const administrators = await privacyAdministrators(opts.clientId);
  const assignee = opts.assigneeId ? administrators.find((admin) => admin.id === opts.assigneeId) : undefined;
  const recipients = assignee ? [assignee] : administrators;
  if (recipients.length === 0) {
    logger.warn({ clientId: opts.clientId, requestId: opts.requestId }, "Online privacy request has no administrator to notify");
    return;
  }

  const link = `${getPublicAppUrl()}/privacy-governance`;
  const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "Europe/London" });
  const timeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/London" });
  const type = requestTypeLabel(opts.requestType);
  const subject = `New privacy request ${opts.publicReference}`;
  const lines = [
    `${opts.businessName} received a privacy rights request through its online request form.`,
    "",
    `Reference: ${opts.publicReference}`,
    `Request type: ${type}`,
    `Received: ${timeFormat.format(opts.receivedAt)} (UK time)`,
    `Response due by: ${dateFormat.format(opts.dueAt)}, unless you extend it`,
    "",
    "The requester's identity has not been checked. Review the request, confirm who is asking, and record your decision in the Privacy Centre:",
    link,
    "",
    "For privacy, this email does not include the requester's details.",
  ];
  const html = `<p>${escapeHtml(lines[0])}</p>
<ul>
<li>Reference: <strong>${escapeHtml(opts.publicReference)}</strong></li>
<li>Request type: ${escapeHtml(type)}</li>
<li>Received: ${escapeHtml(timeFormat.format(opts.receivedAt))} (UK time)</li>
<li>Response due by: ${escapeHtml(dateFormat.format(opts.dueAt))}, unless you extend it</li>
</ul>
<p>The requester's identity has not been checked. Review the request, confirm who is asking, and record your decision in the Privacy Centre.</p>
<p><a href="${escapeHtml(link)}">Open the Privacy Centre</a></p>
<p style="color:#666;font-size:12px">For privacy, this email does not include the requester's details.</p>`;

  let delivered = 0;
  for (const recipient of recipients) {
    try {
      await sendSystemEmail({
        to: recipient.email,
        subject,
        html,
        text: lines.join("\n"),
        idempotencyKey: `privacy-intake-${opts.requestId}-${recipient.id}`,
      });
      delivered++;
    } catch (err) {
      logger.warn({ err, clientId: opts.clientId, requestId: opts.requestId }, "Could not email an administrator about an online privacy request");
    }
  }
  if (delivered > 0) {
    await db.update(privacyRightsRequestsTable)
      .set({ adminNotifiedAt: new Date() })
      .where(and(eq(privacyRightsRequestsTable.id, opts.requestId), eq(privacyRightsRequestsTable.clientId, opts.clientId)));
  }
}
