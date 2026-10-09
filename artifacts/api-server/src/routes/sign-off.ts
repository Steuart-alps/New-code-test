import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { recordPublicLinkAccess } from "../lib/publicLinkEvidence";

const router = Router();
const storage = new ObjectStorageService();

// ── Helper: resolve client from sign-off token ────────────────────────────────
async function resolveClient(
  token: string,
  req: import("express").Request,
): Promise<{ id: number; name: string } | null> {
  if (!token || token.length < 8) return null;
  const result = await db.execute(sql`
    SELECT id, name FROM clients
    WHERE sign_off_token = ${token}
      AND sign_off_token_expires_at > now()
      AND sign_off_token_revoked_at IS NULL
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as any;
  if (row) {
    await recordPublicLinkAccess(req, { kind: "sign_off", clientId: row.id, token });
  }
  return row ? { id: row.id, name: row.name } : null;
}

type PublicDocumentType = "doc" | "ra" | "sop" | "handbook";

async function resolveStaff(clientId: number, staffRosterId: number) {
  const result = await db.execute(sql`
    SELECT id, name, department
    FROM staff_roster
    WHERE id = ${staffRosterId} AND client_id = ${clientId} AND active = true
    LIMIT 1
  `);
  return ((result.rows ?? [])[0] as any) ?? null;
}

async function resolvePublicDocument(
  clientId: number,
  staffRosterId: number,
  documentType: PublicDocumentType,
  documentId: number,
) {
  const result = await db.execute(sql`
    WITH selected_staff AS (
      SELECT department
      FROM staff_roster
      WHERE id = ${staffRosterId} AND client_id = ${clientId} AND active = true
    ),
    available_documents AS (
      SELECT d.id, 'doc'::text AS document_type, d.title, d.category,
             d.site_id, d.annual_acknowledgement, d.object_path, d.file_name
      FROM doc_track_documents d, selected_staff staff
      WHERE d.client_id = ${clientId}
        AND d.requires_acknowledgement = true
        AND (d.department IS NULL OR d.department = staff.department)

      UNION ALL

      SELECT d.id, 'ra'::text, d.title, 'risk_assessment'::text,
             d.site_id, false, d.object_path, d.file_name
      FROM safe_risk_assessments d
      LEFT JOIN departments dep ON dep.id = d.department_id AND dep.client_id = d.client_id
      LEFT JOIN sites site ON site.id = d.site_id AND site.client_id = d.client_id
      LEFT JOIN departments site_dep ON site_dep.id = site.department_id AND site_dep.client_id = d.client_id
      CROSS JOIN selected_staff staff
      WHERE d.client_id = ${clientId}
        AND d.requires_acknowledgement = true
        AND (COALESCE(dep.name, site_dep.name) IS NULL OR COALESCE(dep.name, site_dep.name) = staff.department)

      UNION ALL

      SELECT d.id, 'sop'::text, d.title, 'sop'::text,
             d.site_id, false, d.object_path, d.file_name
      FROM safe_sops d
      LEFT JOIN departments dep ON dep.id = d.department_id AND dep.client_id = d.client_id
      LEFT JOIN sites site ON site.id = d.site_id AND site.client_id = d.client_id
      LEFT JOIN departments site_dep ON site_dep.id = site.department_id AND site_dep.client_id = d.client_id
      CROSS JOIN selected_staff staff
      WHERE d.client_id = ${clientId}
        AND d.requires_acknowledgement = true
        AND (COALESCE(dep.name, site_dep.name) IS NULL OR COALESCE(dep.name, site_dep.name) = staff.department)

      UNION ALL

      SELECT d.id, 'handbook'::text, d.title, 'handbook'::text,
             d.site_id, false, d.object_path, d.file_name
      FROM safe_handbook d
      LEFT JOIN sites site ON site.id = d.site_id AND site.client_id = d.client_id
      LEFT JOIN departments site_dep ON site_dep.id = site.department_id AND site_dep.client_id = d.client_id
      CROSS JOIN selected_staff staff
      WHERE d.client_id = ${clientId}
        AND d.requires_acknowledgement = true
        AND (site_dep.name IS NULL OR site_dep.name = staff.department)
    )
    SELECT * FROM available_documents
    WHERE document_type = ${documentType} AND id = ${documentId}
    LIMIT 1
  `);
  return ((result.rows ?? [])[0] as any) ?? null;
}

// GET /api/sign-off/:token/info
router.get("/:token/info", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token, req);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });
    res.json({ clientName: client.name });
  } catch (err: any) {
    req.log?.error({ err }, "Public sign-off info lookup failed");
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/sign-off/:token/departments
router.get("/:token/departments", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token, req);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const result = await db.execute(sql`
      SELECT DISTINCT department FROM staff_roster
      WHERE client_id = ${client.id} AND active = true AND department IS NOT NULL
      ORDER BY department ASC
    `);
    res.json((result.rows ?? []).map((r: any) => r.department as string));
  } catch (err: any) {
    req.log?.error({ err }, "Public sign-off department lookup failed");
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/sign-off/:token/staff?department=X
router.get("/:token/staff", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token, req);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const { department } = req.query as { department?: string };

    const result = department
      ? await db.execute(sql`
          SELECT id, name, job_title, department FROM staff_roster
          WHERE client_id = ${client.id} AND active = true AND department = ${department}
          ORDER BY name ASC
        `)
      : await db.execute(sql`
          SELECT id, name, job_title, department FROM staff_roster
          WHERE client_id = ${client.id} AND active = true
          ORDER BY name ASC
        `);

    res.json(result.rows ?? []);
  } catch (err: any) {
    req.log?.error({ err }, "Public sign-off staff lookup failed");
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/sign-off/:token/documents?department=X&staffId=Y
router.get("/:token/documents", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token, req);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const { staffId } = req.query as { staffId?: string };
    const staffIdNum = staffId ? parseInt(staffId) : null;
    if (!staffIdNum || isNaN(staffIdNum)) return res.status(400).json({ error: "A valid staff member is required" });
    const staff = await resolveStaff(client.id, staffIdNum);
    if (!staff) return res.status(404).json({ error: "Staff member not found" });

    // Department is derived from the tenant-scoped staff record, never trusted
    // from the public request. document_type disambiguates IDs across tables.
    const result = await db.execute(sql`
      WITH required_documents AS (
        SELECT d.id, 'doc'::text AS document_type, d.title,
               COALESCE(d.category, 'other') AS category, d.description,
               d.file_name, d.mime_type, (d.object_path IS NOT NULL) AS has_file,
               d.department, d.created_at
        FROM doc_track_documents d
        WHERE d.client_id = ${client.id}
          AND d.requires_acknowledgement = true
          AND (d.department = ${staff.department} OR d.department IS NULL)

        UNION ALL

        SELECT d.id, 'ra'::text, d.title, 'risk_assessment'::text, d.description,
               d.file_name, d.mime_type, (d.object_path IS NOT NULL),
               COALESCE(dep.name, site_dep.name), d.created_at
        FROM safe_risk_assessments d
        LEFT JOIN departments dep ON dep.id = d.department_id AND dep.client_id = d.client_id
        LEFT JOIN sites site ON site.id = d.site_id AND site.client_id = d.client_id
        LEFT JOIN departments site_dep ON site_dep.id = site.department_id AND site_dep.client_id = d.client_id
        WHERE d.client_id = ${client.id}
          AND d.requires_acknowledgement = true
          AND (COALESCE(dep.name, site_dep.name) IS NULL OR COALESCE(dep.name, site_dep.name) = ${staff.department})

        UNION ALL

        SELECT d.id, 'sop'::text, d.title, 'sop'::text, d.content,
               d.file_name, d.mime_type, (d.object_path IS NOT NULL),
               COALESCE(dep.name, site_dep.name), d.created_at
        FROM safe_sops d
        LEFT JOIN departments dep ON dep.id = d.department_id AND dep.client_id = d.client_id
        LEFT JOIN sites site ON site.id = d.site_id AND site.client_id = d.client_id
        LEFT JOIN departments site_dep ON site_dep.id = site.department_id AND site_dep.client_id = d.client_id
        WHERE d.client_id = ${client.id}
          AND d.requires_acknowledgement = true
          AND (COALESCE(dep.name, site_dep.name) IS NULL OR COALESCE(dep.name, site_dep.name) = ${staff.department})

        UNION ALL

        SELECT d.id, 'handbook'::text, d.title, 'handbook'::text,
               d.content, d.file_name, d.mime_type, (d.object_path IS NOT NULL),
               site_dep.name, d.created_at
        FROM safe_handbook d
        LEFT JOIN sites site ON site.id = d.site_id AND site.client_id = d.client_id
        LEFT JOIN departments site_dep ON site_dep.id = site.department_id AND site_dep.client_id = d.client_id
        WHERE d.client_id = ${client.id}
          AND d.requires_acknowledgement = true
          AND (site_dep.name IS NULL OR site_dep.name = ${staff.department})
      )
      SELECT d.*,
             (a.acknowledged_at IS NOT NULL) AS signed,
             a.acknowledged_at, a.signature AS ack_signature
      FROM required_documents d
      LEFT JOIN LATERAL (
        SELECT da.acknowledged_at, da.signature
        FROM doc_acknowledgements da
        WHERE d.document_type = 'doc'
          AND da.document_id = d.id
          AND da.client_id = ${client.id}
          AND da.staff_roster_id = ${staffIdNum}
        UNION ALL
        SELECT sa.acknowledged_at, sa.signature
        FROM safe_track_acknowledgements sa
        WHERE d.document_type <> 'doc'
          AND sa.document_id = d.id
          AND sa.document_type = d.document_type
          AND sa.client_id = ${client.id}
          AND sa.staff_roster_id = ${staffIdNum}
        LIMIT 1
      ) a ON true
      ORDER BY d.created_at DESC
    `);

    res.json(result.rows ?? []);
  } catch (err: any) {
    req.log?.error({ err }, "Public sign-off document lookup failed");
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/sign-off/:token/documents/:docId/download
router.get("/:token/documents/:docId/download", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token, req);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const docId = parseInt(req.params.docId);
    if (isNaN(docId)) return res.status(400).json({ error: "Invalid id" });

    const parsedType = z.enum(["doc", "ra", "sop", "handbook"]).safeParse(req.query.documentType ?? "doc");
    if (!parsedType.success) return res.status(400).json({ error: "Invalid document type" });
    const staffId = Number(req.query.staffId);
    if (!Number.isInteger(staffId)) return res.status(400).json({ error: "A valid staff member is required" });
    const row = await resolvePublicDocument(client.id, staffId, parsedType.data, docId);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!row.object_path) return res.status(404).json({ error: "No file attached" });

    const downloadUrl = await storage.getSignedDownloadURL(row.object_path, 900, undefined, client.id);
    res.json({ downloadUrl, fileName: row.file_name });
  } catch (err: any) {
    req.log?.error({ err }, "Public sign-off download URL generation failed");
    res.status(500).json({ error: "Could not generate download URL" });
  }
});

// POST /api/sign-off/:token/acknowledge
const ackSchema = z.object({
  documentType: z.enum(["doc", "ra", "sop", "handbook"]).default("doc"),
  documentId: z.number().int(),
  staffRosterId: z.number().int(),
  signature: z.string().max(500_000).nullable().optional(), // base64 PNG from canvas
  typedName: z.string().max(300).nullable().optional(),
}).refine(data => Boolean(data.signature || data.typedName?.trim()), {
  message: "A signature is required",
});

router.post("/:token/acknowledge", async (req, res) => {
  try {
    const client = await resolveClient(req.params.token, req);
    if (!client) return res.status(404).json({ error: "Invalid sign-off link" });

    const parsed = ackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

    const { documentType, documentId, staffRosterId, signature, typedName } = parsed.data;

    const staff = await resolveStaff(client.id, staffRosterId);
    if (!staff) return res.status(404).json({ error: "Staff member not found" });
    const staffName = String(staff.name);

    if (documentType !== "doc") {
      const safeDocument = await resolvePublicDocument(client.id, staffRosterId, documentType, documentId);
      if (!safeDocument) return res.status(404).json({ error: "Document not found" });

      const signatureValue = signature ?? typedName?.trim() ?? null;
      const ackResult = await db.execute(sql`
        INSERT INTO safe_track_acknowledgements
          (client_id, document_type, document_id, staff_roster_id, staff_name, signature, acknowledged_by)
        VALUES
          (${client.id}, ${documentType}, ${documentId}, ${staffRosterId}, ${staffName}, ${signatureValue}, NULL)
        ON CONFLICT (document_type, document_id, staff_roster_id)
          WHERE staff_roster_id IS NOT NULL
        DO NOTHING
        RETURNING id, acknowledged_at
      `);
      const created = (ackResult.rows ?? [])[0];
      return res.status(created ? 201 : 200).json(created ?? { alreadySigned: true });
    }

    const doc = await resolvePublicDocument(client.id, staffRosterId, "doc", documentId);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    // Current acknowledgements are idempotent. Expired annual acknowledgements
    // can be signed again and will replace the stale TrainTrack link.
    const existing = await db.execute(sql`
      SELECT a.id,
             CASE
               WHEN a.train_track_record_id IS NOT NULL AND tr.id IS NULL THEN false
               WHEN tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE THEN false
               ELSE true
             END AS is_current
      FROM doc_acknowledgements a
      LEFT JOIN train_track_records tr
        ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
      WHERE a.document_id = ${documentId}
        AND a.client_id = ${client.id}
        AND a.staff_roster_id = ${staffRosterId}
      LIMIT 1
    `);
    const existingAck = (existing.rows ?? [])[0] as any;
    if (existingAck?.is_current) {
      return res.status(200).json({ alreadySigned: true });
    }

    const today = new Date().toISOString().split("T")[0];
    const signatureValue = signature ?? typedName ?? null;

    // Create TrainTrack signoff record
    const trainResult = await db.execute(sql`
      INSERT INTO train_track_records
        (client_id, site_id, record_type, staff_name, document_title,
         document_type, completed_date, expiry_date, notes, signature)
      VALUES
        (${client.id}, ${doc.site_id ?? null}, 'signoff', ${staffName},
         ${doc.title}, ${doc.category}, ${today}::date,
          ${doc.annual_acknowledgement ? sql`(${today}::date + interval '1 year')::date` : sql`NULL::date`},
         ${"Document acknowledgement (staff self-sign)"},
         ${signatureValue})
      RETURNING id
    `);
    const trainId = ((trainResult.rows ?? [])[0] as any)?.id ?? null;

    const ackResult = existingAck
      ? await db.execute(sql`
          UPDATE doc_acknowledgements
          SET staff_name = ${staffName},
              signature = ${signatureValue},
              train_track_record_id = ${trainId},
              acknowledged_at = now()
          WHERE id = ${existingAck.id} AND client_id = ${client.id}
          RETURNING id, acknowledged_at
        `)
      : await db.execute(sql`
          INSERT INTO doc_acknowledgements
            (document_id, client_id, staff_roster_id, staff_name, signature, train_track_record_id)
          VALUES
            (${documentId}, ${client.id}, ${staffRosterId}, ${staffName},
             ${signatureValue}, ${trainId})
          RETURNING id, acknowledged_at
        `);

    res.status(201).json((ackResult.rows ?? [])[0]);
  } catch (err: any) {
    req.log?.error({ err }, "Public sign-off acknowledgement failed");
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
