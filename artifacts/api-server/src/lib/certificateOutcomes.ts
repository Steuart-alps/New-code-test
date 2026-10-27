/**
 * Certificate outcomes and defects on compliance checks.
 *
 * Rules (the single source used by every place that shows a check's state):
 *  - Only a satisfactory (or legacy "not stated") certificate's expiry may move
 *    its check's due date. An unsatisfactory EICR with a five-year expiry must
 *    never turn the check green for five years.
 *  - A check NEEDS ACTION when its newest certificate (by issue date, else
 *    upload date) either
 *      * has an open C1/C2/FI/ID/AR defect: its FixTrack job is not resolved
 *        or closed (or, with no job, the defect is not marked remedied), or
 *      * is unsatisfactory and lists no C1/C2/FI/ID/AR defect to remedy.
 *    A newer satisfactory certificate replaces it as the newest and clears it.
 *  - Every defect opens a FixTrack job when the business has FixTrack
 *    (C3/"other" at low priority, and they never block the check).
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { fixTrackIssueActivityTable, fixTrackIssuesTable, type CertificateDefectCode } from "@workspace/db/schema";
import { addCalendarDays } from "./accountClock";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "execute">;

export const CERTIFICATE_OUTCOMES = ["satisfactory", "unsatisfactory", "not_stated"] as const;
export const DEFECT_CODES = ["C1", "C2", "C3", "FI", "ID", "AR", "other"] as const;
/** Codes that keep a check needing action until remedied. */
export const ACTION_DEFECT_CODES: readonly CertificateDefectCode[] = ["C1", "C2", "FI", "ID", "AR"];

export const DEFECT_LABELS: Record<CertificateDefectCode, string> = {
  C1: "Danger present",
  C2: "Potentially dangerous",
  C3: "Improvement recommended",
  FI: "Further investigation required",
  ID: "Immediately dangerous",
  AR: "At risk",
  other: "Other observation",
};

/** Outcomes whose expiry may set the check's next due date. */
export function outcomeMovesDueDate(outcome: string | null | undefined): boolean {
  return outcome !== "unsatisfactory";
}

/** FixTrack priority and target date (days from today) for a defect code. */
export function defectFixTrackPlan(code: CertificateDefectCode): { priority: "urgent" | "high" | "medium" | "low"; targetDays: number | null } {
  switch (code) {
    case "C1":
    case "ID":
      return { priority: "urgent", targetDays: 0 };
    case "C2":
    case "AR":
      return { priority: "high", targetDays: 28 };
    case "FI":
      return { priority: "medium", targetDays: 28 };
    default:
      return { priority: "low", targetDays: null };
  }
}

/** Short label for FixTrack titles, e.g. "EICR C2: …". */
export function checkLabel(itemTitle: string): string {
  if (/\bEICR\b|electrical installation/i.test(itemTitle)) return "EICR";
  if (/\bgas\b|boiler/i.test(itemTitle)) return "Gas";
  if (/\bLOLER\b|lift|hoist/i.test(itemTitle)) return "LOLER";
  const trimmed = itemTitle.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

export function fixTrackIssueTypeFor(itemTitle: string): string {
  if (/\bEICR\b|electric/i.test(itemTitle)) return "electrical";
  if (/\bgas\b|boiler/i.test(itemTitle)) return "gas";
  return "safety_hazard";
}

export type ItemActionState = {
  needsAction: boolean;
  needsActionReason: "unsatisfactory" | "open_defects" | "certificate_outstanding" | null;
  openDefectCount: number;
  latestCertificateId: number | null;
  latestCertificateOutcome: string | null;
};

export const NO_ACTION: ItemActionState = {
  needsAction: false, needsActionReason: null, openDefectCount: 0, latestCertificateId: null, latestCertificateOutcome: null,
};

/** SQL predicate: a defect row `d` (joined to fix_track_issues `f`) is open. */
const OPEN_DEFECT = sql`((f.id IS NOT NULL AND f.status NOT IN ('resolved', 'closed')) OR (f.id IS NULL AND d.resolved_at IS NULL))`;
const ACTION_CODES_SQL = sql.join(ACTION_DEFECT_CODES.map((code) => sql`${code}`), sql`, `);

/**
 * Needs-action state for a client's checks (all of them, or the given ids).
 * Items without certificates are absent from the map (use NO_ACTION).
 */
export async function itemActionStates(clientId: number, itemIds?: number[], executor: Executor = db): Promise<Map<number, ItemActionState>> {
  const result = new Map<number, ItemActionState>();
  if (itemIds && itemIds.length === 0) return result;
  const idFilter = itemIds ? sql`AND c.item_id IN (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const rows = (await executor.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (c.item_id) c.id, c.item_id, c.outcome
      FROM certificates c
      JOIN compliance_items ci ON ci.id = c.item_id AND ci.client_id = ${clientId}
      WHERE c.item_id IS NOT NULL ${idFilter}
      ORDER BY c.item_id, COALESCE(c.issue_date, c.created_at) DESC, c.id DESC
    )
    SELECT l.item_id, l.id AS certificate_id, l.outcome,
           COUNT(d.id) FILTER (WHERE d.code IN (${ACTION_CODES_SQL}))::int AS action_defects,
           COUNT(d.id) FILTER (WHERE d.code IN (${ACTION_CODES_SQL}) AND ${OPEN_DEFECT})::int AS open_defects
    FROM latest l
    LEFT JOIN certificate_defects d ON d.certificate_id = l.id AND d.client_id = ${clientId}
    LEFT JOIN fix_track_issues f ON f.id = d.fix_track_issue_id AND f.client_id = d.client_id
    GROUP BY l.item_id, l.id, l.outcome
  `)).rows as Array<{ item_id: number; certificate_id: number; outcome: string; action_defects: number; open_defects: number }>;
  for (const row of rows) {
    const openDefects = Number(row.open_defects);
    const unsatisfactory = row.outcome === "unsatisfactory";
    const needsAction = openDefects > 0 || (unsatisfactory && Number(row.action_defects) === 0);
    result.set(Number(row.item_id), {
      needsAction,
      needsActionReason: needsAction ? (unsatisfactory ? "unsatisfactory" : "open_defects") : null,
      openDefectCount: openDefects,
      latestCertificateId: Number(row.certificate_id),
      latestCertificateOutcome: row.outcome,
    });
  }
  // A contractor visit with no certificate since: not compliant until it is
  // uploaded (the defect reasons above come first).
  for (const itemId of await certificateOutstandingItemIds(clientId, itemIds, executor)) {
    const state = result.get(itemId) ?? NO_ACTION;
    if (state.needsAction) continue;
    result.set(itemId, { ...state, needsAction: true, needsActionReason: "certificate_outstanding" });
  }
  return result;
}

/**
 * Checks whose contractor visit has happened (the check was completed, or the
 * date the contractor booked has passed) with no certificate added on or
 * after the visit day, or dated on or after it. The same rule as the
 * certificate chase (lib/certificateFollowUp.ts), from the visit day on.
 */
export async function certificateOutstandingItemIds(clientId: number, itemIds?: number[], executor: Executor = db): Promise<number[]> {
  const idFilter = itemIds ? sql`AND ci.id IN (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const rows = (await executor.execute(sql`
    SELECT v.item_id FROM (
      SELECT ci.id AS item_id,
        GREATEST(
          (ci.completed_at AT TIME ZONE 'UTC')::date,
          CASE WHEN (ci.visit_scheduled_at AT TIME ZONE 'UTC')::date <= CURRENT_DATE
            THEN (ci.visit_scheduled_at AT TIME ZONE 'UTC')::date END
        ) AS visit_day
      FROM compliance_items ci
      WHERE ci.client_id = ${clientId} AND ci.contractor_id IS NOT NULL
        AND (ci.completed_at IS NOT NULL OR ci.visit_scheduled_at IS NOT NULL) ${idFilter}
    ) v
    WHERE v.visit_day IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM certificates c
        WHERE c.item_id = v.item_id
          AND ((c.created_at AT TIME ZONE 'UTC')::date >= v.visit_day
            OR (c.issue_date AT TIME ZONE 'UTC')::date >= v.visit_day)
      )
  `)).rows as Array<{ item_id: number }>;
  return rows.map((row) => Number(row.item_id));
}

export async function itemActionState(clientId: number, itemId: number): Promise<ItemActionState> {
  return (await itemActionStates(clientId, [itemId])).get(itemId) ?? NO_ACTION;
}

/** Human summary used by the calendar, inspection pack and badges. */
export function actionStateLabel(state: ItemActionState): string {
  if (state.needsActionReason === "certificate_outstanding") return "Certificate outstanding";
  return state.needsActionReason === "unsatisfactory"
    ? "Unsatisfactory — remedial work open"
    : `Remedial work open (${state.openDefectCount} defect${state.openDefectCount === 1 ? "" : "s"})`;
}

export type DefectInput = { code: CertificateDefectCode; description: string; location?: string | null };

/**
 * Insert a defect and, when FixTrack is available, its FixTrack job (plus the
 * "reported" activity row, as module actions do). Runs inside the caller's
 * transaction; every row is written for the item's own client.
 */
export async function createDefect(tx: Tx, input: {
  clientId: number;
  certificate: { id: number; name: string };
  item: { id: number; title: string; siteId: number | null };
  defect: DefectInput;
  fixTrack: { enabled: boolean; issueType?: string };
  user: { id: number; name: string | null };
  today: string;
  /** Set (a job id, or null for none) when the caller has already decided the
   *  defect's job, as with one remedial job for a certificate. */
  job?: number | null;
}) {
  const { clientId, certificate, item, defect, user, today } = input;
  let fixTrackIssueId: number | null = input.job ?? null;
  if (input.job === undefined && input.fixTrack.enabled) {
    const plan = defectFixTrackPlan(defect.code);
    const siteName = await itemSiteName(tx, clientId, item.siteId);
    const codeLabel = defect.code === "other" ? "Observation" : defect.code;
    const title = `${checkLabel(item.title)} ${codeLabel}: ${defect.description}`.slice(0, 300);
    const [issue] = await tx.insert(fixTrackIssuesTable).values({
      clientId,
      siteId: item.siteId,
      title,
      issueType: input.fixTrack.issueType ?? fixTrackIssueTypeFor(item.title),
      location: (defect.location?.trim() || siteName || "See compliance check").slice(0, 300),
      description: [
        `${defect.code === "other" ? "Observation" : `${defect.code} (${DEFECT_LABELS[defect.code]})`}: ${defect.description}`,
        defect.location?.trim() ? `Location: ${defect.location.trim()}` : null,
        `Recorded on certificate "${certificate.name}" for compliance check "${item.title}".`,
        `Compliance check: ${item.id}; certificate: ${certificate.id}.`,
      ].filter(Boolean).join("\n").slice(0, 5000),
      priority: plan.priority,
      status: "reported",
      reportedBy: user.name?.trim() || "ComplyTrack",
      reportedDate: today,
      targetDate: plan.targetDays == null ? null : addCalendarDays(today, plan.targetDays),
      createdBy: user.id,
    }).returning({ id: fixTrackIssuesTable.id });
    await tx.insert(fixTrackIssueActivityTable).values({ clientId, issueId: issue!.id, eventType: "status", status: "reported", createdBy: user.id });
    fixTrackIssueId = issue!.id;
  }
  const [row] = (await tx.execute(sql`
    INSERT INTO certificate_defects (certificate_id, client_id, code, description, location, fix_track_issue_id)
    VALUES (${certificate.id}, ${clientId}, ${defect.code}, ${defect.description}, ${defect.location?.trim() || null}, ${fixTrackIssueId})
    RETURNING id
  `)).rows as Array<{ id: number }>;
  return { id: Number(row!.id), fixTrackIssueId };
}

async function itemSiteName(tx: Tx, clientId: number, siteId: number | null): Promise<string | null> {
  if (siteId == null) return null;
  const [site] = (await tx.execute(sql`SELECT name FROM sites WHERE id = ${siteId} AND client_id = ${clientId} LIMIT 1`)).rows as Array<{ name: string }>;
  return site?.name ?? null;
}

const PRIORITY_ORDER = ["urgent", "high", "medium", "low"] as const;

/**
 * One FixTrack job for all the remedial work on a certificate (the AI
 * certificate reader's way, so one quote request covers it): the most urgent
 * defect sets its priority and target date, and the description lists every
 * item. Returns the job's id; the caller links the defects to it.
 */
export async function createRemedialJob(tx: Tx, input: {
  clientId: number;
  certificate: { id: number; name: string };
  item: { id: number; title: string; siteId: number | null };
  defects: DefectInput[];
  issueType?: string;
  user: { id: number; name: string | null };
  today: string;
}): Promise<number> {
  const { clientId, certificate, item, defects, user, today } = input;
  const plans = defects.map((defect) => defectFixTrackPlan(defect.code));
  const priority = PRIORITY_ORDER.find((p) => plans.some((plan) => plan.priority === p)) ?? "medium";
  const targets = plans.map((plan) => plan.targetDays).filter((days): days is number => days != null);
  const codeSummary = [...ACTION_DEFECT_CODES, "C3", "other"]
    .map((code) => [code, defects.filter((defect) => defect.code === code).length] as const)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${count} × ${code}`)
    .join(", ");
  const siteName = await itemSiteName(tx, clientId, item.siteId);
  const lines = defects.map((defect, index) => [
    `${index + 1}. ${defect.code === "other" ? "Remedial work" : `${defect.code} (${DEFECT_LABELS[defect.code]})`}: ${defect.description}`,
    defect.location?.trim() ? ` (${defect.location.trim()})` : "",
  ].join(""));
  const [issue] = await tx.insert(fixTrackIssuesTable).values({
    clientId,
    siteId: item.siteId,
    title: `${checkLabel(item.title)} remedial work: ${codeSummary}`.slice(0, 300),
    issueType: input.issueType ?? fixTrackIssueTypeFor(item.title),
    location: (siteName || "See compliance check").slice(0, 300),
    description: [
      `Remedial work from certificate "${certificate.name}" for compliance check "${item.title}":`,
      ...lines,
      "",
      `Compliance check: ${item.id}; certificate: ${certificate.id}.`,
    ].join("\n").slice(0, 5000),
    priority,
    status: "reported",
    reportedBy: user.name?.trim() || "ComplyTrack",
    reportedDate: today,
    targetDate: targets.length ? addCalendarDays(today, Math.min(...targets)) : null,
    createdBy: user.id,
  }).returning({ id: fixTrackIssuesTable.id });
  await tx.insert(fixTrackIssueActivityTable).values({ clientId, issueId: issue!.id, eventType: "status", status: "reported", createdBy: user.id });
  return issue!.id;
}

export type DefectView = {
  id: number;
  certificateId: number;
  code: CertificateDefectCode;
  label: string;
  description: string;
  location: string | null;
  fixTrackIssueId: number | null;
  fixTrackStatus: string | null;
  fixTrackPriority: string | null;
  fixTrackTargetDate: string | null;
  resolvedAt: string | null;
  blocking: boolean;
  open: boolean;
  createdAt: string;
};

/** Defects for the given certificates of one client, with their job state. */
export async function defectsForCertificates(clientId: number, certificateIds: number[], executor: Executor = db): Promise<Map<number, DefectView[]>> {
  const out = new Map<number, DefectView[]>();
  if (!certificateIds.length) return out;
  const rows = (await executor.execute(sql`
    SELECT d.id, d.certificate_id, d.code, d.description, d.location, d.fix_track_issue_id,
           d.resolved_at, d.created_at, f.id AS issue_id, f.status AS issue_status, f.priority AS issue_priority,
           f.target_date::text AS issue_target_date, ${OPEN_DEFECT} AS open
    FROM certificate_defects d
    LEFT JOIN fix_track_issues f ON f.id = d.fix_track_issue_id AND f.client_id = d.client_id
    WHERE d.client_id = ${clientId}
      AND d.certificate_id IN (${sql.join(certificateIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY d.id
  `)).rows as Array<Record<string, any>>;
  for (const row of rows) {
    const code = row.code as CertificateDefectCode;
    const view: DefectView = {
      id: Number(row.id),
      certificateId: Number(row.certificate_id),
      code,
      label: DEFECT_LABELS[code] ?? code,
      description: row.description,
      location: row.location ?? null,
      fixTrackIssueId: row.issue_id == null ? null : Number(row.issue_id),
      fixTrackStatus: row.issue_status ?? null,
      fixTrackPriority: row.issue_priority ?? null,
      fixTrackTargetDate: row.issue_target_date ?? null,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
      blocking: ACTION_DEFECT_CODES.includes(code),
      open: row.open === true,
      createdAt: new Date(row.created_at).toISOString(),
    };
    const list = out.get(view.certificateId) ?? [];
    list.push(view);
    out.set(view.certificateId, list);
  }
  return out;
}
