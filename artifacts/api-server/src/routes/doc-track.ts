import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireClientAdmin, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import { respondObjectStorageUnavailable } from "../lib/objectStorageUnavailable";
import { getObjectAclPolicy } from "../lib/objectAcl";
import { createAcknowledgementRegisterPdf } from "../lib/acknowledgementRegisterPdf";
import { newBearerToken } from "../lib/bearerTokens";

const router = Router();
const storage = new ObjectStorageService();

async function canAccessSite(clientId: number, siteId: number | null | undefined, departmentId: number | null) {
  if (siteId == null) return true;
  const result = await db.execute(sql`SELECT department_id FROM sites WHERE id = ${siteId} AND client_id = ${clientId} LIMIT 1`);
  const site = (result.rows ?? [])[0] as any;
  return !!site && (departmentId === null || site.department_id === null || site.department_id === departmentId);
}
async function canAccessDocument(clientId: number, documentId: number, departmentId: number | null) {
  const result = await db.execute(sql`
    SELECT d.id, d.site_id, d.department, s.department_id,
      (SELECT name FROM departments WHERE id = ${departmentId ?? 0}) AS caller_department
    FROM doc_track_documents d LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.id = ${documentId} AND d.client_id = ${clientId} LIMIT 1
  `);
  const doc = (result.rows ?? [])[0] as any;
  if (!doc) return false;
  const siteAllowed = doc.site_id === null || departmentId === null || doc.department_id === null || doc.department_id === departmentId;
  const documentAllowed = departmentId === null || doc.department === null || doc.department === doc.caller_department;
  return siteAllowed && documentAllowed;
}

export const CATEGORIES = ["risk_assessment", "sop", "handbook", "policy", "procedure", "other"] as const;

const docCreate = z.object({
  title: z.string().min(1).max(500),
  category: z.enum(CATEGORIES),
  description: z.string().max(5000).nullable().optional(),
  fileName: z.string().min(1).max(500),
  fileSize: z.number().int().positive().nullable().optional(),
  mimeType: z.string().min(1).max(200),
  objectPath: z.string().min(1).max(2000),
  siteId: z.number().int().nullable().optional(),
  uploadedBy: z.string().max(200).nullable().optional(),
  requiresAcknowledgement: z.boolean().optional(),
  annualAcknowledgement: z.boolean().optional(),
  department: z.string().max(200).nullable().optional(),
});

const docUpdate = z.object({
  title: z.string().min(1).max(500).optional(),
  category: z.enum(CATEGORIES).optional(),
  description: z.string().max(5000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  requiresAcknowledgement: z.boolean().optional(),
  annualAcknowledgement: z.boolean().optional(),
  department: z.string().max(200).nullable().optional(),
});

// ── List documents ────────────────────────────────────────────────────────────

router.get("/documents", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { category, siteId, q } = req.query as any;

  const result = await db.execute(sql`
    SELECT d.id, d.client_id, d.site_id, d.title, d.category, d.description,
           d.file_name, d.file_size, d.mime_type, d.object_path, d.uploaded_by,
           d.requires_acknowledgement, d.annual_acknowledgement, d.department,
           d.created_at, d.updated_at, s.name AS site_name,
           COALESCE(ack_status.staff_total, 0) AS acknowledgement_staff_total,
           COALESCE(ack_status.acknowledged_count, 0) AS acknowledged_count,
           COALESCE(ack_status.pending_count, 0) AS pending_acknowledgement_count,
           COALESCE(ack_status.expired_count, 0) AS expired_acknowledgement_count,
           CASE
             WHEN d.requires_acknowledgement = false THEN 'not_required'
             WHEN COALESCE(ack_status.expired_count, 0) > 0 THEN 'expired'
             WHEN COALESCE(ack_status.pending_count, 0) > 0
               OR COALESCE(ack_status.staff_total, 0) = 0 THEN 'pending'
             ELSE 'acknowledged'
           END AS acknowledgement_status
    FROM doc_track_documents d
    LEFT JOIN sites s ON d.site_id = s.id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS staff_total,
        COUNT(*) FILTER (
          WHERE a.id IS NULL
             OR (a.train_track_record_id IS NOT NULL AND tr.id IS NULL)
        ) AS pending_count,
        COUNT(*) FILTER (
          WHERE a.id IS NOT NULL
            AND (a.train_track_record_id IS NULL OR tr.id IS NOT NULL)
            AND (tr.expiry_date IS NULL OR tr.expiry_date >= CURRENT_DATE)
        ) AS acknowledged_count,
        COUNT(*) FILTER (
          WHERE tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE
        ) AS expired_count
      FROM staff_roster sr
      LEFT JOIN doc_acknowledgements a
        ON a.document_id = d.id
       AND a.client_id = d.client_id
       AND a.staff_roster_id = sr.id
      LEFT JOIN train_track_records tr
        ON tr.id = a.train_track_record_id
       AND tr.client_id = d.client_id
      WHERE sr.client_id = d.client_id
        AND sr.active = true
        AND (d.department IS NULL OR sr.department = d.department)
         AND (d.site_id IS NULL OR sr.site_id = d.site_id)
    ) ack_status ON d.requires_acknowledgement = true
    WHERE d.client_id = ${clientId}
      ${getActiveDepartmentId(req) !== null ? sql`AND (d.site_id IS NULL OR s.department_id IS NULL OR s.department_id = ${getActiveDepartmentId(req)})
        AND (d.department IS NULL OR d.department = (SELECT name FROM departments WHERE id = ${getActiveDepartmentId(req)}))` : sql``}
    ORDER BY d.created_at DESC
  `);

  let rows = (result.rows ?? []) as any[];
  if (category) rows = rows.filter((r: any) => r.category === category);
  if (siteId) rows = rows.filter((r: any) => r.site_id === Number(siteId));
  if (q) {
    const lower = (q as string).toLowerCase();
    rows = rows.filter((r: any) => (r.title as string).toLowerCase().includes(lower));
  }

  res.json(rows);
});

// ── Create document record ────────────────────────────────────────────────────

router.post("/documents", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = docCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const { title, category, description, fileName, fileSize, mimeType, objectPath, siteId, uploadedBy, requiresAcknowledgement, annualAcknowledgement, department } = parsed.data;
  const createdBy = (req.session as any).userId ?? null;
  if (!await canAccessSite(clientId, siteId, getActiveDepartmentId(req))) return res.status(403).json({ error: "Site not accessible" });

  // Tag the uploaded object with a tenant-scoped ACL so the private object
  // route (/storage/objects/*) allows this client's users to read it. Without
  // this, documents uploaded via DocTrack have no ACL policy and downloads get
  // blocked by the storage security check.
  //
  // Security: never re-tag an object that already belongs to another tenant —
  // otherwise a caller who learns a foreign object path could claim it.
  try {
    const file = await storage.getObjectEntityFile(objectPath);
    const existingAcl = await getObjectAclPolicy(file);
    if (existingAcl?.owner && existingAcl.owner !== String(clientId)) {
      return res.status(403).json({ error: "Object does not belong to this account" });
    }
    const tenantUploadPrefix = `/objects/uploads/tenant-${clientId}/`;
    if (!existingAcl?.owner && !objectPath.startsWith(tenantUploadPrefix)) {
      return res.status(403).json({ error: "Upload was not reserved for this account" });
    }
    await storage.trySetObjectEntityAclPolicy(objectPath, {
      owner: String(clientId),
      visibility: "private",
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return res.status(404).json({ error: "Uploaded object not found" });
    }
    req.log.error({ err, objectPath }, "Could not set ACL policy on DocTrack upload");
    return res.status(500).json({ error: "Could not secure uploaded document" });
  }

  const result = await db.execute(sql`
    INSERT INTO doc_track_documents
      (client_id, site_id, title, category, description, file_name, file_size,
       mime_type, object_path, uploaded_by, created_by, requires_acknowledgement,
       annual_acknowledgement, department)
    VALUES
      (${clientId}, ${siteId ?? null}, ${title}, ${category}, ${description ?? null},
       ${fileName}, ${fileSize ?? null}, ${mimeType}, ${objectPath},
       ${uploadedBy ?? null}, ${createdBy}, ${requiresAcknowledgement ?? false},
       ${annualAcknowledgement ?? false}, ${department ?? null})
    RETURNING *
  `);

  res.status(201).json((result.rows ?? [])[0]);
});

// ── Update document metadata ───────────────────────────────────────────────────

router.patch("/documents/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = docUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });
  if (!await canAccessDocument(clientId, id, getActiveDepartmentId(req))) return res.status(404).json({ error: "Not found" });
  if (parsed.data.siteId !== undefined && !await canAccessSite(clientId, parsed.data.siteId, getActiveDepartmentId(req))) return res.status(403).json({ error: "Site not accessible" });

  const { title, category, description, siteId, requiresAcknowledgement, annualAcknowledgement, department } = parsed.data;
  const hasDesc   = description !== undefined;
  const hasSite   = siteId !== undefined;
  const hasAck    = requiresAcknowledgement !== undefined;
  const hasAnnual = annualAcknowledgement !== undefined;
  const hasDept   = department !== undefined;

  await db.execute(sql`
    UPDATE doc_track_documents
    SET title                    = COALESCE(${title ?? null}, title),
        category                 = COALESCE(${category ?? null}, category),
        description              = CASE WHEN ${hasDesc}::boolean   THEN ${description ?? null}              ELSE description END,
        site_id                  = CASE WHEN ${hasSite}::boolean   THEN ${siteId ?? null}                   ELSE site_id END,
        requires_acknowledgement = CASE WHEN ${hasAck}::boolean    THEN ${requiresAcknowledgement ?? false} ELSE requires_acknowledgement END,
        annual_acknowledgement   = CASE WHEN ${hasAnnual}::boolean THEN ${annualAcknowledgement ?? false}   ELSE annual_acknowledgement END,
        department               = CASE WHEN ${hasDept}::boolean   THEN ${department ?? null}               ELSE department END,
        updated_at               = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);

  const result = await db.execute(sql`
    SELECT d.*, s.name AS site_name
    FROM doc_track_documents d
    LEFT JOIN sites s ON d.site_id = s.id
    WHERE d.id = ${id} AND d.client_id = ${clientId}
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Delete document ───────────────────────────────────────────────────────────

router.delete("/documents/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  if (!await canAccessDocument(clientId, id, getActiveDepartmentId(req))) return res.status(404).json({ error: "Not found" });

  await db.execute(sql`
    DELETE FROM doc_track_documents
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.status(204).end();
});

// ── List acknowledgements for a document ─────────────────────────────────────

router.get("/documents/:id/acknowledgements", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const docId = parseInt(req.params.id as string);
  if (isNaN(docId)) return res.status(400).json({ error: "Invalid id" });

  // Verify document belongs to this client
  if (!await canAccessDocument(clientId, docId, getActiveDepartmentId(req))) return res.status(404).json({ error: "Not found" });

  const result = await db.execute(sql`
    SELECT a.id, a.document_id, a.staff_roster_id, a.staff_name, a.signature,
           a.acknowledged_at, a.train_track_record_id, tr.expiry_date,
           CASE
             WHEN a.train_track_record_id IS NOT NULL AND tr.id IS NULL THEN 'pending'
             WHEN tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE THEN 'expired'
             ELSE 'acknowledged'
           END AS acknowledgement_status,
           u.name AS acknowledged_by_name
    FROM doc_acknowledgements a
    LEFT JOIN users u ON a.acknowledged_by = u.id
    LEFT JOIN train_track_records tr
      ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
    WHERE a.document_id = ${docId} AND a.client_id = ${clientId}
    ORDER BY a.staff_name ASC
  `);

  res.json(result.rows ?? []);
});

// ── Export acknowledgement register as PDF ───────────────────────────────────

router.get("/documents/:id/acknowledgements/export", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const docId = parseInt(req.params.id as string);
  if (isNaN(docId)) return res.status(400).json({ error: "Invalid id" });
  if (!await canAccessDocument(clientId, docId, getActiveDepartmentId(req))) {
    return res.status(404).json({ error: "Not found" });
  }

  const documentResult = await db.execute(sql`
    SELECT title, category, department, site_id
    FROM doc_track_documents
    WHERE id = ${docId} AND client_id = ${clientId}
    LIMIT 1
  `);
  const document = (documentResult.rows ?? [])[0] as any;
  if (!document) return res.status(404).json({ error: "Not found" });

  const rosterResult = await db.execute(sql`
    SELECT sr.id, sr.name
    FROM staff_roster sr
    WHERE sr.client_id = ${clientId}
      AND sr.active = true
      AND (${document.department}::text IS NULL OR sr.department = ${document.department})
      AND (${document.site_id}::integer IS NULL OR sr.site_id = ${document.site_id})
      ${getActiveDepartmentId(req) !== null ? sql`AND (sr.department IS NULL OR sr.department = (SELECT name FROM departments WHERE id = ${getActiveDepartmentId(req)}))` : sql``}
    ORDER BY sr.name ASC
  `);
  const acknowledgementResult = await db.execute(sql`
    SELECT a.staff_roster_id, a.staff_name, a.signature, a.acknowledged_at,
      CASE
        WHEN a.train_track_record_id IS NOT NULL AND tr.id IS NULL THEN false
        WHEN tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE THEN false
        ELSE true
      END AS is_current
    FROM doc_acknowledgements a
    LEFT JOIN train_track_records tr
      ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
    WHERE a.document_id = ${docId} AND a.client_id = ${clientId}
  `);

  const acknowledgements = (acknowledgementResult.rows ?? []) as any[];
  const currentByRosterId = new Map(
    acknowledgements
      .filter((ack) => ack.is_current && ack.staff_roster_id !== null)
      .map((ack) => [Number(ack.staff_roster_id), ack]),
  );
  const acknowledgedDates = acknowledgements
    .filter((ack) => ack.is_current && ack.acknowledged_at)
    .map((ack) => new Date(ack.acknowledged_at))
    .sort((a, b) => a.getTime() - b.getTime());
  const formatDate = (date: Date) => date.toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
  const dateRange = acknowledgedDates.length
    ? `${formatDate(acknowledgedDates[0])} to ${formatDate(acknowledgedDates[acknowledgedDates.length - 1])}`
    : "No acknowledgements recorded";

  const acknowledgedRows: any[] = [];
  const outstandingRows: any[] = [];
  for (const staff of (rosterResult.rows ?? []) as any[]) {
    const acknowledgement = currentByRosterId.get(Number(staff.id));
    if (acknowledgement) {
      acknowledgedRows.push({
        staffName: staff.name,
        signature: acknowledgement.signature ?? "",
        acknowledgedAt: formatDate(new Date(acknowledgement.acknowledged_at)),
        status: "Acknowledged" as const,
      });
    } else {
      outstandingRows.push({
        staffName: staff.name,
        signature: "",
        acknowledgedAt: "",
        status: "Outstanding" as const,
      });
    }
  }

  const pdf = createAcknowledgementRegisterPdf({
    title: document.title,
    category: String(document.category).replace(/_/g, " "),
    generatedAt: formatDate(new Date()),
    dateRange,
    rows: [...acknowledgedRows, ...outstandingRows],
  });
  const safeTitle = String(document.title).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "document";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}-acknowledgements.pdf"`);
  res.setHeader("Content-Length", pdf.length);
  res.send(pdf);
});

// ── Outstanding acknowledgements overview (managers) ────────────────────────
// Resolve a login to exactly one active roster record. Display names are not
// identities: multiple staff can share a name (or even a reused email).
async function findMyRoster(clientId: number, email: string | null | undefined) {
  if (!email?.trim()) return [];
  const rows = await db.execute(sql`
    SELECT id, name, department, site_id FROM staff_roster
    WHERE client_id = ${clientId} AND active = true
      AND email IS NOT NULL AND lower(btrim(email)) = lower(${email.trim()})
    LIMIT 2
  `);
  return (rows.rows ?? []) as Array<{ id: number; name: string; department: string | null; site_id: number | null }>;
}

router.get("/acknowledgements/my", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const matches = await findMyRoster(clientId, req.currentUser!.email);
  if (matches.length > 1) return res.status(409).json({ error: "More than one active staff record uses your email. Ask an administrator to resolve this before signing." });
  if (matches.length === 0) return res.json({ rosterLinked: false, pending: [], completed: [] });
  const roster = matches[0];
  const result = await db.execute(sql`
    SELECT d.id, d.title, d.category, d.description, d.file_name, d.mime_type,
           d.department, s.name AS site_name, a.acknowledged_at, a.signature,
           CASE WHEN a.id IS NOT NULL
             AND (a.train_track_record_id IS NULL OR tr.id IS NOT NULL)
             AND (tr.expiry_date IS NULL OR tr.expiry_date >= CURRENT_DATE)
             THEN true ELSE false END AS is_current
    FROM doc_track_documents d
    LEFT JOIN sites s ON s.id = d.site_id AND s.client_id = d.client_id
    LEFT JOIN doc_acknowledgements a ON a.document_id = d.id
      AND a.client_id = d.client_id AND a.staff_roster_id = ${roster.id}
    LEFT JOIN train_track_records tr ON tr.id = a.train_track_record_id
      AND tr.client_id = d.client_id
    WHERE d.client_id = ${clientId} AND d.requires_acknowledgement = true
      AND (d.department IS NULL OR d.department = ${roster.department})
      AND (d.site_id IS NULL OR d.site_id = ${roster.site_id})
      ${getActiveDepartmentId(req) !== null ? sql`AND (d.site_id IS NULL OR s.department_id IS NULL OR s.department_id = ${getActiveDepartmentId(req)})
        AND (d.department IS NULL OR d.department = (SELECT name FROM departments WHERE id = ${getActiveDepartmentId(req)}))` : sql``}
    ORDER BY d.created_at DESC
  `);
  const rows = (result.rows ?? []) as Array<Record<string, unknown> & { is_current: boolean }>;
  const toDocument = ({ is_current: _current, ...document }: typeof rows[number]) => document;
  res.json({
    rosterLinked: true,
    pending: rows.filter(row => !row.is_current).map(toDocument),
    completed: rows.filter(row => row.is_current).map(toDocument),
  });
});

// ── Outstanding acknowledgements overview (managers) ────────────────────────
// For every document that requires acknowledgement, list the roster staff who
// have NOT yet acknowledged it.
router.get("/acknowledgements/outstanding", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const docsResult = await db.execute(sql`
    SELECT d.id, d.title, d.category, d.department, d.site_id, d.created_at
    FROM doc_track_documents d
    LEFT JOIN sites s ON s.id = d.site_id
    WHERE d.client_id = ${clientId} AND d.requires_acknowledgement = true
      ${getActiveDepartmentId(req) !== null ? sql`AND (d.site_id IS NULL OR s.department_id IS NULL OR s.department_id = ${getActiveDepartmentId(req)})
        AND (d.department IS NULL OR d.department = (SELECT name FROM departments WHERE id = ${getActiveDepartmentId(req)}))` : sql``}
    ORDER BY d.title ASC
  `);
  const docs = (docsResult.rows ?? []) as any[];
  if (docs.length === 0) return res.json({ documents: [] });

  const staffResult = await db.execute(sql`
    SELECT id, name, department, site_id FROM staff_roster
    WHERE client_id = ${clientId} AND active = true
      ${getActiveDepartmentId(req) !== null ? sql`AND (department IS NULL OR department = (SELECT name FROM departments WHERE id = ${getActiveDepartmentId(req)}))` : sql``}
    ORDER BY name ASC
  `);
  const staff = (staffResult.rows ?? []) as any[];

  const acksResult = await db.execute(sql`
    SELECT a.document_id, a.staff_roster_id, a.staff_name, a.acknowledged_at, a.signature,
           CASE
             WHEN a.train_track_record_id IS NOT NULL AND tr.id IS NULL THEN false
             WHEN tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE THEN false
             ELSE true
           END AS is_current
    FROM doc_acknowledgements a
    LEFT JOIN train_track_records tr
      ON tr.id = a.train_track_record_id
     AND tr.client_id = a.client_id
    WHERE a.client_id = ${clientId}
  `);
  const ackRows = (acksResult.rows ?? []) as any[];
  const acked = new Set(
    ackRows
      .filter((r) => r.is_current)
      .map((r) => `${r.document_id}:${r.staff_roster_id}`),
  );

  const documents = docs.map((d) => {
    // Documents scoped to a department only need acknowledgement from that department.
    const relevant = staff.filter((s) =>
      (!d.department || s.department === d.department)
      && (d.site_id == null || s.site_id === d.site_id),
    );
    const outstanding = relevant.filter((s) => !acked.has(`${d.id}:${s.id}`));
    return {
      id: d.id,
      title: d.title,
      category: d.category,
      department: d.department,
      staffTotal: relevant.length,
      acknowledgedCount: relevant.length - outstanding.length,
      outstanding: outstanding.map((s) => ({ id: s.id, name: s.name, department: s.department })),
      acknowledged: ackRows
        .filter((r) =>
          r.document_id === d.id
          && r.is_current
          && relevant.some((s) => s.id === r.staff_roster_id),
        )
        .map((r) => ({ name: r.staff_name, acknowledgedAt: r.acknowledged_at, signed: !!r.signature })),
    };
  });

  res.json({ documents });
});

// ── Record acknowledgements ───────────────────────────────────────────────────

// Manager roles may acknowledge on behalf of other staff (bulk sign-off).
// Everyone else can only acknowledge as themselves — identity is derived
// server-side and any client-supplied roster id/name is ignored.
const MANAGER_ROLES = new Set(["client_admin", "consultant"]);

// A single acknowledgement to persist. staffRosterId may be null when the
// authenticated staff member has no matching staff_roster row.
interface ResolvedAck {
  staffRosterId: number | null;
  staffName: string;
  signature: string | null;
}

/**
 * The sole eligibility rule for acknowledgement evidence. A roster entry must
 * be active and assigned to every document scope that is set. Keep this
 * server-side: manager payloads and staff sessions are both untrusted.
 */
async function findEligibleRosterMember(
  clientId: number,
  document: { site_id: number | null; department: string | null },
  rosterId?: number,
  email?: string | null,
) {
  if (rosterId == null && !email) return null;
  const result = await db.execute(sql`
    SELECT id, name
    FROM staff_roster
    WHERE client_id = ${clientId}
      AND active = true
      AND (${document.department}::text IS NULL OR department = ${document.department})
      AND (${document.site_id}::integer IS NULL OR site_id = ${document.site_id})
      AND (
        ${rosterId ?? null}::integer IS NOT NULL AND id = ${rosterId ?? null}
        OR ${email ?? null}::text IS NOT NULL AND email IS NOT NULL AND lower(email) = lower(${email ?? null})
      )
    LIMIT 1
  `);
  return (result.rows ?? [])[0] as { id: number; name: string } | undefined;
}

// Manager bulk-ack payload: they supply the roster entries to sign off.
const ackBulkCreate = z.object({
  acknowledgements: z.array(z.object({
    staffRosterId: z.number().int(),
    staffName: z.string().min(1).max(300),
    signature: z.string().max(300).nullable().optional(),
  })).min(1),
});

// Self-ack payload: only an optional signature is honored. Any staffRosterId /
// staffName in the body is deliberately ignored — identity comes from the
// authenticated session.
const ackSelfCreate = z.object({
  signature: z.string().max(300).nullable().optional(),
}).passthrough();

router.post("/documents/:id/acknowledge", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const docId = parseInt(req.params.id as string);
  if (isNaN(docId)) return res.status(400).json({ error: "Invalid id" });

  // Verify document belongs to this client
  const docResult = await db.execute(sql`
    SELECT id, title, category, site_id, department, requires_acknowledgement, annual_acknowledgement FROM doc_track_documents
    WHERE id = ${docId} AND client_id = ${clientId}
    LIMIT 1
  `);
  const doc = (docResult.rows ?? [])[0] as any;
  if (!doc) return res.status(404).json({ error: "Not found" });
  if (!await canAccessDocument(clientId, docId, getActiveDepartmentId(req))) return res.status(404).json({ error: "Not found" });
  if (!doc.requires_acknowledgement) return res.status(400).json({ error: "This document does not require acknowledgement" });

  const user = req.currentUser!;
  const userId = user.id;
  const isManager = MANAGER_ROLES.has(user.role);

  // Resolve the acknowledgements we will actually persist. Non-managers can
  // only ever acknowledge as themselves, regardless of request body.
  let toCreate: ResolvedAck[] = [];

  if (isManager && req.body?.self !== true) {
    const parsed = ackBulkCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

    for (const ack of parsed.data.acknowledgements) {
      const roster = await findEligibleRosterMember(clientId, doc, ack.staffRosterId);
      if (!roster) continue; // ineligible/foreign roster rows never create evidence
      toCreate.push({
        staffRosterId: roster.id,
        // Use the roster's real name, not the client-supplied one.
        staffName: roster.name,
        signature: ack.signature ?? null,
      });
    }
  } else {
    // Self-acknowledgement — derive identity from the authenticated user.
    const parsed = ackSelfCreate.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });
    const signature = parsed.data.signature?.trim() || null;

    // staff_roster has no user_id column: require one unambiguous active
    // email match, then check the document's site/department eligibility.
    const matches = await findMyRoster(clientId, user.email);
    if (matches.length > 1) return res.status(409).json({ error: "More than one active staff record uses your email. Ask an administrator to resolve this before signing." });
    const roster = matches.length === 1
      ? await findEligibleRosterMember(clientId, doc, matches[0].id)
      : null;
    if (!roster) return res.status(403).json({ error: "No eligible active staff roster entry for this document" });
    toCreate = [{ staffRosterId: roster.id, staffName: roster.name, signature }];
  }

  const today = new Date().toISOString().split("T")[0];
  const created: any[] = [];

  for (const ack of toCreate) {
    // Current acknowledgements are idempotent. Expired annual sign-offs (or
    // acknowledgements whose linked TrainTrack record was removed) are renewed
    // below by replacing the stale link while retaining the acknowledgement row.
    const existing = ack.staffRosterId !== null
      ? await db.execute(sql`
          SELECT a.id,
                 CASE
                   WHEN a.train_track_record_id IS NOT NULL AND tr.id IS NULL THEN false
                   WHEN tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE THEN false
                   ELSE true
                 END AS is_current
          FROM doc_acknowledgements a
          LEFT JOIN train_track_records tr
            ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
          WHERE a.document_id = ${docId} AND a.client_id = ${clientId}
            AND a.staff_roster_id = ${ack.staffRosterId}
          LIMIT 1
        `)
      : await db.execute(sql`
          SELECT a.id,
                 CASE
                   WHEN a.train_track_record_id IS NOT NULL AND tr.id IS NULL THEN false
                   WHEN tr.expiry_date IS NOT NULL AND tr.expiry_date < CURRENT_DATE THEN false
                   ELSE true
                 END AS is_current
          FROM doc_acknowledgements a
          LEFT JOIN train_track_records tr
            ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
          WHERE a.document_id = ${docId} AND a.client_id = ${clientId}
            AND a.staff_roster_id IS NULL AND a.acknowledged_by = ${userId}
          LIMIT 1
        `);
    const existingAck = (existing.rows ?? [])[0] as any;
    if (existingAck?.is_current) continue;

    // Create TrainTrack signoff record.
    // When annual_acknowledgement is enabled the record gets a 1-year expiry so
    // TrainTrack's expiry reminders automatically prompt re-acknowledgement.
    const expiryDate = doc.annual_acknowledgement
      ? sql`(${today}::date + interval '1 year')::date`
      : sql`NULL::date`;
    const trainResult = await db.execute(sql`
      INSERT INTO train_track_records
        (client_id, site_id, record_type, staff_name, training_type, document_title,
         document_type, completed_date, expiry_date, notes, signature)
      VALUES
        (${clientId}, ${doc.site_id ?? null}, 'signoff', ${ack.staffName},
         ${doc.title},
         ${doc.title}, ${doc.category}, ${today}::date,
         ${expiryDate},
         ${'Document acknowledgement via DocTrack'},
         ${ack.signature ?? null})
      RETURNING id
    `);
    const trainId = ((trainResult.rows ?? [])[0] as any)?.id ?? null;

    const ackResult = existingAck
      ? await db.execute(sql`
          UPDATE doc_acknowledgements
          SET staff_name = ${ack.staffName},
              signature = ${ack.signature ?? null},
              acknowledged_by = ${userId},
              train_track_record_id = ${trainId},
              acknowledged_at = now()
          WHERE id = ${existingAck.id} AND client_id = ${clientId}
          RETURNING *
        `)
      : await db.execute(sql`
          INSERT INTO doc_acknowledgements
            (document_id, client_id, staff_roster_id, staff_name, signature,
             acknowledged_by, train_track_record_id)
          VALUES
            (${docId}, ${clientId}, ${ack.staffRosterId}, ${ack.staffName},
             ${ack.signature ?? null}, ${userId}, ${trainId})
          RETURNING *
        `);
    if ((ackResult.rows ?? [])[0]) created.push((ackResult.rows ?? [])[0]);
  }

  res.status(201).json({ created: created.length, records: created });
});

// ── Get sign-off link token ───────────────────────────────────────────────────

router.get("/sign-off-info", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const result = await db.execute(sql`
    SELECT sign_off_token, sign_off_token_expires_at, sign_off_token_revoked_at
    FROM clients WHERE id = ${clientId} LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as any;
  if (!row?.sign_off_token || row.sign_off_token_revoked_at ||
      !row.sign_off_token_expires_at || new Date(row.sign_off_token_expires_at) <= new Date()) {
    return res.status(404).json({ error: "No active sign-off link. Create a new link to continue." });
  }

  res.json({ token: row.sign_off_token, expiresAt: row.sign_off_token_expires_at });
});

router.post("/sign-off-info", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const token = newBearerToken();
  const updated = await db.execute(sql`
    UPDATE clients
    SET sign_off_token = ${token},
        sign_off_token_expires_at = now() + interval '90 days',
        sign_off_token_revoked_at = NULL
    WHERE id = ${clientId}
    RETURNING sign_off_token_expires_at
  `);
  const expiresAt = (updated.rows ?? [])[0] as { sign_off_token_expires_at?: Date } | undefined;
  if (!expiresAt) return res.status(404).json({ error: "Client not found" });
  res.status(201).json({ token, expiresAt: expiresAt.sign_off_token_expires_at });
});

router.delete("/sign-off-info", requireAuth, requireClientAdmin, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  const revoked = await db.execute(sql`
    UPDATE clients
    SET sign_off_token = NULL,
        sign_off_token_expires_at = NULL,
        sign_off_token_revoked_at = now()
    WHERE id = ${clientId} AND sign_off_token IS NOT NULL
    RETURNING id
  `);
  if (!(revoked.rows ?? []).length) return res.status(404).json({ error: "No active sign-off link" });
  res.status(204).end();
});

// ── Request presigned upload URL ──────────────────────────────────────────────

router.post("/documents/request-upload", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  z.object({
    name: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
  }).parse(req.body); // validate — name/contentType not used server-side

  try {
    const uploadUrl = await storage.getObjectEntityUploadURL(clientId);
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    res.json({ uploadUrl, objectPath });
  } catch (err) {
    return respondObjectStorageUnavailable(req, res, err, "DocTrack document upload");
  }
});

// ── Get signed download URL ───────────────────────────────────────────────────

router.get("/documents/:id/download-url", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const result = await db.execute(sql`
    SELECT object_path, file_name FROM doc_track_documents
    WHERE id = ${id} AND client_id = ${clientId}
    LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as any;
  if (!row) return res.status(404).json({ error: "Not found" });
  if (!await canAccessDocument(clientId, id, getActiveDepartmentId(req))) return res.status(404).json({ error: "Not found" });

  // Backfill ACL for legacy documents that were uploaded before the ACL check
  // was enforced. A signed URL bypasses the application's storage route, so
  // verify the final ACL here too; it must never be issued for another tenant.
  try {
    const file = await storage.getObjectEntityFile(row.object_path);
    const existingAcl = await getObjectAclPolicy(file);
    if (!existingAcl?.owner) {
      // No ACL set — this is a legacy document; backfill it for this client.
      await storage.trySetObjectEntityAclPolicy(row.object_path, {
        owner: String(clientId),
        visibility: "private",
      });
    } else if (existingAcl.owner !== String(clientId)) {
      return res.status(403).json({ error: "Object does not belong to this account" });
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return res.status(404).json({ error: "Document object not found" });
    }
    req.log.warn({ err, objectPath: row.object_path }, "Could not backfill ACL on DocTrack download");
    // Non-fatal — attempt to generate the signed URL anyway.
  }

  try {
    const downloadUrl = await storage.getSignedDownloadURL(row.object_path);
    res.json({ downloadUrl, fileName: row.file_name });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate download URL", detail: err?.message });
  }
});

export default router;
