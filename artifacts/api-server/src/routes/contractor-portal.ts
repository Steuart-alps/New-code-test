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
import { ObjectStorageService } from "../lib/objectStorage";

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
  notes: string | null;
  gas_safe_number: string | null;
  public_liability_expiry: string | null;
  dbs_type: string | null;
  dbs_expiry_date: string | null;
}

async function validateToken(token: string): Promise<TokenRow | null> {
  const result = await db.execute(sql`
    SELECT
      cpt.client_id, cpt.contractor_id,
      c.name, c.email, c.phone, c.company, c.address, c.notes, c.gas_safe_number,
      c.public_liability_expiry, c.dbs_type, c.dbs_expiry_date
    FROM contractor_portal_tokens cpt
    JOIN contractors c ON c.id = cpt.contractor_id
    WHERE cpt.token = ${token}
      AND cpt.expires_at > now()
  `);
  const rows = (result.rows ?? []) as unknown as TokenRow[];
  return rows[0] ?? null;
}

// ── GET /:token — contractor's current details + certificates ──────────────

router.get("/:token", async (req, res) => {
  try {
    const row = await validateToken(req.params.token);
    if (!row) return res.status(404).json({ error: "Link expired or invalid. Please ask your client to resend a reminder." });

    const certs = await db.execute(sql`
      SELECT id, certificate_name, issuer, completed_date, expiry_date, notes, object_path
      FROM contractor_certificates
      WHERE contractor_id = ${row.contractor_id}
        AND client_id = ${row.client_id}
      ORDER BY expiry_date ASC NULLS LAST, created_at DESC
    `);

    return res.json({
      name: row.name,
      email: row.email,
      phone: row.phone,
      company: row.company,
      address: row.address,
      notes: row.notes,
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
  phone:          z.string().max(30).nullish(),
  address:        z.string().max(500).nullish(),
  insuranceExpiry: z.string().nullish(),
  dbsType:        z.string().max(100).nullish(),
  dbsExpiryDate:  z.string().nullish(),
});

router.put("/:token", async (req, res) => {
  try {
    const row = await validateToken(req.params.token);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });

    const data = updateSchema.parse(req.body);

    await db.execute(sql`
      UPDATE contractors SET
        phone               = ${data.phone ?? null},
        address             = ${data.address ?? null},
        public_liability_expiry = ${data.insuranceExpiry ? new Date(data.insuranceExpiry) : null},
        dbs_type            = ${data.dbsType ?? null},
        dbs_expiry_date     = ${data.dbsExpiryDate ? new Date(data.dbsExpiryDate) : null},
        updated_at          = now()
      WHERE id = ${row.contractor_id}
    `);

    return res.json({ success: true });
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message ?? "Validation error" });
    req.log?.error({ err }, "contractor-portal PUT error");
    return res.status(500).json({ error: "Server error" });
  }
});

// ── POST /:token/upload-url — presigned URL for a certificate document ─────

router.post("/:token/upload-url", async (req, res) => {
  try {
    const row = await validateToken(req.params.token);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });

    const uploadUrl  = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadUrl);

    await objectStorageService.trySetObjectEntityAclPolicy(uploadUrl, {
      owner: String(row.client_id),
      visibility: "private",
    });

    return res.json({ uploadUrl, objectPath });
  } catch (err: any) {
    req.log?.error({ err }, "contractor-portal upload-url error");
    return res.status(500).json({ error: "Could not generate upload URL" });
  }
});

// ── POST /:token/certificates — create a certificate record ───────────────

const certCreateSchema = z.object({
  certificateName: z.string().min(1).max(200),
  issuer:          z.string().max(200).nullish(),
  completedDate:   z.string().nullish(),
  expiryDate:      z.string().nullish(),
  notes:           z.string().max(1000).nullish(),
  objectPath:      z.string().nullish(),
});

router.post("/:token/certificates", async (req, res) => {
  try {
    const row = await validateToken(req.params.token);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });

    const data = certCreateSchema.parse(req.body);

    const result = await db.execute(sql`
      INSERT INTO contractor_certificates
        (client_id, contractor_id, certificate_name, issuer,
         completed_date, expiry_date, notes, object_path, created_at, updated_at)
      VALUES
        (${row.client_id}, ${row.contractor_id}, ${data.certificateName},
         ${data.issuer ?? null},
         ${data.completedDate ? new Date(data.completedDate) : null},
         ${data.expiryDate ? new Date(data.expiryDate) : null},
         ${data.notes ?? null},
         ${data.objectPath ?? null},
         now(), now())
      RETURNING *
    `);

    return res.status(201).json((result.rows ?? [])[0] ?? {});
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors[0]?.message ?? "Validation error" });
    req.log?.error({ err }, "contractor-portal cert create error");
    return res.status(500).json({ error: "Server error" });
  }
});

// ── DELETE /:token/certificates/:certId ───────────────────────────────────

router.delete("/:token/certificates/:certId", async (req, res) => {
  try {
    const row = await validateToken(req.params.token);
    if (!row) return res.status(404).json({ error: "Link expired or invalid" });

    const certId = parseInt(req.params.certId, 10);
    if (isNaN(certId)) return res.status(400).json({ error: "Invalid certificate ID" });

    await db.execute(sql`
      DELETE FROM contractor_certificates
      WHERE id = ${certId}
        AND contractor_id = ${row.contractor_id}
        AND client_id = ${row.client_id}
    `);

    return res.json({ success: true });
  } catch (err: any) {
    req.log?.error({ err }, "contractor-portal cert delete error");
    return res.status(500).json({ error: "Server error" });
  }
});

export default router;
