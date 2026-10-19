/**
 * TreeTrack on the phone: the inspection types, labels and the POST
 * /api/tree-track body, mirroring the web form (compliance-tracker
 * pages/tree-track.tsx). Configuration and edits stay on the website.
 */
import { isIsoDate } from './date-stepper-logic';

export const TREE_CHECK_TYPES = [
  'visual_assessment',
  'detailed_assessment',
  'post_storm',
  'remedial_works',
  'risk_assessment',
] as const;
export type TreeCheckType = (typeof TREE_CHECK_TYPES)[number];
export type TreeResult = 'pass' | 'fail';
export type TreeActionSeverity = 'monitor' | 'action_required' | 'urgent_action';
export type TreeDueStatus = 'ok' | 'due_soon' | 'overdue' | 'never';

export const TREE_CHECK_TYPE_LABELS: Record<TreeCheckType, string> = {
  visual_assessment: 'Visual tree assessment (VTA)',
  detailed_assessment: 'Detailed / close inspection',
  post_storm: 'Post-storm / adverse weather check',
  remedial_works: 'Remedial works record',
  risk_assessment: 'Tree risk assessment review',
};

export const TREE_CHECK_TYPE_HINTS: Record<TreeCheckType, string> = {
  visual_assessment: 'Routine ground-level survey. Set the inspection frequency from the tree, location, occupancy and risk assessment; higher-risk trees may need more frequent checks.',
  detailed_assessment: 'Close inspection required when anomalies (deadwood, cracks, fungal bodies, lean) are found during a VTA. May require climbing inspection or specialist assessment.',
  post_storm: 'Carry out a walk-over inspection after any storm or severe weather event to identify newly fallen branches, uprooted or leaning trees, or structural failures.',
  remedial_works: 'Record of arboricultural works carried out — crown reduction, deadwood removal, felling, stump grinding, cable bracing, etc.',
  risk_assessment: 'Detailed tree risk assessment by a competent person where indicated. It assesses likelihood of failure and consequences; obtain suitable arboricultural advice before specifying works.',
};

export const TREE_SEVERITY_LABELS: Record<TreeActionSeverity, string> = {
  monitor: 'Monitor',
  action_required: 'Action Required',
  urgent_action: 'Urgent Action',
};

export interface TreeInspection {
  id: number;
  siteId: number | null;
  checkType: string;
  checkDate: string;
  result: string;
  observationResult?: TreeResult;
  actionSeverity?: TreeActionSeverity | null;
  treeRef: string | null;
  location: string | null;
  inspector: string | null;
  followUpDate: string | null;
  notes: string | null;
}

export interface TreeStatusRow {
  checkType: string;
  frequencyDays: number;
  lastDate: string | null;
  dueDate: string | null;
  status: TreeDueStatus;
}

export function treeCheckTypeLabel(checkType: unknown): string {
  return TREE_CHECK_TYPE_LABELS[checkType as TreeCheckType] ?? String(checkType ?? '');
}

/** Pass/fail of a stored row; legacy rows kept the severity in `result`. */
export function treeObservationResult(row: Pick<TreeInspection, 'result' | 'observationResult'>): TreeResult {
  return row.observationResult ?? (row.result === 'pass' ? 'pass' : 'fail');
}

export interface TreeInspectionDraft {
  checkType: TreeCheckType;
  checkDate: string;
  result: TreeResult | null;
  actionSeverity: TreeActionSeverity | null;
  treeRef: string;
  location: string;
  inspector: string;
  followUpDate: string;
  notes: string;
  siteId: number | null;
}

export type TreeBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; title: string; message: string };

/**
 * The create body the website sends (blank text becomes null). The severity
 * applies to a failed inspection only. `today` is the device-local date.
 */
export function buildTreeInspectionBody(draft: TreeInspectionDraft, today: string): TreeBodyResult {
  if (!isIsoDate(draft.checkDate)) {
    return { ok: false, title: 'Date required', message: 'Choose the date of the inspection.' };
  }
  if (draft.checkDate > today) {
    return { ok: false, title: 'Inspection date', message: 'An inspection cannot be recorded for a future date.' };
  }
  if (draft.result === null) {
    return { ok: false, title: 'Result required', message: 'Choose Pass or Fail for this inspection.' };
  }
  const followUpDate = draft.followUpDate.trim();
  if (followUpDate && !isIsoDate(followUpDate)) {
    return { ok: false, title: 'Follow-up date', message: 'Enter the follow-up date as YYYY-MM-DD, or leave it blank.' };
  }
  const text = (value: string) => value.trim() || null;
  return {
    ok: true,
    body: {
      checkType: draft.checkType,
      checkDate: draft.checkDate,
      result: draft.result,
      actionSeverity: draft.result === 'fail' ? draft.actionSeverity : null,
      treeRef: text(draft.treeRef),
      location: text(draft.location),
      inspector: text(draft.inspector),
      followUpDate: followUpDate || null,
      siteId: draft.siteId,
      notes: text(draft.notes),
    },
  };
}

/** Whole calendar days from `today` to `iso` (both YYYY-MM-DD). */
export function calendarDaysUntil(iso: string, today: string): number {
  const days = (value: string) => {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  return Math.round(days(iso) - days(today));
}

/** e.g. "12 Oct 2026" for a YYYY-MM-DD calendar date. */
export function formatTreeDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/** The "what's due" line for one inspection type, as the website words it. */
export function treeDueText(row: TreeStatusRow, today: string): string {
  if (row.status === 'never' || !row.dueDate) return 'Not yet recorded';
  const days = calendarDaysUntil(row.dueDate, today);
  if (row.status === 'overdue') return `${Math.abs(days)}d overdue`;
  if (row.status === 'due_soon') return `Due in ${days}d`;
  return `Next ${formatTreeDate(row.dueDate)}`;
}
