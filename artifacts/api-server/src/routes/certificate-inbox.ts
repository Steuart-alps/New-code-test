/**
 * "Certificates to confirm": certificates emailed to the business's
 * certificate address or uploaded by a contractor through their link
 * (lib/certificateInbox.ts). Owners and ALPS consultants check each one on the
 * same screen as an uploaded certificate and save it to a check, or dismiss
 * it. The public upload link's own routes are certificateUploadPublicRouter.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireClientAdmin, denyViewers, getClientId } from "../middleware/requireAuth";
import { hasTenantAttachmentReference } from "../lib/attachmentReferences";
import {
  certificateEmailConfigured, changeCertificateInboxAddress, findCertificateUploadLink, getCertificateInboxAddress,
  MAX_INBOX_FILE_BYTES, readInboxItem, receiveUploadedCertificate,
} from "../lib/certificateInbox";
import { ObjectContentError, ObjectStorageService } from "../lib/objectStorage";
import { StorageFullError } from "../lib/storageFull";
import { saveItemCertificate } from "./certificates";

const router: IRouter = Router();
const storage = new ObjectStorageService();

/** Waiting certificates: being read, ready to check, held (unknown sender), or a message. */
const OPEN_STATUSES = sql`('reading', 'ready', 'held', 'message')`;

function itemView(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    source: row.source as "email" | "upload",
    status: row.status as "reading" | "ready" | "held" | "message",
    senderEmail: (row.sender_email as string | null) ?? null,
    senderName: (row.sender_name as string | null) ?? null,
    contractorId: row.contractor_id == null ? null : Number(row.contractor_id),
    contractorName: (row.contractor_name as string | null) ?? null,
    itemId: row.item_id == null ? null : Number(row.item_id),
    itemTitle: (row.item_title as string | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    messageText: (row.message_text as string | null) ?? null,
    fileName: (row.file_name as string | null) ?? null,
    contentType: (row.content_type as string | null) ?? null,
    fileUrl: (row.object_path as string | null) ?? null,
    byteSize: row.byte_size == null ? null : Number(row.byte_size),
    reading: row.reading ?? null,
    note: (row.reading_error as string | null) ?? null,
    receivedAt: new Date(row.received_at as string).toISOString(),
  };
}

async function openItems(clientId: number, id?: number) {
  const result = await db.execute(sql`
    SELECT i.*, k.name AS contractor_name, ci.title AS item_title
    FROM certificate_inbox_items i
    LEFT JOIN contractors k ON k.id = i.contractor_id AND k.client_id = i.client_id
    LEFT JOIN compliance_items ci ON ci.id = i.item_id AND ci.client_id = i.client_id
    WHERE i.client_id = ${clientId} AND i.status IN ${OPEN_STATUSES}
      ${id !== undefined ? sql`AND i.id = ${id}` : sql``}
    ORDER BY i.received_at DESC, i.id DESC
    LIMIT 200
  `);
  return ((result.rows ?? []) as Record<string, unknown>[]).map(itemView);
}

const inboxId = (raw: unknown) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

router.get("/certificate-inbox", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });
  const address = certificateEmailConfigured() ? await getCertificateInboxAddress(clientId) : null;
  res.json({ address, items: await openItems(clientId) });
});

router.post("/certificate-inbox/address", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return void res.status(400).json({ error: "No client context" });
  if (!certificateEmailConfigured()) {
    return void res.status(503).json({ error: "Emailed certificates are not switched on yet." });
  }
  const address = await changeCertificateInboxAddress(clientId);
  res.json({ address, items: await openItems(clientId) });
});

// Read (again) with AI: a certificate the AI could not read before, or a held
// one the Owner has decided to accept. The person waits, as when uploading.
router.post("/certificate-inbox/:id/read", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  const id = inboxId(req.params.id);
  if (!clientId || !id) return void res.status(400).json({ error: "Invalid request" });
  const [before] = await openItems(clientId, id);
  if (!before || (before.status !== "ready" && before.status !== "held") || !before.fileUrl) {
    return void res.status(404).json({ error: "Certificate not found" });
  }
  await readInboxItem(id, { userId: req.currentUser?.id ?? null, clientId });
  const [after] = await openItems(clientId, id);
  if (!after) return void res.status(404).json({ error: "Certificate not found" });
  res.json(after);
});

const fileBody = z.object({ itemId: z.number().int().positive(), certificate: z.unknown() }).strict();

// Save it to a check: the same certificate, defects and remedial job as an
// uploaded certificate (routes/certificates.ts), with the file already kept.
router.post("/certificate-inbox/:id/file", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  const id = inboxId(req.params.id);
  const parsed = fileBody.safeParse(req.body);
  if (!clientId || !id || !parsed.success) return void res.status(400).json({ error: "Invalid request" });
  // Claimed first, so two people saving the same certificate file it once.
  const claimed = ((await db.execute(sql`
    UPDATE certificate_inbox_items SET handled_by = ${req.currentUser?.id ?? null}, handled_at = now()
    WHERE id = ${id} AND client_id = ${clientId} AND status IN ('ready', 'held') AND handled_at IS NULL
    RETURNING id, object_path
  `)).rows ?? []) as Array<{ id: number; object_path: string | null }>;
  const row = claimed[0];
  if (!row) return void res.status(409).json({ error: "This certificate has already been dealt with." });
  const release = async () => {
    await db.execute(sql`UPDATE certificate_inbox_items SET handled_by = NULL, handled_at = NULL WHERE id = ${id}`);
  };
  try {
    const view = await saveItemCertificate(req, res, parsed.data.itemId, parsed.data.certificate, {
      clientId, itemId: id, objectPath: row.object_path, release,
    });
    if (!view) return;
    await db.execute(sql`
      UPDATE certificate_inbox_items SET status = 'filed', certificate_id = ${view.id}, item_id = ${parsed.data.itemId}
      WHERE id = ${id}
    `);
    res.status(201).json(view);
  } catch (err) {
    await release();
    throw err;
  }
});

// Not a certificate (junk, a duplicate, a message already answered): removed,
// with its file unless something else uses it.
router.post("/certificate-inbox/:id/dismiss", requireAuth, denyViewers, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  const id = inboxId(req.params.id);
  if (!clientId || !id) return void res.status(400).json({ error: "Invalid request" });
  const outcome = await db.transaction(async (tx) => {
    const [row] = ((await tx.execute(sql`
      SELECT object_path FROM certificate_inbox_items
      WHERE id = ${id} AND client_id = ${clientId} AND status IN ${OPEN_STATUSES} AND handled_at IS NULL
      FOR UPDATE
    `)).rows ?? []) as Array<{ object_path: string | null }>;
    if (!row) return null;
    await tx.execute(sql`
      UPDATE certificate_inbox_items
      SET status = 'dismissed', handled_by = ${req.currentUser?.id ?? null}, handled_at = now(), object_path = NULL, reading = NULL
      WHERE id = ${id}
    `);
    const path = row.object_path;
    return { path, delete: !!path && !await hasTenantAttachmentReference(tx, clientId, path) };
  });
  if (!outcome) return void res.status(404).json({ error: "Certificate not found" });
  if (outcome.delete && outcome.path) {
    await storage.deleteTenantObject(outcome.path, clientId)
      .catch((err) => req.log.warn({ err, inboxItemId: id }, "Could not delete a dismissed certificate's file"));
  }
  res.json({ ok: true });
});

export default router;

// ----- The contractor's "Upload certificate" link (no sign-in; the token is the credential) -----

export const certificateUploadPublicRouter: IRouter = Router();

const GONE = "This upload link has expired. Reply to the email with the certificate attached instead.";

certificateUploadPublicRouter.get("/:token", async (req, res) => {
  const link = await findCertificateUploadLink(req.params.token);
  if (!link) return void res.status(404).json({ error: GONE });
  res.json({
    companyName: link.companyName,
    itemTitle: link.itemTitle,
    siteName: link.siteName,
    contractorName: link.contractorName,
    uploadsLeft: link.uploadsLeft,
    maxBytes: MAX_INBOX_FILE_BYTES,
  });
});

const uploadBody = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(200),
  data: z.string().min(1).max(Math.ceil(MAX_INBOX_FILE_BYTES / 3) * 4 + 4),
}).strict();

certificateUploadPublicRouter.post("/:token", async (req, res) => {
  const link = await findCertificateUploadLink(req.params.token);
  if (!link) return void res.status(404).json({ error: GONE });
  const parsed = uploadBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Choose a PDF or a photo of the certificate (10 MB at most)." });
  try {
    const received = await receiveUploadedCertificate(link, {
      fileName: parsed.data.fileName, mimeType: parsed.data.mimeType, bytes: Buffer.from(parsed.data.data, "base64"),
    });
    if (!received) return void res.status(429).json({ error: "This link has taken as many files as it can. Reply to the email with the certificate attached instead." });
    res.status(201).json({ ok: true, message: `Thank you. ${link.companyName} has the certificate for ${link.itemTitle}.` });
  } catch (err) {
    if (err instanceof ObjectContentError) {
      return void res.status(400).json({ error: "That file could not be opened as a PDF, a photo or a Word document. Save the certificate as a PDF and try again." });
    }
    if (err instanceof StorageFullError) {
      return void res.status(507).json({ error: `${link.companyName} cannot take files just now. Reply to the email with the certificate attached instead.` });
    }
    req.log.error({ err }, "Certificate upload failed");
    res.status(503).json({ error: "The certificate could not be saved just now. Please try again in a few minutes." });
  }
});
