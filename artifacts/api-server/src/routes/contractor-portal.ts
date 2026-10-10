/**
 * Contractor self-service portal routes — no auth, token-protected.
 *
 * Mounted at /api/contractor-portal (no requireAuth middleware).
 * Each route validates the token against contractor_portal_tokens before acting.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ObjectStorageService, ObjectNotFoundError, ObjectOwnershipError, ObjectContentError, ObjectGenerationError, type AllowedUploadType } from "../lib/objectStorage";
import { respondObjectStorageDownloadUnavailable, respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { getNotificationEmails } from "../lib/getNotificationEmails";
import { sendEmail } from "../lib/email";
import { digestBearerToken } from "../lib/bearerTokens";
import { CONTRACTOR_DBS_TYPES, normalizeContractorDbsType } from "../lib/contractorDbsTypes";
import { recordPublicLinkAccess } from "../lib/publicLinkEvidence";

const objectStorageService = new ObjectStorageService();

const router = Router();

// ── Token validation ───────────────────────────────────────────────────────

interface TokenRow {
  client_id: number;
  contractor_id: number;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  address: string | null;
  gas_safe_number: string | null;
  public_liability_expiry: string | null;
  dbs_type: string | null;
  dbs_expiry_date: string | null;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a YYYY-MM-DD date")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  }, "Invalid date");
const DBS_TYPES = CONTRACTOR_DBS_TYPES;
const ALLOWED_CERTIFICATE_TYPES: ReadonlySet<AllowedUploadType> = new Set(["application/pdf", "image/jpeg", "image/png"]);

async function audit(row: TokenRow, eventType: string, details: Record<string, unknown> = {}) {
  await db.execute(sql`
    INSERT INTO contractor_portal_audit_log (client_id, contractor_id, actor_type, event_type, details)
    VALUES (${row.client_id}, ${row.contractor_id}, 'contractor', ${eventType}, ${JSON.stringify(details)}::jsonb)
  `);
}

async function notifyManagers(row: TokenRow, event: string) {
  try {
    const recipients = await getNotificationEmails(row.client_id, { includeMaintenanceManagers: true });
    if (recipients.emails.length) await sendEmail({
      clientId: row.client_id, to: recipients.emails,
      subject: `Contractor compliance update: ${row.name}`,
      html: `<p><strong>${escapeHtml(row.name)}</strong> updated their ${escapeHtml(event)} in the contractor self-service portal.</p>`,
    });
  } catch {
    // The compliance update and its audit record must not be lost because a
    // notification provider is temporarily unavailable.
  }
}
function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function validateToken(token: string, req: import("express").Request): Promise<TokenRow | null> {
  const result = await db.execute(sql`
    SELECT
      cpt.client_id, cpt.contractor_id,
      c.name, c.email, c.phone, c.company, c.address, c.gas_safe_number,
      c.public_liability_expiry, c.dbs_type, c.dbs_expiry_date
    FROM contractor_portal_tokens cpt
    JOIN contractors c ON c.id = cpt.contractor_id
     WHERE (
        (cpt.token_hash = ${digestBearerToken(token)} AND cpt.expires_at > now())
        OR EXISTS (
          SELECT 1 FROM contractor_portal_reminder_tokens reminder
          WHERE reminder.portal_token_id = cpt.id
            AND reminder.issuance_hash = cpt.token_hash
            AND reminder.token_hash = ${digestBearerToken(token)}
            AND reminder.expires_at > now()
        )
      )
      AND cpt.revoked_at IS NULL
      AND cpt.client_id = c.client_id
  `);
  const rows = (result.rows ?? []) as unknown as TokenRow[];
  const row = rows[0] ?? null;
  if (row) {
    await recordPublicLinkAccess(req, { kind: "contractor_portal", clientId: row.client_id, token });
  }
  return row;
}

// ── GET /:token — contractor's current details + certificates ──────────────

router.get("/:token", async (req, res) => {
  try {
    const row = await validateToken(req.params.token, req);
    if (!row) return res.status(404).json({ error: "Link expired or invalid. Please ask your client to resend a reminder." });

    const certs = await db.execute(sql`
      SELECT id, certificate_name, issuer, completed_date, expiry_date,
        portal_created AS "canDelete", (object_path IS NOT NULL) AS "hasFile"
      FROM contractor_certificates
      WHERE contractor_id = ${row.contractor_id}
        AND client_id = ${row.client_id}
      ORDER BY expiry_date ASC NULLS LAST, created_at DESC
    `);

    // NOTE: `notes` (internal manager notes) is intentionally excluded — contractors
    // must not see comments the client has written about them.
    return res.json({
      name: row.name,
      email: row.email,
      phone: row.phone,
      company: row.company,
      address: row.address,
      gasSafeNumber: row.gas_safe_number,
      insuranceExpiry: row.public_liability_expiry,
      dbsType: row.dbs_type,
      dbsExpiryDate: row.dbs_expiry_date,
      certificates: certs.rows ?? [],
    });
  } catch (err: any) {
    req.log?.error({ err }, "contractor-portal GET error");
    return res.status(500).json({ error: "Server error" });
  }
});

// ── PUT /:token — update contact / compliance details ─────────────────────

const updateSchema = z.object({
  phone:           z.string().max(30).nullish(),
  address:         z.string().max(500).nullish(),
  insuranceExpiry: DATE.nullish(),
  dbsType:         z.preprocess(normalizeContractorDbsType, z.enum(DBS_TYPES).nullish()),
  dbsExpiryDate:   DATE.nullish(),
  gasSafeNumber:   z.string().max(50).nullish(),
});

router.put("/:token", async (req, res) => {
  try {
    const row = await validateToken(req.params.token, req);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });

    const data = updateSchema.parse(req.body);

    await db.execute(sql`
      UPDATE contractors SET
        phone               = ${data.phone ?? null},
        address             = ${data.address ?? null},
        public_liability_expiry = ${data.insuranceExpiry ? new Date(data.insuranceExpiry) : null},
        dbs_type            = ${data.dbsType ?? null},
        dbs_expiry_date     = ${data.dbsType === "None" ? null : data.dbsExpiryDate ? new Date(data.dbsExpiryDate) : null},
        gas_safe_number     = ${data.gasSafeNumber ?? null},
        updated_at          = now()
      WHERE id = ${row.contractor_id} AND client_id = ${row.client_id}
    `);
    await audit(row, "details_updated", {
      fields: Object.keys(data).filter((key) => data[key as keyof typeof data] !== undefined),
    });
    await notifyManagers(row, "compliance details");
    return res.json({ success: true });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message ?? "Validation error" });
    req.log?.error({ err }, "contractor-portal PUT error");
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /:token/upload-url — presigned URL for a certificate document ─────

router.post("/:token/upload-url", async (req, res) => {
  const row = await validateToken(req.params.token, req);
  if (!row) return res.status(404).json({ error: "Link expired or invalid" });
  const parsed = z.object({
    contentType: z.string().max(100),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid upload details" });
  if (!ALLOWED_CERTIFICATE_TYPES.has(parsed.data.contentType.toLowerCase() as AllowedUploadType)) {
    return res.status(400).json({ error: "Certificate files must be PDF, JPEG, or PNG" });
  }

  try {
    const contentType = parsed.data.contentType.toLowerCase() as AllowedUploadType;
    const uploadUrl  = await objectStorageService.getObjectEntityUploadURL(row.client_id, contentType);
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadUrl);

    return res.json({ uploadUrl, objectPath });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "contractor certificate upload");
  }
});

// ── POST /:token/certificates — create a certificate record ───────────────

const certCreateSchema = z.object({
  certificateName: z.string().min(1).max(200),
  issuer:          z.string().max(200).nullish(),
  completedDate:   DATE.nullish(),
  expiryDate:      DATE.nullish(),
  objectPath:      z.string().nullish(),
}).refine((data) => !data.completedDate || !data.expiryDate || data.expiryDate >= data.completedDate, {
  message: "Expiry date cannot be before completed date",
});

router.post("/:token/certificates", async (req, res) => {
  try {
    const row = await validateToken(req.params.token, req);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });

    const data = certCreateSchema.parse(req.body);
    let finalizedObjectPath: string | null = null;
    if (data.objectPath) {
      try {
        // Validate a pinned generation and persist only its immutable final
        // copy, never the replaceable signed-upload staging key.
        const finalized = await objectStorageService.finalizeVerifiedTenantUpload(
          data.objectPath, row.client_id, ALLOWED_CERTIFICATE_TYPES,
        );
        finalizedObjectPath = finalized.objectPath;
      } catch (err) {
        // Rejected objects have never received a tenant ACL. Remove them
        // best-effort so a failed submission cannot accumulate accessible data.
        await objectStorageService.discardTenantUpload(data.objectPath, row.client_id).catch(() => {});
        const error = err instanceof ObjectNotFoundError ? "Uploaded object not found"
          : err instanceof ObjectGenerationError ? err.message
          : err instanceof ObjectOwnershipError ? err.message : "Could not secure uploaded certificate";
        return res.status(err instanceof ObjectNotFoundError ? 404
          : err instanceof ObjectContentError ? 400
          : err instanceof ObjectGenerationError ? 409 : 403).json({ error });
      }
    }

    const result = await db.execute(sql`
      INSERT INTO contractor_certificates
        (client_id, contractor_id, certificate_name, issuer,
         completed_date, expiry_date, notes, object_path, portal_created, created_at, updated_at)
      VALUES
        (${row.client_id}, ${row.contractor_id}, ${data.certificateName},
         ${data.issuer ?? null},
         ${data.completedDate ? new Date(data.completedDate) : null},
         ${data.expiryDate ? new Date(data.expiryDate) : null},
          ${null},
          ${finalizedObjectPath},
          true,
         now(), now())
      RETURNING id, certificate_name, issuer, completed_date, expiry_date,
        portal_created AS "canDelete", (object_path IS NOT NULL) AS "hasFile"
    `);

    await db.execute(sql`UPDATE contractors SET updated_at = now()
      WHERE id = ${row.contractor_id} AND client_id = ${row.client_id}`);
    await audit(row, "certificate_created", { certificateName: data.certificateName, hasUpload: !!data.objectPath });
    await notifyManagers(row, "certificate records");
    return res.status(201).json((result.rows ?? [])[0] ?? {});
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message ?? "Validation error" });
    req.log?.error({ err }, "contractor-portal cert create error");
    return res.status(500).json({ error: "Server error" });
  }
});

// ── GET /:token/certificates/:certId/download ──────────────────────────────
// Object paths are never accepted from the requester: resolve the path through
// the already tenant- and contractor-scoped certificate row first.
router.get("/:token/certificates/:certId/download", async (req, res) => {
  let signing: { clientId: number; contractorId: number; certId: number } | null = null;
  try {
    const row = await validateToken(req.params.token, req);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });
    const certId = Number(req.params.certId);
    if (!Number.isInteger(certId) || certId <= 0) return res.status(400).json({ error: "Invalid certificate ID" });
    const certs = await db.execute(sql`
      SELECT object_path FROM contractor_certificates
      WHERE id = ${certId} AND contractor_id = ${row.contractor_id}
        AND client_id = ${row.client_id}
    `);
    const objectPath = (certs.rows?.[0] as { object_path?: string } | undefined)?.object_path;
    if (!objectPath) return res.status(404).json({ error: "Certificate file not found" });
    signing = { clientId: row.client_id, contractorId: row.contractor_id, certId };
    const downloadUrl = await objectStorageService.getSignedDownloadURL(
      objectPath, 900, ALLOWED_CERTIFICATE_TYPES, row.client_id,
    );
    return res.json({ downloadUrl });
  } catch (err: any) {
    if (err instanceof ObjectNotFoundError) return res.status(404).json({ error: "Certificate file not found" });
    if (err instanceof ObjectContentError) return res.status(400).json({ error: err.message });
    if (err instanceof ObjectOwnershipError) return res.status(403).json({ error: err.message });
    if (signing) {
      return respondObjectStorageDownloadUnavailable(req, res, err, "Contractor portal certificate download", signing);
    }
    req.log?.error({ err }, "contractor-portal certificate download error");
    return res.status(500).json({ error: "Could not prepare certificate download" });
  }
});

// ── DELETE /:token/certificates/:certId ───────────────────────────────────

router.delete("/:token/certificates/:certId", async (req, res) => {
  try {
    const row = await validateToken(req.params.token, req);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });

    const certId = Number(req.params.certId);
    if (!Number.isSafeInteger(certId) || certId <= 0) return res.status(400).json({ error: "Invalid certificate ID" });

    const deleted = await db.execute(sql`
      DELETE FROM contractor_certificates
      WHERE id = ${certId}
        AND contractor_id = ${row.contractor_id}
        AND client_id = ${row.client_id}
        AND portal_created = true
    `);
    if ((deleted.rowCount ?? 0) === 0) return res.status(404).json({ error: "Certificate not found or not portal-created" });
    await db.execute(sql`UPDATE contractors SET updated_at = now()
      WHERE id = ${row.contractor_id} AND client_id = ${row.client_id}`);
    await audit(row, "certificate_deleted", { certificateId: certId });
    await notifyManagers(row, "certificate records");
    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ err }, "contractor-portal cert delete error");
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
