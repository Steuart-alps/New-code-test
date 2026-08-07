import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, getClientId, denyViewers } from "../middleware/requireAuth";
import { ObjectStorageService } from "../lib/objectStorage";
import { getObjectAclPolicy } from "../lib/objectAcl";

const router = Router();
const storage = new ObjectStorageService();

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
  department: z.string().max(200).nullable().optional(),
});

const docUpdate = z.object({
  title: z.string().min(1).max(500).optional(),
  category: z.enum(CATEGORIES).optional(),
  description: z.string().max(5000).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  requiresAcknowledgement: z.boolean().optional(),
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
           d.requires_acknowledgement, d.department, d.created_at, d.updated_at,
           s.name AS site_name
    FROM doc_track_documents d
    LEFT JOIN sites s ON d.site_id = s.id
    WHERE d.client_id = ${clientId}
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

  const { title, category, description, fileName, fileSize, mimeType, objectPath, siteId, uploadedBy, requiresAcknowledgement, department } = parsed.data;
  const createdBy = (req.session as any).userId ?? null;

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
    await storage.trySetObjectEntityAclPolicy(objectPath, {
      owner: String(clientId),
      visibility: "private",
    });
  } catch (err) {
    req.log.warn({ err, objectPath }, "Could not set ACL policy on DocTrack upload");
  }

  const result = await db.execute(sql`
    INSERT INTO doc_track_documents
      (client_id, site_id, title, category, description, file_name, file_size,
       mime_type, object_path, uploaded_by, created_by, requires_acknowledgement, department)
    VALUES
      (${clientId}, ${siteId ?? null}, ${title}, ${category}, ${description ?? null},
       ${fileName}, ${fileSize ?? null}, ${mimeType}, ${objectPath},
       ${uploadedBy ?? null}, ${createdBy}, ${requiresAcknowledgement ?? false},
       ${department ?? null})
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

  const { title, category, description, siteId, requiresAcknowledgement, department } = parsed.data;
  const hasDesc = description !== undefined;
  const hasSite = siteId !== undefined;
  const hasAck  = requiresAcknowledgement !== undefined;
  const hasDept = department !== undefined;

  await db.execute(sql`
    UPDATE doc_track_documents
    SET title                    = COALESCE(${title ?? null}, title),
        category                 = COALESCE(${category ?? null}, category),
        description              = CASE WHEN ${hasDesc}::boolean THEN ${description ?? null} ELSE description END,
        site_id                  = CASE WHEN ${hasSite}::boolean THEN ${siteId ?? null} ELSE site_id END,
        requires_acknowledgement = CASE WHEN ${hasAck}::boolean  THEN ${requiresAcknowledgement ?? false} ELSE requires_acknowledgement END,
        department               = CASE WHEN ${hasDept}::boolean THEN ${department ?? null} ELSE department END,
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
  const docCheck = await db.execute(sql`
    SELECT id FROM doc_track_documents WHERE id = ${docId} AND client_id = ${clientId} LIMIT 1
  `);
  if (!(docCheck.rows ?? [])[0]) return res.status(404).json({ error: "Not found" });

  const result = await db.execute(sql`
    SELECT a.id, a.document_id, a.staff_roster_id, a.staff_name, a.signature,
           a.acknowledged_at, a.train_track_record_id,
           u.name AS acknowledged_by_name
    FROM doc_acknowledgements a
    LEFT JOIN users u ON a.acknowledged_by = u.id
    WHERE a.document_id = ${docId} AND a.client_id = ${clientId}
    ORDER BY a.staff_name ASC
  `);

  res.json(result.rows ?? []);
});

// ── Outstanding acknowledgements overview (managers) ────────────────────────
// For every document that requires acknowledgement, list the roster staff who
// have NOT yet acknowledged it.
router.get("/acknowledgements/outstanding", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const docsResult = await db.execute(sql`
    SELECT d.id, d.title, d.category, d.department, d.created_at
    FROM doc_track_documents d
    WHERE d.client_id = ${clientId} AND d.requires_acknowledgement = true
    ORDER BY d.title ASC
  `);
  const docs = (docsResult.rows ?? []) as any[];
  if (docs.length === 0) return res.json({ documents: [] });

  const staffResult = await db.execute(sql`
    SELECT id, (first_name || ' ' || last_name) AS name, department FROM staff_roster
    WHERE client_id = ${clientId} AND active = true
    ORDER BY first_name ASC, last_name ASC
  `);
  const staff = (staffResult.rows ?? []) as any[];

  const acksResult = await db.execute(sql`
    SELECT document_id, staff_roster_id, staff_name, acknowledged_at, signature
    FROM doc_acknowledgements
    WHERE client_id = ${clientId}
  `);
  const ackRows = (acksResult.rows ?? []) as any[];
  const acked = new Set(ackRows.map((r) => `${r.document_id}:${r.staff_roster_id}`));

  const documents = docs.map((d) => {
    // Documents scoped to a department only need acknowledgement from that department.
    const relevant = d.department ? staff.filter((s) => s.department === d.department) : staff;
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
        .filter((r) => r.document_id === d.id)
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
    SELECT id, title, category, site_id FROM doc_track_documents
    WHERE id = ${docId} AND client_id = ${clientId}
    LIMIT 1
  `);
  const doc = (docResult.rows ?? [])[0] as any;
  if (!doc) return res.status(404).json({ error: "Not found" });

  const user = req.currentUser!;
  const userId = user.id;
  const isManager = MANAGER_ROLES.has(user.role);

  // Resolve the acknowledgements we will actually persist. Non-managers can
  // only ever acknowledge as themselves, regardless of request body.
  let toCreate: ResolvedAck[] = [];

  if (isManager) {
    const parsed = ackBulkCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

    for (const ack of parsed.data.acknowledgements) {
      // Every supplied roster row must belong to this client (defense in depth
      // against forged / cross-tenant roster ids).
      const rosterCheck = await db.execute(sql`
        SELECT id, (first_name || ' ' || last_name) AS name
        FROM staff_roster
        WHERE id = ${ack.staffRosterId} AND client_id = ${clientId}
        LIMIT 1
      `);
      const roster = (rosterCheck.rows ?? [])[0] as any;
      if (!roster) continue; // ignore roster ids not in this tenant
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
    const signature = parsed.success ? (parsed.data.signature ?? null) : null;

    // Match the current user to a staff_roster row by email (case-insensitive)
    // within this client. staff_roster has no user_id column, so email is the
    // authoritative link; fall back to the user's own name with no roster link.
    let rosterId: number | null = null;
    let staffName = user.name;
    if (user.email) {
      const rosterMatch = await db.execute(sql`
        SELECT id, (first_name || ' ' || last_name) AS name
        FROM staff_roster
        WHERE client_id = ${clientId}
          AND email IS NOT NULL
          AND lower(email) = lower(${user.email})
        LIMIT 1
      `);
      const roster = (rosterMatch.rows ?? [])[0] as any;
      if (roster) {
        rosterId = roster.id;
        staffName = roster.name;
      }
    }
    toCreate = [{ staffRosterId: rosterId, staffName, signature: signature ?? staffName }];
  }

  const today = new Date().toISOString().split("T")[0];
  const created: any[] = [];

  for (const ack of toCreate) {
    // Skip if already acknowledged. When there is no roster link (staff without
    // a roster row) dedupe by the acknowledging user instead.
    const existing = ack.staffRosterId !== null
      ? await db.execute(sql`
          SELECT id FROM doc_acknowledgements
          WHERE document_id = ${docId} AND client_id = ${clientId}
            AND staff_roster_id = ${ack.staffRosterId}
          LIMIT 1
        `)
      : await db.execute(sql`
          SELECT id FROM doc_acknowledgements
          WHERE document_id = ${docId} AND client_id = ${clientId}
            AND staff_roster_id IS NULL AND acknowledged_by = ${userId}
          LIMIT 1
        `);
    if ((existing.rows ?? []).length > 0) continue;

    // Create TrainTrack signoff record
    const trainResult = await db.execute(sql`
      INSERT INTO train_track_records
        (client_id, site_id, record_type, staff_name, document_title,
         document_type, completed_date, notes, signature)
      VALUES
        (${clientId}, ${doc.site_id ?? null}, 'signoff', ${ack.staffName},
         ${doc.title}, ${doc.category}, ${today}::date,
         ${'Document acknowledgement via DocTrack'},
         ${ack.signature ?? null})
      RETURNING id
    `);
    const trainId = ((trainResult.rows ?? [])[0] as any)?.id ?? null;

    // Create acknowledgement record
    const ackResult = await db.execute(sql`
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

router.get("/sign-off-info", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const result = await db.execute(sql`
    SELECT sign_off_token FROM clients WHERE id = ${clientId} LIMIT 1
  `);
  const row = (result.rows ?? [])[0] as any;
  if (!row?.sign_off_token) return res.status(404).json({ error: "No sign-off token found" });

  res.json({ token: row.sign_off_token });
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
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
    res.json({ uploadUrl, objectPath });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate upload URL", detail: err?.message });
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

  try {
    const downloadUrl = await storage.getSignedDownloadURL(row.object_path);
    res.json({ downloadUrl, fileName: row.file_name });
  } catch (err: any) {
    res.status(500).json({ error: "Could not generate download URL", detail: err?.message });
  }
});

export default router;
