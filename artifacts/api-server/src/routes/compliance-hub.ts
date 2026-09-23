import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, requireClientAdmin, denyViewers, getClientId } from "../middleware/requireAuth";
import { getActiveDepartmentId } from "../middleware/requireAuth";
import { GUIDANCE_REVIEWED_AT, UK_COMPLIANCE_GAPS, UK_COMPLIANCE_GUIDANCE } from "../lib/ukComplianceGuidance";

const router: IRouter = Router();

const ProfileBody = z.object({
  nation: z.enum(["england", "wales", "scotland", "northern_ireland", "multi_nation"]),
  operationType: z.string().trim().min(2).max(160),
  responsiblePersonName: z.string().trim().min(2).max(160),
  responsiblePersonRole: z.string().trim().min(2).max(160),
  responsiblePersonEmail: z.string().trim().email().optional().nullable(),
  competentAppointments: z.array(z.object({
    area: z.string().trim().min(2).max(100),
    person: z.string().trim().min(2).max(160),
    evidence: z.string().trim().max(500).optional().nullable(),
  })).max(30).default([]),
  reviewCadence: z.string().trim().min(2).max(100),
  nextReviewDate: z.string().date(),
  haccpSystemReviewed: z.boolean().default(false),
  waterWrittenSchemeReference: z.string().trim().max(1000).optional().nullable(),
});

const ActionBody = z.object({
  sourceTrack: z.string().trim().min(2).max(80),
  sourceRecordId: z.string().trim().max(100).optional().nullable(),
  title: z.string().trim().min(3).max(240),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  ownerName: z.string().trim().min(2).max(160),
  dueDate: z.string().date().optional().nullable(),
  interimControl: z.string().trim().max(4000).optional().nullable(),
  correctiveAction: z.string().trim().min(3).max(4000),
  evidenceReference: z.string().trim().max(1000).optional().nullable(),
});

const ActionUpdateBody = ActionBody.partial().extend({
  status: z.enum(["open", "in_progress", "awaiting_verification", "verified"]).optional(),
  verificationNotes: z.string().trim().max(4000).optional().nullable(),
});

function clientOrError(req: Parameters<typeof getClientId>[0], res: any): number | null {
  const clientId = getClientId(req);
  if (!clientId) {
    res.status(400).json({ error: "No client context" });
    return null;
  }
  return clientId;
}

function rows<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []);
}

router.get("/compliance-hub/guidance", requireAuth, async (_req, res): Promise<void> => {
  res.json({
    reviewedAt: GUIDANCE_REVIEWED_AT,
    disclaimer: "ComplyTrack helps organise evidence and actions. It does not itself certify legal compliance; obtain competent advice for your premises and jurisdiction.",
    guidance: UK_COMPLIANCE_GUIDANCE,
    gaps: UK_COMPLIANCE_GAPS,
  });
});

router.get("/compliance-hub/profile", requireAuth, async (req, res): Promise<void> => {
  const clientId = clientOrError(req, res);
  if (!clientId) return;
  const result = await db.execute(sql`
    SELECT nation, operation_type AS "operationType", responsible_person_name AS "responsiblePersonName",
      responsible_person_role AS "responsiblePersonRole", responsible_person_email AS "responsiblePersonEmail",
      competent_appointments AS "competentAppointments", review_cadence AS "reviewCadence",
      next_review_date::text AS "nextReviewDate", haccp_system_reviewed AS "haccpSystemReviewed",
      water_written_scheme_reference AS "waterWrittenSchemeReference",
      updated_at AS "updatedAt"
    FROM compliance_profiles WHERE client_id = ${clientId} LIMIT 1
  `);
  res.json(rows<Record<string, unknown>>(result)[0] ?? null);
});

router.put("/compliance-hub/profile", requireAuth, requireClientAdmin, async (req, res): Promise<void> => {
  const clientId = clientOrError(req, res);
  if (!clientId) return;
  const parsed = ProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const p = parsed.data;
  const result = await db.execute(sql`
    INSERT INTO compliance_profiles (
      client_id, nation, operation_type, responsible_person_name, responsible_person_role,
      responsible_person_email, competent_appointments, review_cadence, next_review_date,
      haccp_system_reviewed, water_written_scheme_reference, updated_by, updated_at
    ) VALUES (
      ${clientId}, ${p.nation}, ${p.operationType}, ${p.responsiblePersonName}, ${p.responsiblePersonRole},
      ${p.responsiblePersonEmail ?? null}, ${JSON.stringify(p.competentAppointments)}::jsonb, ${p.reviewCadence},
      ${p.nextReviewDate}::date, ${p.haccpSystemReviewed}, ${p.waterWrittenSchemeReference ?? null}, ${req.currentUser!.id}, now()
    )
    ON CONFLICT (client_id) DO UPDATE SET
      nation = EXCLUDED.nation, operation_type = EXCLUDED.operation_type,
      responsible_person_name = EXCLUDED.responsible_person_name, responsible_person_role = EXCLUDED.responsible_person_role,
      responsible_person_email = EXCLUDED.responsible_person_email, competent_appointments = EXCLUDED.competent_appointments,
      review_cadence = EXCLUDED.review_cadence, next_review_date = EXCLUDED.next_review_date,
      haccp_system_reviewed = EXCLUDED.haccp_system_reviewed, water_written_scheme_reference = EXCLUDED.water_written_scheme_reference,
      updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING nation, operation_type AS "operationType", responsible_person_name AS "responsiblePersonName",
      responsible_person_role AS "responsiblePersonRole", responsible_person_email AS "responsiblePersonEmail",
      competent_appointments AS "competentAppointments", review_cadence AS "reviewCadence",
      next_review_date::text AS "nextReviewDate", haccp_system_reviewed AS "haccpSystemReviewed",
      water_written_scheme_reference AS "waterWrittenSchemeReference", updated_at AS "updatedAt"
  `);
  res.json(rows(result)[0]);
});

router.get("/compliance-hub/actions", requireAuth, async (req, res): Promise<void> => {
  const clientId = clientOrError(req, res);
  if (!clientId) return;
  const departmentId = getActiveDepartmentId(req);
  const result = await db.execute(sql`
    SELECT a.id, a.source_track AS "sourceTrack", a.source_record_id AS "sourceRecordId", a.title, a.severity, a.status,
      a.owner_name AS "ownerName", a.due_date::text AS "dueDate", a.interim_control AS "interimControl",
      a.corrective_action AS "correctiveAction", a.evidence_reference AS "evidenceReference",
      a.verification_notes AS "verificationNotes", a.verified_by AS "verifiedBy", a.verified_at AS "verifiedAt",
      a.created_at AS "createdAt", a.updated_at AS "updatedAt"
    FROM compliance_actions a WHERE a.client_id = ${clientId}
      AND (${departmentId}::integer IS NULL OR a.source_track <> 'IncidentTrack' OR EXISTS (
        SELECT 1 FROM incidents i LEFT JOIN sites s ON s.id = i.site_id AND s.client_id = i.client_id
        WHERE i.client_id = a.client_id AND i.id::text = a.source_record_id
          AND (${departmentId}::integer IS NULL OR i.site_id IS NULL OR
            (s.id IS NOT NULL AND (s.department_id IS NULL OR s.department_id = ${departmentId})))
      ))
    ORDER BY CASE WHEN a.status = 'verified' THEN 1 ELSE 0 END, a.due_date NULLS LAST, a.created_at DESC
  `);
  res.json(rows(result));
});

router.post("/compliance-hub/actions", requireAuth, denyViewers, async (req, res): Promise<void> => {
  const clientId = clientOrError(req, res);
  if (!clientId) return;
  const parsed = ActionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const a = parsed.data;
  const incidentId = a.sourceTrack === "IncidentTrack" ? Number(a.sourceRecordId) : null;
  if (a.sourceTrack === "IncidentTrack" && (!Number.isSafeInteger(incidentId) || !incidentId || incidentId < 1)) {
    res.status(400).json({ error: "A valid incident is required" });
    return;
  }
  const departmentId = getActiveDepartmentId(req);
  const inserted = await db.transaction(async tx => {
    if (incidentId !== null) {
      // Closing an incident updates (and locks) this same row. Holding its lock
      // through the insert prevents a new unverified action racing with closure.
      const incident = await tx.execute(sql`
        SELECT i.status FROM incidents i LEFT JOIN sites s ON s.id = i.site_id
        WHERE i.client_id = ${clientId} AND i.id = ${incidentId}
          AND (${departmentId}::integer IS NULL OR i.site_id IS NULL OR
            (s.id IS NOT NULL AND (s.department_id IS NULL OR s.department_id = ${departmentId})))
        FOR UPDATE OF i
      `);
      if (!incident.rows.length || incident.rows[0].status === "closed") return null;
    }
    const result = await tx.execute(sql`
      INSERT INTO compliance_actions (
        client_id, source_track, source_record_id, title, severity, owner_name, due_date,
        interim_control, corrective_action, evidence_reference, created_by, updated_by
      ) VALUES (
        ${clientId}, ${a.sourceTrack}, ${incidentId !== null ? String(incidentId) : a.sourceRecordId ?? null}, ${a.title}, ${a.severity},
        ${a.ownerName}, ${a.dueDate ?? null}::date, ${a.interimControl ?? null},
        ${a.correctiveAction}, ${a.evidenceReference ?? null}, ${req.currentUser!.id}, ${req.currentUser!.id}
      )
      RETURNING id, source_track AS "sourceTrack", source_record_id AS "sourceRecordId", title, severity, status,
        owner_name AS "ownerName", due_date::text AS "dueDate", interim_control AS "interimControl",
        corrective_action AS "correctiveAction", evidence_reference AS "evidenceReference",
        verification_notes AS "verificationNotes", verified_by AS "verifiedBy", verified_at AS "verifiedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
    `);
    return rows(result)[0];
  });
  if (!inserted) {
    res.status(404).json({ error: "Incident not found, closed, or inaccessible; reopen it before linking a new action" });
    return;
  }
  res.status(201).json(inserted);
});

router.patch("/compliance-hub/actions/:id", requireAuth, denyViewers, async (req, res): Promise<void> => {
  const clientId = clientOrError(req, res);
  if (!clientId) return;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid action id" });
    return;
  }
  const parsed = ActionUpdateBody.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "Provide valid fields to update" });
    return;
  }
  const departmentId = getActiveDepartmentId(req);
  const existingResult = await db.execute(sql`
    SELECT a.evidence_reference, a.verification_notes, a.status, a.created_by, a.source_track, a.source_record_id FROM compliance_actions a
    WHERE a.id = ${id} AND a.client_id = ${clientId}
      AND (a.source_track <> 'IncidentTrack' OR EXISTS (
        SELECT 1 FROM incidents i LEFT JOIN sites s ON s.id = i.site_id AND s.client_id = i.client_id
        WHERE i.client_id = a.client_id AND i.id::text = a.source_record_id
          AND (${departmentId}::integer IS NULL OR i.site_id IS NULL OR
            (s.id IS NOT NULL AND (s.department_id IS NULL OR s.department_id = ${departmentId})))
      )) LIMIT 1
  `);
  const existing = rows<{ evidence_reference: string | null; verification_notes: string | null; status: string; created_by: number | null; source_track: string; source_record_id: string | null }>(existingResult)[0];
  if (!existing) {
    res.status(404).json({ error: "Corrective action not found" });
    return;
  }
  if (existing.status === "verified") {
    res.status(409).json({ error: "Verified actions are immutable. Log a new corrective action if further work is needed." });
    return;
  }
  const a = parsed.data;
  if ((existing.source_track === "IncidentTrack" &&
    (a.sourceTrack !== undefined && a.sourceTrack !== existing.source_track ||
      a.sourceRecordId !== undefined && a.sourceRecordId !== existing.source_record_id)) ||
    (existing.source_track !== "IncidentTrack" && a.sourceTrack === "IncidentTrack")) {
    res.status(409).json({ error: "Incident action links are established at creation and cannot be reassigned" });
    return;
  }
  const evidence = a.evidenceReference === undefined ? existing.evidence_reference : a.evidenceReference;
  const verification = a.verificationNotes === undefined ? existing.verification_notes : a.verificationNotes;
  if (a.status === "verified" && (!evidence || !verification)) {
    res.status(400).json({ error: "Evidence reference and verification notes are required before an action can be verified closed." });
    return;
  }
  if (a.status === "verified" && (existing.status !== "awaiting_verification" || req.currentUser!.role === "client_staff" || existing.created_by === req.currentUser!.id)) {
    res.status(403).json({ error: "Only a different client admin or consultant may verify an action after it is awaiting verification." });
    return;
  }
  const result = await db.execute(sql`
    UPDATE compliance_actions SET
      source_track = COALESCE(${a.sourceTrack ?? null}, source_track),
      source_record_id = CASE WHEN ${a.sourceRecordId === undefined} THEN source_record_id ELSE ${a.sourceRecordId ?? null} END,
      title = COALESCE(${a.title ?? null}, title), severity = COALESCE(${a.severity ?? null}, severity),
      owner_name = COALESCE(${a.ownerName ?? null}, owner_name),
      due_date = CASE WHEN ${a.dueDate === undefined} THEN due_date ELSE ${a.dueDate ?? null}::date END,
      interim_control = CASE WHEN ${a.interimControl === undefined} THEN interim_control ELSE ${a.interimControl ?? null} END,
      corrective_action = COALESCE(${a.correctiveAction ?? null}, corrective_action),
      evidence_reference = CASE WHEN ${a.evidenceReference === undefined} THEN evidence_reference ELSE NULLIF(btrim(${a.evidenceReference ?? ""}), '') END,
      verification_notes = CASE WHEN ${a.verificationNotes === undefined} THEN verification_notes ELSE ${a.verificationNotes ?? null} END,
      status = COALESCE(${a.status ?? null}, status),
      verified_by = CASE WHEN ${a.status === "verified"} THEN ${req.currentUser!.id} ELSE verified_by END,
      verified_at = CASE WHEN ${a.status === "verified"} THEN now() ELSE verified_at END,
      updated_by = ${req.currentUser!.id}, updated_at = now()
    WHERE id = ${id}
      AND client_id = ${clientId}
      AND status <> 'verified'
      AND (source_track <> 'IncidentTrack' OR EXISTS (
        SELECT 1 FROM incidents i LEFT JOIN sites s ON s.id = i.site_id AND s.client_id = i.client_id
        WHERE i.client_id = ${clientId} AND i.id::text = compliance_actions.source_record_id
          AND (${departmentId}::integer IS NULL OR i.site_id IS NULL OR
            (s.id IS NOT NULL AND (s.department_id IS NULL OR s.department_id = ${departmentId})))
      ))
      AND (${a.status === "verified"} = false OR status = 'awaiting_verification')
      AND (${a.status === "verified"} = false OR NULLIF(btrim(evidence_reference), '') IS NOT NULL)
    RETURNING id, source_track AS "sourceTrack", source_record_id AS "sourceRecordId", title, severity, status,
      owner_name AS "ownerName", due_date::text AS "dueDate", interim_control AS "interimControl",
      corrective_action AS "correctiveAction", evidence_reference AS "evidenceReference",
      verification_notes AS "verificationNotes", verified_by AS "verifiedBy", verified_at AS "verifiedAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
  `);
  const updated = rows(result)[0];
  if (!updated) {
    res.status(409).json({ error: "This action changed while it was being updated. Reload it before making another change." });
    return;
  }
  res.json(updated);
});

export default router;