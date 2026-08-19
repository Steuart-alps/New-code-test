import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, requireClientAdmin, denyViewers, getClientId } from "../middleware/requireAuth";
import { UK_COMPLIANCE_GUIDANCE } from "../lib/ukComplianceGuidance";

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
    reviewedAt: "2026-08-19",
    disclaimer: "ComplyTrack helps organise evidence and actions. It does not itself certify legal compliance; obtain competent advice for your premises and jurisdiction.",
    guidance: UK_COMPLIANCE_GUIDANCE,
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
  const result = await db.execute(sql`
    SELECT id, source_track AS "sourceTrack", source_record_id AS "sourceRecordId", title, severity, status,
      owner_name AS "ownerName", due_date::text AS "dueDate", interim_control AS "interimControl",
      corrective_action AS "correctiveAction", evidence_reference AS "evidenceReference",
      verification_notes AS "verificationNotes", verified_by AS "verifiedBy", verified_at AS "verifiedAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM compliance_actions WHERE client_id = ${clientId}
    ORDER BY CASE WHEN status = 'verified' THEN 1 ELSE 0 END, due_date NULLS LAST, created_at DESC
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
  const result = await db.execute(sql`
    INSERT INTO compliance_actions (
      client_id, source_track, source_record_id, title, severity, owner_name, due_date,
      interim_control, corrective_action, evidence_reference, created_by, updated_by
    ) VALUES (
      ${clientId}, ${a.sourceTrack}, ${a.sourceRecordId ?? null}, ${a.title}, ${a.severity},
      ${a.ownerName}, ${a.dueDate ?? null}::date, ${a.interimControl ?? null},
      ${a.correctiveAction}, ${a.evidenceReference ?? null}, ${req.currentUser!.id}, ${req.currentUser!.id}
    )
    RETURNING id, source_track AS "sourceTrack", source_record_id AS "sourceRecordId", title, severity, status,
      owner_name AS "ownerName", due_date::text AS "dueDate", interim_control AS "interimControl",
      corrective_action AS "correctiveAction", evidence_reference AS "evidenceReference",
      verification_notes AS "verificationNotes", verified_by AS "verifiedBy", verified_at AS "verifiedAt",
      created_at AS "createdAt", updated_at AS "updatedAt"
  `);
  res.status(201).json(rows(result)[0]);
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
  const existingResult = await db.execute(sql`
    SELECT evidence_reference, verification_notes, status, created_by FROM compliance_actions
    WHERE id = ${id} AND client_id = ${clientId} LIMIT 1
  `);
  const existing = rows<{ evidence_reference: string | null; verification_notes: string | null; status: string; created_by: number | null }>(existingResult)[0];
  if (!existing) {
    res.status(404).json({ error: "Corrective action not found" });
    return;
  }
  if (existing.status === "verified") {
    res.status(409).json({ error: "Verified actions are immutable. Log a new corrective action if further work is needed." });
    return;
  }
  const a = parsed.data;
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