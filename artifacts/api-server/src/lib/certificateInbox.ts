/**
 * Certificates sent to ComplyTrack rather than uploaded by a signed-in person
 * (Steuart, 2026-10-27: "can an email be set up within the app to receive
 * certificates, then can AI allocate the cert, read it, upload, change date,
 * initiate any follow ups?").
 *
 * Two ways in:
 *   - Email. Each business has its own address, <name>-<code>@CERTIFICATE_INBOX_DOMAIN
 *     (a subdomain whose MX record points at Resend). Resend posts each email
 *     to the inbound webhook (app.ts); it is recorded at once and its
 *     attachments are fetched afterwards (processInboundEmail), so a slow
 *     download never holds up, or repeats, the webhook.
 *   - The "Upload certificate" link in a contractor's emails for a check
 *     (reminder, visit confirmation, certificate chase): one link per email,
 *     only its digest stored, working for CERTIFICATE_UPLOAD_LINK_DAYS.
 *
 * Every certificate waits in "Certificates to confirm" (routes/certificate-inbox.ts).
 * Nothing is filed on its own: the person checks the AI's reading (the same
 * reader and screen as an uploaded certificate, lib/certificateReading.ts) and
 * saves it, which sets the next inspection date and raises one FixTrack job
 * for the C1, C2 and FI items.
 *
 * Who is trusted: a business's own contractors (their address, or another
 * address at the same company domain), its users and its ALPS consultants,
 * and the upload link. An email from anyone else is "held": kept for an Owner
 * to accept or dismiss, never read by AI on its own. An email whose sender
 * fails DMARC is held too, as it may be forged. An email with no certificate
 * attached from a trusted sender is kept as a "message", so a contractor's
 * reply to a chase ("it's waiting for the invoice") is not lost.
 */
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getAccountToday } from "./accountClock";
import { AiUnavailableError, claimAiUse, settleAiUse } from "./aiAllowance";
import { digestBearerToken, newBearerToken } from "./bearerTokens";
import { certificateCheckChoicesFor } from "./certificateCheckChoices";
import { readCertificate, type CertificateReadingResult } from "./certificateReading";
import { escapeHtml, getPublicAppUrl, getResend } from "./email";
import { logger } from "./logger";
import { ObjectContentError, ObjectStorageService } from "./objectStorage";
import { docxToText, ReportReadingError, UnreadableReportError, reportReadingConfigured } from "./reportReading";
import { ensureUploadCapacity } from "./storageLimit";
import { StorageFullError } from "./storageFull";
import { MAX_RESTRICTED_UPLOAD_BYTES, validateUploadContent, type AllowedUploadType } from "./uploadValidation";

/** Stands in for the upload link's token in a stored email draft (hydrated when sent). */
export const CERTIFICATE_UPLOAD_PLACEHOLDER = "{{CERT_UPLOAD_TOKEN}}";
export const CERTIFICATE_UPLOAD_LINK_DAYS = 180;
/** Files one upload link takes, so a leaked link cannot fill the business's storage. */
export const MAX_UPLOADS_PER_LINK = 20;
/** Largest certificate kept: the limit every checked upload has. */
export const MAX_INBOX_FILE_BYTES = MAX_RESTRICTED_UPLOAD_BYTES;
const MAX_ATTACHMENTS_PER_EMAIL = 10;
/** Smaller pictures in an email are logos and signatures, not certificates. */
const MIN_ATTACHED_IMAGE_BYTES = 20_000;
/** Held against the AI allowance while a certificate is read, as for an uploaded one. */
const CERTIFICATE_READING_ESTIMATE_PENCE = 15;
const MAX_EMAIL_ATTEMPTS = 5;
const MESSAGE_TEXT_CHARS = 4000;

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const STORED_TYPES: ReadonlySet<AllowedUploadType> = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif",
]);
const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", [DOCX_TYPE]: ".docx",
};

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

// ----- Configuration -----

/** The domain certificate addresses use, e.g. certs.alpsconsultancy.co.uk. Unset: no addresses. */
export function certificateInboxDomain(): string | null {
  const raw = process.env.CERTIFICATE_INBOX_DOMAIN?.trim().toLowerCase();
  return raw && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) ? raw : null;
}

/** The signing secret of the Resend webhook that delivers received emails. */
export function inboundWebhookSecret(): string | null {
  return process.env.RESEND_INBOUND_WEBHOOK_SECRET?.trim() || null;
}

/** Whether emailed certificates can arrive: an address domain and the webhook secret. */
export function certificateEmailConfigured(): boolean {
  return !!certificateInboxDomain() && !!inboundWebhookSecret();
}

// ----- The business's address -----

const SUFFIX_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789";

/** The readable start of an address, from the business name: "Kilmarnock Golf Club" -> "kilmarnock-golf-club". */
export function addressNameFor(businessName: string): string {
  const base = businessName.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 30).replace(/-+$/, "");
  return base || "certificates";
}

/** The name plus a short random code, so one business's address cannot be guessed from another's. */
function newLocalPart(businessName: string): string {
  let code = "";
  for (let i = 0; i < 5; i++) code += SUFFIX_LETTERS[randomInt(SUFFIX_LETTERS.length)];
  return `${addressNameFor(businessName)}-${code}`;
}

async function storedLocalPart(clientId: number): Promise<string | null> {
  const [row] = rowsOf<{ local_part: string }>(await db.execute(sql`
    SELECT local_part FROM certificate_inbox_addresses WHERE client_id = ${clientId}
  `));
  return row?.local_part ?? null;
}

/** The business's certificate address, made the first time it is needed. Null when no domain is set. */
export async function getCertificateInboxAddress(clientId: number): Promise<string | null> {
  const domain = certificateInboxDomain();
  if (!domain) return null;
  const existing = await storedLocalPart(clientId);
  if (existing) return `${existing}@${domain}`;
  // The name the business's emails use (Settings), else the account name.
  const [client] = rowsOf<{ name: string | null }>(await db.execute(sql`
    SELECT COALESCE(NULLIF(trim(s.value), ''), c.name) AS name
    FROM clients c LEFT JOIN app_settings s ON s.client_id = c.id AND s.key = 'companyName'
    WHERE c.id = ${clientId}
  `));
  if (!client) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = rowsOf<{ local_part: string }>(await db.execute(sql`
      INSERT INTO certificate_inbox_addresses (client_id, local_part)
      VALUES (${clientId}, ${newLocalPart(client.name ?? "")})
      ON CONFLICT DO NOTHING
      RETURNING local_part
    `))[0];
    if (inserted) return `${inserted.local_part}@${domain}`;
    // Another request made it first, or (rarely) the code was taken.
    const raced = await storedLocalPart(clientId);
    if (raced) return `${raced}@${domain}`;
  }
  throw new Error("Could not create a certificate address");
}

/** Give the business a new address (the old one stops working), e.g. if it attracts junk mail. */
export async function changeCertificateInboxAddress(clientId: number): Promise<string | null> {
  const domain = certificateInboxDomain();
  if (!domain) return null;
  await db.execute(sql`DELETE FROM certificate_inbox_addresses WHERE client_id = ${clientId}`);
  return getCertificateInboxAddress(clientId);
}

/** Reply-To for an email asking a contractor for a certificate: the business's address, when emailed certificates work. */
export async function certificateReplyToFor(clientId: number): Promise<string | null> {
  if (!certificateEmailConfigured()) return null;
  try {
    return await getCertificateInboxAddress(clientId);
  } catch (err) {
    logger.warn({ err, clientId }, "Certificate address unavailable; the email keeps its usual reply address");
    return null;
  }
}

// ----- The "Upload certificate" link -----

export function certificateUploadUrl(token: string = CERTIFICATE_UPLOAD_PLACEHOLDER): string {
  return `${getPublicAppUrl()}/certificate-upload/${token}`;
}

type Executor = { execute(query: unknown): Promise<unknown> };

/** Create an upload link for one check. Returns the raw token, which only the email carries. */
export async function issueCertificateUploadLink(
  executor: Executor, link: { clientId: number; itemId: number; contractorId: number | null }, token: string = newBearerToken(),
): Promise<string> {
  await executor.execute(sql`
    INSERT INTO certificate_upload_links (client_id, item_id, contractor_id, token_hash, expires_at)
    VALUES (${link.clientId}, ${link.itemId}, ${link.contractorId}, ${digestBearerToken(token)},
      now() + ${`${CERTIFICATE_UPLOAD_LINK_DAYS} days`}::interval)
  `);
  return token;
}

export interface CertificateUploadLink {
  id: number;
  clientId: number;
  itemId: number;
  itemTitle: string;
  siteName: string | null;
  contractorId: number | null;
  contractorName: string | null;
  contractorEmail: string | null;
  companyName: string;
  uploadsLeft: number;
}

const UPLOAD_TOKEN = /^[a-f0-9]{64}$/;

export async function findCertificateUploadLink(token: unknown): Promise<CertificateUploadLink | null> {
  if (typeof token !== "string" || !UPLOAD_TOKEN.test(token)) return null;
  const [row] = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT l.id, l.client_id, l.item_id, l.contractor_id, l.uploads, ci.title, s.name AS site_name,
      k.name AS contractor_name, k.email AS contractor_email, c.name AS client_name,
      (SELECT value FROM app_settings a WHERE a.client_id = l.client_id AND a.key = 'companyName') AS company_name
    FROM certificate_upload_links l
    JOIN compliance_items ci ON ci.id = l.item_id AND ci.client_id = l.client_id
    JOIN clients c ON c.id = l.client_id
    LEFT JOIN sites s ON s.id = ci.site_id AND s.client_id = l.client_id
    LEFT JOIN contractors k ON k.id = l.contractor_id AND k.client_id = l.client_id
    WHERE l.token_hash = ${digestBearerToken(token)} AND l.expires_at > now()
  `));
  if (!row) return null;
  return {
    id: Number(row.id),
    clientId: Number(row.client_id),
    itemId: Number(row.item_id),
    itemTitle: String(row.title),
    siteName: (row.site_name as string | null) ?? null,
    contractorId: row.contractor_id == null ? null : Number(row.contractor_id),
    contractorName: (row.contractor_name as string | null) ?? null,
    contractorEmail: (row.contractor_email as string | null)?.trim() || null,
    companyName: String(row.company_name || row.client_name || "ComplyTrack"),
    uploadsLeft: Math.max(0, MAX_UPLOADS_PER_LINK - Number(row.uploads)),
  };
}

/** The part of a contractor email that asks for the certificate: the upload button, and the address when there is one. */
export function certificateUploadBlock(opts: { uploadUrl: string; address: string | null; heading?: string }): { html: string; text: string } {
  const heading = opts.heading ?? "After the visit: send us the certificate";
  const emailLine = opts.address
    ? ` or email it to <a href="mailto:${escapeHtml(opts.address)}">${escapeHtml(opts.address)}</a>`
    : "";
  const html = `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:20px 0;text-align:center;">
        <p style="margin:0 0 12px;color:#1e293b;font-weight:600;">${escapeHtml(heading)}</p>
        <p style="margin:0 0 16px;color:#475569;font-size:14px;">Upload the certificate or report here${emailLine}. A PDF or a photo is fine.</p>
        <a href="${opts.uploadUrl}" style="display:inline-block;background:#15803d;color:white;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Upload certificate</a>
      </div>`;
  const text = `${heading}\nUpload the certificate or report here: ${opts.uploadUrl}${opts.address ? `\nOr email it to ${opts.address}` : ""}`;
  return { html, text };
}

// ----- Checking and keeping a file -----

/** The checked bytes and type to keep for a certificate file. Throws ObjectContentError for anything else. */
export async function checkCertificateFile(bytes: Buffer, fileName: string, declaredType: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (bytes.length === 0 || bytes.length > MAX_INBOX_FILE_BYTES) {
    throw new ObjectContentError(`Certificates must be 10 MB at most`);
  }
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isZip && (declaredType.toLowerCase() === DOCX_TYPE || /\.docx$/i.test(fileName))) {
    try {
      docxToText(bytes);
    } catch {
      throw new ObjectContentError("This Word file has no readable text");
    }
    return { bytes, contentType: DOCX_TYPE };
  }
  const checked = await validateUploadContent(bytes, STORED_TYPES);
  let kept = checked.normalizedBytes ?? bytes;
  let contentType: string = checked.contentType;
  if (contentType.startsWith("image/")) {
    // Shrunk as the web app shrinks phone photos: easily legible, and small
    // enough for the AI reader (5 MB at most for a photo).
    const image = sharp(kept, { limitInputPixels: 100_000_000 });
    const { width = 0, height = 0 } = await image.metadata();
    if (Math.max(width, height) > 2000 || kept.length > 3_000_000) {
      kept = await image.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 }).toBuffer();
      contentType = "image/jpeg";
    }
  }
  return { bytes: kept, contentType };
}

// ----- Reading with AI -----

export type InboxReading = Omit<CertificateReadingResult, "usage" | "model" | "inputTokens" | "outputTokens">;

export interface InboxDeps {
  /** A received email's sender, subject, text, headers and attachments (Resend's receiving API). */
  fetchEmail(providerEmailId: string): Promise<InboundEmailDetails>;
  storeFile(clientId: number, bytes: Buffer, contentType: string): Promise<string>;
  readFile(clientId: number, objectPath: string): Promise<Buffer>;
  read: typeof readCertificate;
}

export interface InboundAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  download(): Promise<Buffer>;
}

export interface InboundEmailDetails {
  from: string;
  subject: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  attachments: InboundAttachment[];
}

async function downloadAttachment(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Attachment download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_INBOX_FILE_BYTES) throw new ObjectContentError("Certificates must be 10 MB at most");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_INBOX_FILE_BYTES) throw new ObjectContentError("Certificates must be 10 MB at most");
  return bytes;
}

async function fetchEmailFromResend(providerEmailId: string): Promise<InboundEmailDetails> {
  // A sending-only key cannot read received mail; RESEND_INBOUND_API_KEY can
  // name a full-access key when the main one is sending-only.
  const resend = getResend(process.env.RESEND_INBOUND_API_KEY);
  const email = await resend.emails.receiving.get(providerEmailId);
  if (email.error || !email.data) throw new Error(`Received email unavailable: ${email.error?.message ?? "not found"}`);
  const listed = await resend.emails.receiving.attachments.list({ emailId: providerEmailId });
  if (listed.error) throw new Error(`Email attachments unavailable: ${listed.error.message}`);
  return {
    from: email.data.from,
    subject: email.data.subject ?? null,
    text: email.data.text ?? null,
    headers: email.data.headers ?? null,
    attachments: (listed.data?.data ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename ?? "attachment",
      contentType: attachment.content_type,
      size: attachment.size,
      inline: attachment.content_disposition === "inline",
      download: () => downloadAttachment(attachment.download_url),
    })),
  };
}

const storage = new ObjectStorageService();

export const defaultInboxDeps: InboxDeps = {
  fetchEmail: fetchEmailFromResend,
  storeFile: (clientId, bytes, contentType) => storage.storeTenantFile(clientId, bytes, contentType, EXTENSIONS[contentType] ?? ".bin"),
  readFile: (clientId, objectPath) => storage.readTenantFile(objectPath, clientId, MAX_INBOX_FILE_BYTES),
  read: readCertificate,
};

interface InboxItemRow {
  id: number;
  client_id: number;
  status: string;
  item_id: number | null;
  file_name: string | null;
  content_type: string | null;
  object_path: string | null;
}

/**
 * Read a waiting certificate with AI, from the business's allowance, and keep
 * the reading for the person to check. Without AI (no add-on, allowance used
 * up, a file it cannot read) the certificate still waits, to be filled in by
 * hand, with the reason kept.
 */
export async function readInboxItem(
  inboxItemId: number,
  opts: { bytes?: Buffer; userId?: number | null; deps?: InboxDeps; clientId?: number } = {},
): Promise<void> {
  const deps = opts.deps ?? defaultInboxDeps;
  // A person asking again (Read with AI, or accepting a held one) reads it
  // where it is; otherwise only a certificate waiting to be read.
  const statuses = opts.userId != null ? sql`('ready', 'held')` : sql`('reading')`;
  const [item] = rowsOf<InboxItemRow>(await db.execute(sql`
    SELECT id, client_id, status, item_id, file_name, content_type, object_path
    FROM certificate_inbox_items WHERE id = ${inboxItemId} AND status IN ${statuses}
      ${opts.clientId != null ? sql`AND client_id = ${opts.clientId}` : sql``}
  `));
  if (!item) return;
  const finish = (reading: InboxReading | null, error: string | null, matchedItemId: number | null) => db.execute(sql`
    UPDATE certificate_inbox_items
    SET status = 'ready', reading = ${reading ? JSON.stringify(reading) : null}::jsonb, reading_error = ${error},
      item_id = COALESCE(${matchedItemId}, item_id)
    WHERE id = ${item.id} AND status IN ${statuses}
  `);
  if (!item.object_path || !item.content_type) return void await finish(null, null, null);
  if (!reportReadingConfigured()) return void await finish(null, null, null);

  let aiUseId: number | null = null;
  try {
    const bytes = opts.bytes ?? await deps.readFile(item.client_id, item.object_path);
    const result = await deps.read({
      bytes, mimeType: item.content_type, fileName: item.file_name ?? "certificate",
      today: await getAccountToday(item.client_id),
      checks: await certificateCheckChoicesFor(item.client_id, null),
      itemId: item.item_id,
    }, async () => {
      aiUseId = await claimAiUse({
        clientId: item.client_id, userId: opts.userId ?? null, feature: "certificate_reading",
        estimatePence: CERTIFICATE_READING_ESTIMATE_PENCE, instead: "Fill the certificate in by hand instead.",
      });
    });
    if (aiUseId !== null) await settleAiUse(aiUseId, result.usage, true);
    const { usage: _usage, model: _model, inputTokens: _in, outputTokens: _out, ...reading } = result;
    await finish(reading, null, reading.itemId);
  } catch (err) {
    if (aiUseId !== null) await settleAiUse(aiUseId, err instanceof ReportReadingError ? err.usage ?? null : null, false);
    const known = err instanceof AiUnavailableError || err instanceof UnreadableReportError || err instanceof ReportReadingError;
    if (!known) logger.error({ err, inboxItemId }, "Reading an emailed certificate failed");
    await finish(null, known ? (err as Error).message : "ComplyTrack could not read this certificate just now. Try again later, or fill it in by hand.", null);
  }
}

// ----- Emails received -----

/** Resend's webhook signature (Svix): HMAC-SHA256 of "id.timestamp.body", within five minutes. */
export function verifyInboundWebhook(
  payload: string, headers: { id?: string; timestamp?: string; signature?: string }, secret: string, now = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest();
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** "Dave Smith <dave@sparky.co.uk>" -> { email: "dave@sparky.co.uk", name: "Dave Smith" }. */
export function parseAddress(raw: string): { email: string; name: string | null } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (match ? match[2] : raw).trim().toLowerCase();
  const name = match?.[1]?.trim() || null;
  return { email, name };
}

/** The certificate addresses (local parts) an email was sent to. "+anything" is ignored. */
export function inboxLocalParts(addresses: string[], domain: string): string[] {
  const parts = new Set<string>();
  for (const raw of addresses) {
    const { email } = parseAddress(raw);
    const at = email.lastIndexOf("@");
    if (at < 1 || email.slice(at + 1) !== domain) continue;
    parts.add(email.slice(0, at).split("+")[0]!);
  }
  return [...parts];
}

export interface InboundEmailEvent {
  type?: string;
  data?: { email_id?: string; from?: string; to?: string[]; cc?: string[]; subject?: string };
}

/** Record a received email for later processing. Returns its row when it is for a business and new. */
export async function recordInboundEmail(event: InboundEmailEvent): Promise<number | null> {
  const domain = certificateInboxDomain();
  const data = event.data;
  if (!domain || event.type !== "email.received" || !data?.email_id) return null;
  const localParts = inboxLocalParts([...(data.to ?? []), ...(data.cc ?? [])], domain);
  let clientId: number | null = null;
  if (localParts.length) {
    const [owner] = rowsOf<{ client_id: number }>(await db.execute(sql`
      SELECT client_id FROM certificate_inbox_addresses
      WHERE local_part IN (${sql.join(localParts.map((part) => sql`${part}`), sql`, `)})
      ORDER BY client_id LIMIT 1
    `));
    clientId = owner?.client_id ?? null;
  }
  const [row] = rowsOf<{ id: number }>(await db.execute(sql`
    INSERT INTO certificate_inbox_emails (provider_email_id, client_id, from_address, subject, status, processed_at)
    VALUES (${data.email_id}, ${clientId}, ${(data.from ?? "").slice(0, 500)}, ${data.subject?.slice(0, 500) ?? null},
      ${clientId ? "pending" : "ignored"}, ${clientId ? null : new Date()})
    ON CONFLICT (provider_email_id) DO NOTHING
    RETURNING id
  `));
  return row && clientId ? row.id : null;
}

/** Big free email providers: sharing one of these says nothing about who sent it. */
const SHARED_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "btinternet.com", "sky.com",
  "talktalk.net", "virginmedia.com", "protonmail.com", "proton.me", "gmx.com", "mail.com", "zoho.com",
]);

/** Whether the email's own authentication says the From address may be forged. */
export function senderLooksForged(headers: Record<string, string> | null): boolean {
  if (!headers) return false;
  const results = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "authentication-results")
    .map(([, value]) => String(value).toLowerCase()).join(" ");
  return /\bdmarc=fail\b/.test(results);
}

export interface SenderTrust {
  trusted: boolean;
  contractorId: number | null;
  /** Why an untrusted email is held, shown to the Owner. */
  heldReason: string | null;
}

/** Whether a sender is one of the business's own contractors, users or consultants. */
export async function senderTrust(clientId: number, email: string, headers: Record<string, string> | null): Promise<SenderTrust> {
  if (senderLooksForged(headers)) {
    return { trusted: false, contractorId: null, heldReason: "The sender's address could not be verified, so it may not be who it says." };
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const [contractor] = rowsOf<{ id: number; exact: boolean }>(await db.execute(sql`
    SELECT id, lower(trim(email)) = ${email} AS exact FROM contractors
    WHERE client_id = ${clientId} AND email IS NOT NULL
      AND (lower(trim(email)) = ${email}
        OR (${!SHARED_MAIL_DOMAINS.has(domain)} AND split_part(lower(trim(email)), '@', 2) = ${domain}))
    ORDER BY (lower(trim(email)) = ${email}) DESC, id LIMIT 1
  `));
  if (contractor) return { trusted: true, contractorId: contractor.id, heldReason: null };
  const [user] = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT u.id FROM users u
    WHERE u.active AND lower(u.email) = ${email}
      AND (u.client_id = ${clientId} OR (u.role = 'consultant'
        AND EXISTS (SELECT 1 FROM consultant_clients cc WHERE cc.user_id = u.id AND cc.client_id = ${clientId})))
    LIMIT 1
  `));
  if (user) return { trusted: true, contractorId: null, heldReason: null };
  return { trusted: false, contractorId: null, heldReason: "This sender is not one of your contractors or users." };
}

function isCertificateAttachment(attachment: InboundAttachment): boolean {
  const type = attachment.contentType.split(";")[0]!.trim().toLowerCase();
  const name = attachment.filename.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return true;
  if (type === DOCX_TYPE || name.endsWith(".docx")) return true;
  if (type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/.test(name)) {
    return !attachment.inline && attachment.size >= MIN_ATTACHED_IMAGE_BYTES;
  }
  return false;
}

function messageText(text: string | null): string | null {
  const trimmed = text?.replace(/\r\n/g, "\n").trim();
  return trimmed ? trimmed.slice(0, MESSAGE_TEXT_CHARS) : null;
}

interface EmailRow {
  id: number;
  provider_email_id: string;
  client_id: number;
  from_address: string;
  subject: string | null;
  attempts: number;
}

/**
 * Fetch a recorded email's attachments and keep each certificate as an inbox
 * item, then read the trusted ones with AI. Safe to run twice: each file is
 * one item (by its attachment id), and a run that fails is retried by
 * runCertificateInboxRecovery, MAX_EMAIL_ATTEMPTS times at most.
 */
export async function processInboundEmail(emailRowId: number, deps: InboxDeps = defaultInboxDeps): Promise<void> {
  const [email] = rowsOf<EmailRow>(await db.execute(sql`
    UPDATE certificate_inbox_emails SET attempts = attempts + 1
    WHERE id = ${emailRowId} AND status = 'pending' AND client_id IS NOT NULL
    RETURNING id, provider_email_id, client_id, from_address, subject, attempts
  `));
  if (!email) return;
  const toRead: Array<{ id: number; bytes: Buffer }> = [];
  try {
    const details = await deps.fetchEmail(email.provider_email_id);
    const sender = parseAddress(details.from || email.from_address);
    const trust = await senderTrust(email.client_id, sender.email, details.headers);
    const subject = (details.subject ?? email.subject)?.slice(0, 500) ?? null;
    const text = messageText(details.text);
    const notes: string[] = [];
    let kept = 0;

    const attachments = details.attachments.filter(isCertificateAttachment).slice(0, MAX_ATTACHMENTS_PER_EMAIL);
    let roomChecked = false;
    for (const attachment of attachments) {
      const externalRef = `email:${email.provider_email_id}:${attachment.id}`;
      // Kept on an earlier run that stopped part-way: not downloaded or stored again.
      const [already] = rowsOf(await db.execute(sql`
        SELECT 1 FROM certificate_inbox_items WHERE client_id = ${email.client_id} AND external_ref = ${externalRef}
      `));
      if (already) {
        kept++;
        continue;
      }
      if (attachment.size > MAX_INBOX_FILE_BYTES) {
        notes.push(`${attachment.filename} is over 10 MB, so it was not kept. Ask for a smaller PDF.`);
        continue;
      }
      if (!roomChecked) {
        try {
          await ensureUploadCapacity(email.client_id);
        } catch (err) {
          if (!(err instanceof StorageFullError)) throw err;
          notes.push("Your ComplyTrack storage is full, so the attached certificate could not be kept. Ask the sender to send it again once there is room.");
          break;
        }
        roomChecked = true;
      }
      let file: { bytes: Buffer; contentType: string };
      try {
        file = await checkCertificateFile(await attachment.download(), attachment.filename, attachment.contentType);
      } catch (err) {
        if (!(err instanceof ObjectContentError)) throw err;
        notes.push(`${attachment.filename} could not be opened as a PDF, photo or Word certificate.`);
        continue;
      }
      const objectPath = await deps.storeFile(email.client_id, file.bytes, file.contentType);
      const [item] = rowsOf<{ id: number }>(await db.execute(sql`
        INSERT INTO certificate_inbox_items
          (client_id, source, status, email_id, external_ref, sender_email, sender_name, contractor_id, subject, message_text,
           file_name, content_type, object_path, byte_size, reading_error)
        VALUES (${email.client_id}, 'email', ${trust.trusted ? "reading" : "held"}, ${email.id},
          ${externalRef}, ${sender.email}, ${sender.name}, ${trust.contractorId},
          ${subject}, ${text}, ${attachment.filename.slice(0, 255)}, ${file.contentType}, ${objectPath}, ${file.bytes.length},
          ${trust.heldReason})
        ON CONFLICT (client_id, external_ref) DO NOTHING
        RETURNING id
      `));
      kept++;
      if (item && trust.trusted) toRead.push({ id: item.id, bytes: file.bytes });
    }

    // A trusted reply with nothing usable attached is kept as a message, so it is not lost.
    if (trust.trusted && kept === 0 && (text || notes.length)) {
      await db.execute(sql`
        INSERT INTO certificate_inbox_items
          (client_id, source, status, email_id, external_ref, sender_email, sender_name, contractor_id, subject, message_text, reading_error)
        VALUES (${email.client_id}, 'email', 'message', ${email.id}, ${`email:${email.provider_email_id}:message`},
          ${sender.email}, ${sender.name}, ${trust.contractorId}, ${subject}, ${text}, ${notes.join(" ") || null})
        ON CONFLICT (client_id, external_ref) DO NOTHING
      `);
      kept++;
    }
    await db.execute(sql`
      UPDATE certificate_inbox_emails SET status = ${kept ? "done" : "ignored"}, processed_at = now(), last_error = NULL
      WHERE id = ${email.id}
    `);
  } catch (err) {
    logger.warn({ err, emailRowId }, "A received certificate email could not be processed yet");
    await db.execute(sql`
      UPDATE certificate_inbox_emails
      SET last_error = ${err instanceof Error ? err.message.slice(0, 500) : "Processing failed"},
        status = CASE WHEN attempts >= ${MAX_EMAIL_ATTEMPTS} THEN 'failed' ELSE status END
      WHERE id = ${email.id}
    `);
    return;
  }
  for (const item of toRead) await readInboxItem(item.id, { bytes: item.bytes, deps });
}

/**
 * Keep a file a contractor uploaded through their link. It is read by AI
 * straight after (not awaited), so the contractor is not kept waiting.
 */
export async function receiveUploadedCertificate(
  link: CertificateUploadLink, file: { fileName: string; mimeType: string; bytes: Buffer }, deps: InboxDeps = defaultInboxDeps,
): Promise<{ inboxItemId: number; read: Promise<void> } | null> {
  const checked = await checkCertificateFile(file.bytes, file.fileName, file.mimeType);
  const [slot] = rowsOf<{ id: number }>(await db.execute(sql`
    UPDATE certificate_upload_links SET uploads = uploads + 1
    WHERE id = ${link.id} AND uploads < ${MAX_UPLOADS_PER_LINK} AND expires_at > now()
    RETURNING id
  `));
  if (!slot) return null;
  await ensureUploadCapacity(link.clientId);
  const objectPath = await deps.storeFile(link.clientId, checked.bytes, checked.contentType);
  const [item] = rowsOf<{ id: number }>(await db.execute(sql`
    INSERT INTO certificate_inbox_items
      (client_id, source, status, upload_link_id, external_ref, sender_email, sender_name, contractor_id, item_id,
       file_name, content_type, object_path, byte_size)
    VALUES (${link.clientId}, 'upload', 'reading', ${link.id}, ${`upload:${randomUUID()}`}, ${link.contractorEmail},
      ${link.contractorName}, ${link.contractorId}, ${link.itemId}, ${file.fileName.slice(0, 255)}, ${checked.contentType},
      ${objectPath}, ${checked.bytes.length})
    RETURNING id
  `));
  const read = readInboxItem(item!.id, { bytes: checked.bytes, deps }).catch((err) => {
    logger.error({ err, inboxItemId: item!.id }, "Reading an uploaded certificate failed");
  });
  return { inboxItemId: item!.id, read };
}

/**
 * Every few minutes: emails the webhook could not finish (a restart, the
 * provider briefly unavailable) and certificates left mid-read.
 */
export async function runCertificateInboxRecovery(deps: InboxDeps = defaultInboxDeps): Promise<{ emails: number; reads: number }> {
  const emails = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT id FROM certificate_inbox_emails
    WHERE status = 'pending' AND client_id IS NOT NULL AND received_at < now() - interval '2 minutes'
    ORDER BY id LIMIT 20
  `));
  for (const { id } of emails) await processInboundEmail(id, deps);
  const stuck = rowsOf<{ id: number }>(await db.execute(sql`
    SELECT id FROM certificate_inbox_items
    WHERE status = 'reading' AND received_at < now() - interval '15 minutes'
    ORDER BY id LIMIT 10
  `));
  for (const { id } of stuck) await readInboxItem(id, { deps });
  return { emails: emails.length, reads: stuck.length };
}
