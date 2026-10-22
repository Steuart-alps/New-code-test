/**
 * COSHH assessment sign-offs: staff read a current COSHH assessment and sign
 * that they have understood it. This reuses TrainTrack rather than adding a
 * second training record: every sign-off writes a TrainTrack "signoff"
 * record (document type risk_assessment) for the staff roster entry, so it
 * shows in that person's training history, TrainTrack's lists and exports,
 * and the record lock, like a DocTrack acknowledgement does.
 *
 * Who must sign: active staff roster entries at the assessment's site, or
 * only those in the assessment's sign_off_departments when it names any.
 * Each sign-off is for one revision; a revised assessment (revision bumped
 * by a change to what staff read) asks everyone to sign again. A sign-off
 * whose TrainTrack record was removed no longer counts, as in DocTrack.
 */
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { recordSiteVisibleSql, siteVisibleSql } from "./departmentSites";

/** Fields that change what staff read: a change to any of them is a new revision. */
export const SIGN_OFF_CONTENT_FIELDS = [
  "siteId", "substanceId", "task", "whoAtRisk", "exposureRoutes", "howOften", "hazardStatements",
  "signalWord", "healthEffects", "exposureLimits", "controls", "ppe", "ppeDetails", "riskLevel",
  "storage", "spillProcedure", "firstAid", "disposal",
] as const;

export function signOffContentChanged(
  before: Record<(typeof SIGN_OFF_CONTENT_FIELDS)[number], unknown>,
  after: Record<(typeof SIGN_OFF_CONTENT_FIELDS)[number], unknown>,
): boolean {
  return SIGN_OFF_CONTENT_FIELDS.some((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

const rowsOf = <T>(result: unknown): T[] => ((result as { rows?: T[] }).rows ?? []);

export interface SignOffAssessment {
  id: number;
  site_id: number;
  task: string;
  product_name: string | null;
  revision: number;
  sign_off_departments: string[];
}

/** TrainTrack's title for the sign-off record. */
export function signOffTitle(assessment: Pick<SignOffAssessment, "task" | "product_name" | "revision">): string {
  const what = assessment.product_name ? `${assessment.task} (${assessment.product_name})` : assessment.task;
  return `COSHH assessment: ${what}${assessment.revision > 1 ? `, revision ${assessment.revision}` : ""}`.slice(0, 500);
}

/** Roster rows that must sign the assessment (optionally one roster id). */
function eligibleRosterSql(clientId: number, assessment: Pick<SignOffAssessment, "site_id" | "sign_off_departments">): SQL {
  const departments = assessment.sign_off_departments ?? [];
  return sql`
    sr.client_id = ${clientId} AND sr.active = true AND sr.site_id = ${assessment.site_id}
    ${departments.length
      ? sql`AND sr.department IN (${sql.join(departments.map((name) => sql`${name}`), sql`, `)})`
      : sql``}
  `;
}

/** The caller's department limits whose sign-off they can see or record. */
function callerRosterScope(departmentId: number | null): SQL {
  if (departmentId === null) return sql``;
  return sql`AND (sr.department IS NULL OR sr.department = (SELECT name FROM departments WHERE id = ${departmentId}))
    AND ${recordSiteVisibleSql(sql`sr.site_id`, departmentId)}`;
}

/** A sign-off counts while it is for the current revision and its TrainTrack record exists. */
const CURRENT_ACK = sql`(a.train_track_record_id IS NOT NULL AND tr.id IS NOT NULL)`;

const SUMMARY_COLUMNS = sql`
  a.id, a.site_id, s.name AS site_name, a.task, sub.product_name, sub.sds_object_path IS NOT NULL AS has_sds,
  a.substance_id, a.revision, a.sign_off_departments, a.assessment_date, a.assessor, a.risk_level,
  a.hazard_statements, a.signal_word, a.health_effects, a.exposure_routes, a.controls, a.ppe, a.ppe_details,
  a.storage, a.spill_procedure, a.first_aid, a.disposal, a.document_object_path IS NOT NULL AS has_document,
  a.updated_at
`;

type SummaryRow = {
  id: number; site_id: number; site_name: string | null; task: string; product_name: string | null; has_sds: boolean;
  substance_id: number | null; revision: number; sign_off_departments: string[]; assessment_date: unknown;
  assessor: string | null; risk_level: string; hazard_statements: string | null; signal_word: string | null;
  health_effects: string | null; exposure_routes: string[]; controls: string | null; ppe: string[];
  ppe_details: string | null; storage: string | null; spill_procedure: string | null; first_aid: string | null;
  disposal: string | null; has_document: boolean; updated_at: unknown;
};

/** timestamp (without time zone, stored as UTC) → ISO 8601. */
function isoStamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(" ", "T")}Z`;
}

const isoDay = (value: unknown) => (value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10));

/** What a person reads before signing. */
export function assessmentSummary(row: SummaryRow) {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    siteName: row.site_name ?? null,
    task: row.task,
    productName: row.product_name ?? null,
    substanceId: row.substance_id == null ? null : Number(row.substance_id),
    hasSafetyDataSheet: !!row.has_sds,
    hasDocument: !!row.has_document,
    revision: Number(row.revision),
    signOffDepartments: row.sign_off_departments ?? [],
    assessmentDate: isoDay(row.assessment_date),
    assessor: row.assessor ?? null,
    riskLevel: row.risk_level,
    hazardStatements: row.hazard_statements ?? null,
    signalWord: row.signal_word ?? null,
    healthEffects: row.health_effects ?? null,
    exposureRoutes: row.exposure_routes ?? [],
    controls: row.controls ?? null,
    ppe: row.ppe ?? [],
    ppeDetails: row.ppe_details ?? null,
    storage: row.storage ?? null,
    spillProcedure: row.spill_procedure ?? null,
    firstAid: row.first_aid ?? null,
    disposal: row.disposal ?? null,
  };
}

function assessmentScope(departmentId: number | null): SQL {
  return departmentId === null ? sql`` : sql`AND ${siteVisibleSql(sql`s.id`, sql`s.department_id`, departmentId)}`;
}

/**
 * Every current assessment the caller can see, with who has signed its
 * current revision and who still needs to.
 */
export async function getCoshhSignOffOverview(clientId: number, departmentId: number | null, siteId?: number | null) {
  const assessments = rowsOf<SummaryRow>(await db.execute(sql`
    SELECT ${SUMMARY_COLUMNS}
    FROM coshh_assessments a
    JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
    LEFT JOIN coshh_substances sub ON sub.id = a.substance_id AND sub.client_id = a.client_id
    WHERE a.client_id = ${clientId} AND a.deleted_at IS NULL AND a.status = 'current'
      ${siteId != null ? sql`AND a.site_id = ${siteId}` : sql``}
      ${assessmentScope(departmentId)}
    ORDER BY s.name, a.task, a.id
  `));
  if (assessments.length === 0) return [];
  const siteIds = [...new Set(assessments.map((a) => Number(a.site_id)))];
  const staff = rowsOf<{ id: number; name: string; department: string | null; site_id: number }>(await db.execute(sql`
    SELECT sr.id, sr.name, sr.department, sr.site_id FROM staff_roster sr
    WHERE sr.client_id = ${clientId} AND sr.active = true
      AND sr.site_id IN (${sql.join(siteIds.map((id) => sql`${id}`), sql`, `)})
      ${callerRosterScope(departmentId)}
    ORDER BY sr.name, sr.id
  `));
  const acks = rowsOf<{
    assessment_id: number; revision: number; staff_roster_id: number; staff_name: string;
    acknowledged_at: unknown; signed: boolean; train_track_record_id: number | null; current: boolean;
  }>(await db.execute(sql`
    SELECT a.assessment_id, a.revision, a.staff_roster_id, a.staff_name, a.acknowledged_at,
           a.signature IS NOT NULL AS signed, a.train_track_record_id, ${CURRENT_ACK} AS current
    FROM coshh_acknowledgements a
    LEFT JOIN train_track_records tr ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
    WHERE a.client_id = ${clientId}
      AND a.assessment_id IN (${sql.join(assessments.map((a) => sql`${a.id}`), sql`, `)})
  `));

  return assessments.map((row) => {
    const departments = row.sign_off_departments ?? [];
    const relevant = staff.filter((member) => Number(member.site_id) === Number(row.site_id)
      && (departments.length === 0 || (member.department != null && departments.includes(member.department))));
    const signedNow = new Map(acks
      .filter((ack) => Number(ack.assessment_id) === Number(row.id) && Number(ack.revision) === Number(row.revision) && ack.current)
      .map((ack) => [Number(ack.staff_roster_id), ack]));
    const signedEarlier = new Set(acks
      .filter((ack) => Number(ack.assessment_id) === Number(row.id) && Number(ack.revision) < Number(row.revision))
      .map((ack) => Number(ack.staff_roster_id)));
    return {
      ...assessmentSummary(row),
      staffTotal: relevant.length,
      signedCount: relevant.filter((member) => signedNow.has(Number(member.id))).length,
      signed: relevant.filter((member) => signedNow.has(Number(member.id))).map((member) => {
        const ack = signedNow.get(Number(member.id))!;
        return {
          staffRosterId: Number(member.id), name: member.name, department: member.department ?? null,
          signedAt: isoStamp(ack.acknowledged_at),
          hasSignature: !!ack.signed,
          trainTrackRecordId: ack.train_track_record_id == null ? null : Number(ack.train_track_record_id),
        };
      }),
      outstanding: relevant.filter((member) => !signedNow.has(Number(member.id))).map((member) => ({
        staffRosterId: Number(member.id), name: member.name, department: member.department ?? null,
        // Signed an earlier revision: this is a re-sign after a change.
        resign: signedEarlier.has(Number(member.id)),
      })),
    };
  });
}

/** Current assessments one roster entry must sign, and whether they have. */
export async function getMyCoshhSignOffs(clientId: number, staffRosterId: number) {
  const [member] = rowsOf<{ id: number; site_id: number | null; department: string | null }>(await db.execute(sql`
    SELECT id, site_id, department FROM staff_roster WHERE id = ${staffRosterId} AND client_id = ${clientId} AND active = true
  `));
  if (!member || member.site_id == null) return { pending: [], signed: [] };
  const rows = rowsOf<SummaryRow & { signed_at: unknown }>(await db.execute(sql`
    SELECT ${SUMMARY_COLUMNS}, ack.acknowledged_at AS signed_at
    FROM coshh_assessments a
    JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
    LEFT JOIN coshh_substances sub ON sub.id = a.substance_id AND sub.client_id = a.client_id
    LEFT JOIN LATERAL (
      SELECT ca.acknowledged_at FROM coshh_acknowledgements ca
      JOIN train_track_records tr ON tr.id = ca.train_track_record_id AND tr.client_id = ca.client_id
      WHERE ca.client_id = a.client_id AND ca.assessment_id = a.id AND ca.revision = a.revision
        AND ca.staff_roster_id = ${staffRosterId}
      LIMIT 1
    ) ack ON true
    WHERE a.client_id = ${clientId} AND a.deleted_at IS NULL AND a.status = 'current'
      AND a.site_id = ${member.site_id}
      AND (jsonb_array_length(a.sign_off_departments) = 0 OR a.sign_off_departments ? ${member.department ?? ""})
    ORDER BY a.task, a.id
  `));
  return {
    pending: rows.filter((row) => row.signed_at == null).map(assessmentSummary),
    signed: rows.filter((row) => row.signed_at != null).map((row) => ({ ...assessmentSummary(row), signedAt: isoStamp(row.signed_at) })),
  };
}

/** The assessment a sign-off is for, if current and visible to the caller. */
export async function findSignOffAssessment(clientId: number, assessmentId: number, departmentId: number | null) {
  const [row] = rowsOf<SignOffAssessment>(await db.execute(sql`
    SELECT a.id, a.site_id, a.task, sub.product_name, a.revision, a.sign_off_departments
    FROM coshh_assessments a
    JOIN sites s ON s.id = a.site_id AND s.client_id = a.client_id
    LEFT JOIN coshh_substances sub ON sub.id = a.substance_id AND sub.client_id = a.client_id
    WHERE a.id = ${assessmentId} AND a.client_id = ${clientId} AND a.deleted_at IS NULL AND a.status = 'current'
      ${assessmentScope(departmentId)}
  `));
  return row ?? null;
}

export interface SignOffEntry { staffRosterId: number; signature: string | null }

/**
 * Records sign-offs for the current revision. Entries for people who need
 * not sign it (other site or department, inactive, foreign, outside the
 * caller's department) are skipped; people already signed are left as they
 * are. Returns the roster ids newly signed.
 */
export async function recordCoshhSignOffs(params: {
  clientId: number;
  assessment: SignOffAssessment;
  entries: SignOffEntry[];
  userId: number;
  today: string;
  callerDepartmentId: number | null;
}): Promise<number[]> {
  const { clientId, assessment, userId, today } = params;
  const byRoster = new Map<number, SignOffEntry>();
  for (const entry of params.entries) if (!byRoster.has(entry.staffRosterId)) byRoster.set(entry.staffRosterId, entry);
  const rosterIds = [...byRoster.keys()].sort((a, b) => a - b);
  if (rosterIds.length === 0) return [];

  return db.transaction(async (tx) => {
    // Lock the people in id order (as DocTrack does) so a double tap or two
    // devices record one sign-off each, and overlapping batches can't deadlock.
    const eligible = rowsOf<{ id: number; name: string }>(await tx.execute(sql`
      SELECT sr.id, sr.name FROM staff_roster sr
      WHERE sr.id IN (${sql.join(rosterIds.map((id) => sql`${id}`), sql`, `)})
        AND ${eligibleRosterSql(clientId, assessment)}
        ${callerRosterScope(params.callerDepartmentId)}
      ORDER BY sr.id
      FOR UPDATE OF sr
    `));
    const signed: number[] = [];
    for (const member of eligible) {
      const rosterId = Number(member.id);
      const [existing] = rowsOf<{ id: number; current: boolean }>(await tx.execute(sql`
        SELECT a.id, ${CURRENT_ACK} AS current
        FROM coshh_acknowledgements a
        LEFT JOIN train_track_records tr ON tr.id = a.train_track_record_id AND tr.client_id = a.client_id
        WHERE a.client_id = ${clientId} AND a.assessment_id = ${assessment.id}
          AND a.revision = ${assessment.revision} AND a.staff_roster_id = ${rosterId}
        LIMIT 1
      `));
      if (existing?.current) continue;
      const signature = byRoster.get(rosterId)!.signature;
      const [record] = rowsOf<{ id: number }>(await tx.execute(sql`
        INSERT INTO train_track_records
          (client_id, site_id, record_type, staff_name, staff_roster_id, document_title, document_type,
           completed_date, notes, signature)
        VALUES
          (${clientId}, ${assessment.site_id}, 'signoff', ${member.name}, ${rosterId}, ${signOffTitle(assessment)},
           'risk_assessment', ${today}::date,
           ${`Read and signed the COSHH assessment in COSHHTrack (revision ${assessment.revision}).`}, ${signature})
        RETURNING id
      `));
      if (existing) {
        await tx.execute(sql`
          UPDATE coshh_acknowledgements
          SET staff_name = ${member.name}, signature = ${signature}, acknowledged_by = ${userId},
              train_track_record_id = ${record.id}, acknowledged_at = now()
          WHERE id = ${existing.id} AND client_id = ${clientId}
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO coshh_acknowledgements
            (client_id, assessment_id, revision, staff_roster_id, staff_name, signature, acknowledged_by, train_track_record_id)
          VALUES
            (${clientId}, ${assessment.id}, ${assessment.revision}, ${rosterId}, ${member.name}, ${signature}, ${userId}, ${record.id})
        `);
      }
      signed.push(rosterId);
    }
    return signed;
  });
}
