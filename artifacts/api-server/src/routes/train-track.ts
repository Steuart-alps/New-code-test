import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole, getClientId, getActiveDepartmentId, denyViewers } from "../middleware/requireAuth";
import { getEffectiveOptionState, type StoredOptionState } from "../lib/formOptions";
import { siteVisibleSql, siteVisibleToDepartment } from "../lib/departmentSites";

const router = Router();

// "Other" lets staff type any training name, but not one the business has
// disabled: that would bring a retired option back through the free-text box.
function trainingTypeIsAllowed(value: string, options: StoredOptionState): boolean {
  if (options.active.includes(value)) return true;
  const typed = value.trim().toLowerCase();
  return options.active.includes("Other") && typed.length > 0
    && !options.disabled.some((item) => item.toLowerCase() === typed);
}

async function canAccessSite(clientId: number, siteId: number | null | undefined, departmentId: number | null) {
  if (siteId == null) return true;
  const result = await db.execute(sql`
    SELECT id, department_id FROM sites WHERE id = ${siteId} AND client_id = ${clientId} LIMIT 1
  `);
  const site = (result.rows ?? [])[0] as any;
  return !!site && await siteVisibleToDepartment({ id: Number(site.id), departmentId: site.department_id }, departmentId);
}

// A roster link is accepted only for a roster member of this tenant whose
// site (if any) is visible in the caller's active department. Unknown and
// foreign ids get the same answer so ids cannot be probed across tenants.
async function canLinkRosterMember(clientId: number, staffRosterId: number | null | undefined, departmentId: number | null) {
  if (staffRosterId == null) return true;
  const result = await db.execute(sql`
    SELECT sr.site_id FROM staff_roster sr
    WHERE sr.id = ${staffRosterId} AND sr.client_id = ${clientId}
    LIMIT 1
  `);
  const member = (result.rows ?? [])[0] as any;
  return !!member && await canAccessSite(clientId, member.site_id, departmentId);
}

const staffRosterIdField = z.number().int().positive().nullable().optional();

export const RECORD_TYPES = ["certificate", "signoff", "internal"] as const;
export type RecordType = typeof RECORD_TYPES[number];

export const CERTIFICATE_TRAINING_TYPES = [
  "Fire Safety Awareness",
  "Food Hygiene (Level 2)",
  "Food Hygiene (Level 3)",
  "Manual Handling",
  "First Aid at Work",
  "Emergency First Aid at Work",
  "COSHH Awareness",
  "Health & Safety Induction",
  "Working at Height",
  "RIDDOR Awareness",
  "Asbestos Awareness",
  "Display Screen Equipment (DSE)",
  // DBS / PVG disclosure checks
  "DBS Check (Basic)",
  "DBS Check (Standard)",
  "DBS Check (Enhanced)",
  "PVG Scheme (Scotland)",
  // Chainsaw NPTC / LANTRA certificates
  "Chainsaw (NPTC CS30 — Maintenance & Cross-cutting)",
  "Chainsaw (NPTC CS31 — Felling Small Trees)",
  "Chainsaw (NPTC CS32 — Felling Medium Trees)",
  "Chainsaw (NPTC CS38 — From Rope & Harness)",
  "Other",
] as const;

export const DOCUMENT_TYPES = [
  "risk_assessment",
  "sop",
  "handbook",
  "policy",
  "procedure",
  "other",
] as const;

const signatureField = z.string().max(500000).nullable().optional(); // base64 PNG

const recordCreate = z.discriminatedUnion("recordType", [
  // External training certificate
  z.object({
    recordType: z.literal("certificate"),
    staffName: z.string().min(1).max(300),
    staffRosterId: staffRosterIdField,
    trainingType: z.string().min(1).max(300),
    provider: z.string().min(1).max(300),
    completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    siteId: z.number().int().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    signature: signatureField,
  }),
  // Document sign-off
  z.object({
    recordType: z.literal("signoff"),
    staffName: z.string().min(1).max(300),
    staffRosterId: staffRosterIdField,
    documentTitle: z.string().min(1).max(500),
    documentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
    completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    siteId: z.number().int().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    signature: signatureField,
  }),
  // Internal training / equipment demo
  z.object({
    recordType: z.literal("internal"),
    staffName: z.string().min(1).max(300),
    staffRosterId: staffRosterIdField,
    trainingType: z.string().min(1).max(300),
    trainer: z.string().min(1).max(300),
    completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    siteId: z.number().int().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    signature: signatureField,
  }),
]);

const recordUpdate = z.object({
  staffName: z.string().min(1).max(300).optional(),
  staffRosterId: staffRosterIdField,
  trainingType: z.string().min(1).max(300).nullable().optional(),
  documentTitle: z.string().min(1).max(500).nullable().optional(),
  documentType: z.enum(DOCUMENT_TYPES).nullable().optional(),
  provider: z.string().min(1).max(300).nullable().optional(),
  trainer: z.string().min(1).max(300).nullable().optional(),
  completedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  siteId: z.number().int().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  signature: signatureField,
});

// ── List records ──────────────────────────────────────────────────────────────

router.get("/records", requireAuth, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const { recordType, siteId, q } = req.query as any;
  const departmentId = getActiveDepartmentId(req);

  const result = await db.execute(sql`
    SELECT r.id, r.client_id, r.site_id, r.record_type,
           r.staff_name, r.staff_roster_id, r.training_type, r.document_title, r.document_type,
           r.provider, r.trainer,
            r.completed_date, r.expiry_date, r.notes, r.signature,
           r.created_at, r.updated_at,
           s.name AS site_name
    FROM train_track_records r
    LEFT JOIN sites s ON r.site_id = s.id
    WHERE r.client_id = ${clientId}
      ${departmentId !== null ? sql`
        AND (r.site_id IS NULL OR ${siteVisibleSql(sql`s.id`, sql`s.department_id`, departmentId)})
      ` : sql``}
    ORDER BY r.expiry_date ASC NULLS LAST, r.completed_date DESC, r.staff_name ASC
  `);

  let rows = (result.rows ?? []) as any[];

  if (recordType) rows = rows.filter((r: any) => r.record_type === recordType);
  if (siteId)     rows = rows.filter((r: any) => r.site_id === Number(siteId));
  if (q) {
    const lower = (q as string).toLowerCase();
    rows = rows.filter((r: any) =>
      (r.staff_name as string).toLowerCase().includes(lower) ||
      (r.training_type ?? "").toLowerCase().includes(lower) ||
      (r.document_title ?? "").toLowerCase().includes(lower) ||
      (r.provider ?? "").toLowerCase().includes(lower) ||
      (r.trainer ?? "").toLowerCase().includes(lower)
    );
  }

  res.json(rows);
});

// ── A Viewer's own records ────────────────────────────────────────────────────
// A Viewer's account is linked to their staff roster entry; they see only the
// records for that entry and can add their signature to any not yet signed.

const OWN_RECORD_COLUMNS = sql`
  r.id, r.record_type, r.staff_name, r.training_type, r.document_title, r.document_type,
  r.provider, r.trainer, r.completed_date, r.expiry_date, r.notes,
  r.signature IS NOT NULL AS signed, r.updated_at, s.name AS site_name
`;

router.get("/my-records", requireAuth, requireRole("client_viewer"), async (req, res) => {
  const user = req.currentUser!;
  if (user.clientId == null || user.staffRosterId == null) return res.json({ linked: false, records: [] });
  const result = await db.execute(sql`
    SELECT ${OWN_RECORD_COLUMNS}
    FROM train_track_records r
    LEFT JOIN sites s ON r.site_id = s.id
    WHERE r.client_id = ${user.clientId} AND r.staff_roster_id = ${user.staffRosterId}
    ORDER BY r.completed_date DESC, r.id DESC
  `);
  res.json({ linked: true, records: result.rows ?? [] });
});

router.post("/my-records/:id/sign", requireAuth, requireRole("client_viewer"), async (req, res) => {
  const user = req.currentUser!;
  const id = Number(req.params.id);
  const parsed = z.object({ signature: z.string().min(1).max(500000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A signature is required" });
  if (!Number.isSafeInteger(id) || user.clientId == null || user.staffRosterId == null) {
    return res.status(404).json({ error: "Not found" });
  }
  const result = await db.execute(sql`
    SELECT id, signature IS NOT NULL AS signed FROM train_track_records
    WHERE id = ${id} AND client_id = ${user.clientId} AND staff_roster_id = ${user.staffRosterId}
    LIMIT 1
  `);
  const record = (result.rows ?? [])[0] as { id: number; signed: boolean } | undefined;
  if (!record) return res.status(404).json({ error: "Not found" });
  // A signature, once given, is the record of the sign-off and isn't replaced.
  if (record.signed) return res.status(409).json({ error: "You have already signed this record" });
  await db.execute(sql`
    UPDATE train_track_records SET signature = ${parsed.data.signature}, updated_at = now()
    WHERE id = ${id} AND client_id = ${user.clientId} AND signature IS NULL
  `);
  const updated = await db.execute(sql`
    SELECT ${OWN_RECORD_COLUMNS}
    FROM train_track_records r
    LEFT JOIN sites s ON r.site_id = s.id
    WHERE r.id = ${id} AND r.client_id = ${user.clientId}
  `);
  res.json((updated.rows ?? [])[0]);
});

// ── Create record ─────────────────────────────────────────────────────────────

router.post("/records", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const parsed = recordCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });

  const d = parsed.data;
  if ("trainingType" in d) {
    const allowedTypes = await getEffectiveOptionState(clientId, "traintrack_types");
    if (!trainingTypeIsAllowed(d.trainingType, allowedTypes)) {
      return res.status(400).json({ error: "Invalid training type" });
    }
  }
  if (!await canAccessSite(clientId, d.siteId, getActiveDepartmentId(req))) {
    return res.status(403).json({ error: "Site not accessible" });
  }
  if (!await canLinkRosterMember(clientId, d.staffRosterId, getActiveDepartmentId(req))) {
    return res.status(400).json({ error: "Staff member not found" });
  }
  const trainingType = "trainingType" in d ? d.trainingType : null;
  const documentTitle = "documentTitle" in d ? d.documentTitle : null;
  const documentType = "documentType" in d ? (d.documentType ?? null) : null;
  const provider = "provider" in d ? d.provider : null;
  const trainer = "trainer" in d ? d.trainer : null;
  const expiryDate = "expiryDate" in d ? (d.expiryDate ?? null) : null;

  const result = await db.execute(sql`
    INSERT INTO train_track_records
      (client_id, site_id, record_type, staff_name, staff_roster_id, training_type,
       document_title, document_type, provider, trainer,
       completed_date, expiry_date, notes, signature)
    VALUES
      (${clientId}, ${d.siteId ?? null}, ${d.recordType}, ${d.staffName}, ${d.staffRosterId ?? null},
       ${trainingType}, ${documentTitle}, ${documentType},
       ${provider}, ${trainer},
       ${d.completedDate}::date, ${expiryDate}::date, ${d.notes ?? null}, ${d.signature ?? null})
    RETURNING *
  `);

  res.status(201).json((result.rows ?? [])[0]);
});

// ── Update record ─────────────────────────────────────────────────────────────

router.patch("/records/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const parsed = recordUpdate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });
  const existing = await db.execute(sql`
    SELECT site_id, record_type, training_type, staff_roster_id FROM train_track_records WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  const record = (existing.rows ?? [])[0] as any;
  if (!record || !await canAccessSite(clientId, record.site_id, getActiveDepartmentId(req))) {
    return res.status(404).json({ error: "Not found" });
  }
  if (parsed.data.siteId !== undefined && !await canAccessSite(clientId, parsed.data.siteId, getActiveDepartmentId(req))) {
    return res.status(403).json({ error: "Site not accessible" });
  }
  // Re-saving an unchanged link is always allowed; a new link is validated.
  if (
    parsed.data.staffRosterId != null
    && parsed.data.staffRosterId !== record.staff_roster_id
    && !await canLinkRosterMember(clientId, parsed.data.staffRosterId, getActiveDepartmentId(req))
  ) {
    return res.status(400).json({ error: "Staff member not found" });
  }
  if (parsed.data.trainingType !== undefined) {
    if (record.record_type === "signoff" && parsed.data.trainingType !== null) {
      return res.status(400).json({ error: "Training type is not applicable to a sign-off" });
    }
    if (
      record.record_type !== "signoff"
      && parsed.data.trainingType !== record.training_type
    ) {
      if (parsed.data.trainingType === null) {
        return res.status(400).json({ error: "Training type is required" });
      }
      const allowedTypes = await getEffectiveOptionState(clientId, "traintrack_types");
      if (!trainingTypeIsAllowed(parsed.data.trainingType, allowedTypes)) {
        return res.status(400).json({ error: "Invalid training type" });
      }
    }
  }

  const {
    staffName, staffRosterId, trainingType, documentTitle, documentType, provider, trainer,
    completedDate, expiryDate, siteId, notes, signature,
  } = parsed.data;

  const hasExpiry   = expiryDate !== undefined;
  const hasSite     = siteId !== undefined;
  const hasNotes    = notes !== undefined;
  const hasDocType  = documentType !== undefined;
  const hasProvider = provider !== undefined;
  const hasTrainer  = trainer !== undefined;
  const hasDocTitle = documentTitle !== undefined;
  const hasTrainType = trainingType !== undefined;
  const hasCompleted = completedDate !== undefined;
  const hasSignature = signature !== undefined;
  const hasRosterId  = staffRosterId !== undefined;

  await db.execute(sql`
    UPDATE train_track_records
    SET staff_name     = COALESCE(${staffName ?? null}, staff_name),
        staff_roster_id = CASE WHEN ${hasRosterId}::boolean THEN ${staffRosterId ?? null}::integer ELSE staff_roster_id END,
        training_type  = CASE WHEN ${hasTrainType}::boolean  THEN ${trainingType ?? null}  ELSE training_type  END,
        document_title = CASE WHEN ${hasDocTitle}::boolean   THEN ${documentTitle ?? null} ELSE document_title END,
        document_type  = CASE WHEN ${hasDocType}::boolean    THEN ${documentType ?? null}  ELSE document_type  END,
        provider       = CASE WHEN ${hasProvider}::boolean   THEN ${provider ?? null}      ELSE provider       END,
        trainer        = CASE WHEN ${hasTrainer}::boolean     THEN ${trainer ?? null}       ELSE trainer        END,
        completed_date = CASE WHEN ${hasCompleted}::boolean
                              THEN ${completedDate ?? null}::date ELSE completed_date END,
        expiry_date    = CASE WHEN ${hasExpiry}::boolean  THEN ${expiryDate ?? null}::date  ELSE expiry_date   END,
        site_id        = CASE WHEN ${hasSite}::boolean    THEN ${siteId ?? null}            ELSE site_id       END,
        notes          = CASE WHEN ${hasNotes}::boolean   THEN ${notes ?? null}             ELSE notes         END,
        signature      = CASE WHEN ${hasSignature}::boolean THEN ${signature ?? null}       ELSE signature     END,
        updated_at     = now()
    WHERE id = ${id} AND client_id = ${clientId}
  `);

  const upd = await db.execute(sql`
    SELECT r.*, s.name AS site_name
    FROM train_track_records r
    LEFT JOIN sites s ON r.site_id = s.id
    WHERE r.id = ${id} AND r.client_id = ${clientId}
    LIMIT 1
  `);
  const row = (upd.rows ?? [])[0];
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// ── Delete record ─────────────────────────────────────────────────────────────

router.delete("/records/:id", requireAuth, denyViewers, async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });

  const id = parseInt(req.params.id as string);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
  const existing = await db.execute(sql`
    SELECT site_id FROM train_track_records WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  const record = (existing.rows ?? [])[0] as any;
  if (!record || !await canAccessSite(clientId, record.site_id, getActiveDepartmentId(req))) {
    return res.status(404).json({ error: "Not found" });
  }

  await db.execute(sql`
    DELETE FROM train_track_records
    WHERE id = ${id} AND client_id = ${clientId}
  `);
  res.status(204).end();
});

export default router;
