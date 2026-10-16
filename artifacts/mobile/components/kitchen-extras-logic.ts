/**
 * KitchenTrack probe calibration and weekly management review on the phone:
 * the website's forms (compliance-tracker pages/kitchen-probe.tsx and
 * kitchen-weekly.tsx), same questions and the same payload shape for
 * POST /api/kitchen-weekly/probe and /weekly. Like the website these are
 * whole-business records (no site). Drafts, edits and history detail stay on
 * the website; the phone only submits a signed record.
 *
 * Import-free so tests can load it directly with Node.
 */

export type Answer = 'yes' | 'no' | 'na';

/** CookSafe house rules (website HOUSE_RULES), same keys and wording. */
export const HOUSE_RULES: { key: string; label: string; sublabel: string }[] = [
  { key: 'training', label: 'Training', sublabel: 'Have the House Rules been followed? (New staff induction, formal training, retraining)' },
  { key: 'personalHygiene', label: 'Personal Hygiene', sublabel: 'Hand washing, personal cleanliness, protective clothing, illness/exclusion rules' },
  { key: 'cleaning', label: 'Cleaning', sublabel: 'All specified equipment and areas cleaned as per schedule; cleaning chemicals used correctly' },
  { key: 'crossContamination', label: 'Cross Contamination Prevention', sublabel: 'Delivery, storage, preparation, cooking and cooling rules' },
  { key: 'pestControl', label: 'Pest Control', sublabel: 'Pest proofing, insect screens/fly-killing devices, good housekeeping' },
  { key: 'wasteControl', label: 'Waste Control', sublabel: 'Waste in food rooms and waste collection rules' },
  { key: 'maintenance', label: 'Maintenance', sublabel: 'Premises structure rules and equipment rules' },
  { key: 'stockControl', label: 'Stock Control', sublabel: 'Stock control measures followed' },
  { key: 'temperatureControl', label: 'Temperature Control', sublabel: 'Temperature control house rules followed' },
  { key: 'recordsComplete', label: 'Records', sublabel: 'All necessary temperature checks recorded using the correct forms' },
];

/** Management review questions (website REVIEW_QUESTIONS). */
export const REVIEW_QUESTIONS: { key: string; label: string }[] = [
  { key: 'safeMethodsReviewed', label: 'Have you reviewed your safe methods?' },
  { key: 'allergensUpdated', label: 'Has allergen information been updated to reflect any menu or ingredient changes?' },
  { key: 'methodsOrEquipmentChanged', label: 'Have any methods or equipment changed?' },
  { key: 'newSuppliersReviewed', label: 'Have any new suppliers been reviewed and recorded (with contact information)?' },
  { key: 'cleaningScheduleNeedsUpdate', label: 'Does the cleaning schedule require updating?' },
  { key: 'cleaningScheduleCompleted', label: 'Has the cleaning schedule been completed daily?' },
  { key: 'newStaffTrained', label: 'Have any new staff received suitable training?' },
  { key: 'staffRefresherRequired', label: 'Do any staff require refresher training?' },
  { key: 'additionalChecksRequired', label: 'Are additional opening/closing checks required?' },
  { key: 'complaintsReceived', label: 'Have any complaints been received?' },
  { key: 'complaintsInvestigated', label: 'Have complaints been investigated and, where necessary, changes made?' },
  { key: 'extraChecksCompleted', label: 'Have extra checks been completed and recorded weekly?' },
  { key: 'proveitChecksCompleted', label: "Are 'Prove It' checks being completed and regularly recorded?" },
];

export interface ProbeCheckSummary {
  id: number;
  check_date: string;
  overall_result: string | null;
  checked_by: string | null;
  submitted_at: string | null;
}

export interface ProbeCheckRecord extends ProbeCheckSummary {
  signature: string | null;
}

export interface WeeklyReviewSummary {
  id: number;
  week_commencing: string;
  submitted_at: string | null;
  manager_signature: string | null;
}

export function localDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function addDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** The Monday of the week containing this calendar date (website: weekStartsOn 1). */
export function weekCommencing(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(value, -((weekday + 6) % 7));
}

/** "dd/mm/yyyy" for a stored date or timestamp. */
export function displayDate(value: string | null | undefined): string {
  const day = value?.slice(0, 10) ?? '';
  return isCalendarDate(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : '';
}

/** The account's probe names (food safety settings, a JSON list), as the website reads them. */
export function probeNamesFromConfig(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string' && !!name.trim())
      : [];
  } catch {
    return [];
  }
}

export interface ProbeRowDraft {
  name: string;
  serialNo: string;
  iceTemp: string;
  boilingTemp: string;
  accurateIce: boolean | null;
  accurateBoiling: boolean | null;
  notes: string;
}

export const emptyProbeRow = (name = ''): ProbeRowDraft => ({
  name, serialNo: '', iceTemp: '', boilingTemp: '', accurateIce: null, accurateBoiling: null, notes: '',
});

/** One row per configured probe, or a single blank row (website defaultProbes). */
export function defaultProbeRows(names: string[]): ProbeRowDraft[] {
  return names.length ? names.map((name) => emptyProbeRow(name)) : [emptyProbeRow()];
}

/**
 * Overall result from the accuracy answers (the website's auto-compute):
 * any inaccurate reading fails; nothing answered yet leaves it unset.
 */
export function probeOverallResult(rows: ProbeRowDraft[]): 'pass' | 'fail' | '' {
  const answered = rows.some((row) => row.accurateIce !== null || row.accurateBoiling !== null);
  if (!answered) return '';
  return rows.some((row) => row.accurateIce === false || row.accurateBoiling === false) ? 'fail' : 'pass';
}

/** Whether a typed reading is within ±1°C of the target (null until it is a number). */
export function readingWithinTolerance(value: string, target: 0 | 100): boolean | null {
  const trimmed = value.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Math.abs(Number(trimmed) - target) <= 1;
}

const rowHasContent = (row: ProbeRowDraft) =>
  !!(row.name.trim() || row.serialNo.trim() || row.iceTemp.trim() || row.boilingTemp.trim() || row.notes.trim())
  || row.accurateIce !== null || row.accurateBoiling !== null;

const text = (value: string) => value.trim() || null;

export interface ProbeCheckDraft {
  checkDate: string;
  probes: ProbeRowDraft[];
  checkedBy: string;
  signature: string;
  notes: string;
}

export type KitchenPayloadResult = { ok: true; payload: Record<string, unknown> } | { ok: false; title: string; message: string };

/** The website's "Submit & Sign" payload for a probe calibration check. */
export function buildProbeCheckPayload(draft: ProbeCheckDraft, today: string, submittedAt: string): KitchenPayloadResult {
  if (!isCalendarDate(draft.checkDate) || draft.checkDate > today) {
    return { ok: false, title: 'Check the date', message: 'Choose a check date that is today or earlier.' };
  }
  const probes = draft.probes.filter(rowHasContent);
  if (!probes.length) {
    return { ok: false, title: 'Add a probe', message: 'Record at least one probe’s readings before submitting.' };
  }
  if (!draft.signature.trim()) {
    return { ok: false, title: 'Signature required to submit', message: 'Type your name to sign the probe check.' };
  }
  const overallResult = probeOverallResult(probes);
  return {
    ok: true,
    payload: {
      checkDate: draft.checkDate,
      probes: probes.map((row) => ({
        name: row.name.trim(),
        serialNo: row.serialNo.trim(),
        iceTemp: row.iceTemp.trim(),
        boilingTemp: row.boilingTemp.trim(),
        ...(row.accurateIce === null ? {} : { accurateIce: row.accurateIce }),
        ...(row.accurateBoiling === null ? {} : { accurateBoiling: row.accurateBoiling }),
        notes: row.notes.trim(),
      })),
      overallResult: overallResult || null,
      checkedBy: text(draft.checkedBy),
      checkedByRosterId: null,
      signature: draft.signature.trim(),
      notes: text(draft.notes),
      submittedAt,
    },
  };
}

export interface WeeklyReviewDraft {
  weekCommencing: string;
  checks: Record<string, Answer | undefined>;
  deviations: { rule: string; action: string }[];
  issuesThreeTimes: Answer | null;
  actionTaken: string;
  managerSignature: string;
}

// Which answer needs attention, as in lib/api-zod/src/kitchen-weekly.ts (the
// API's stored result and the website use that file; tests/kitchen-extras-logic
// checks these lists match it). Most questions: "no". These: "yes".
const YES_NEEDS_ATTENTION = ['cleaningScheduleNeedsUpdate', 'staffRefresherRequired'];
// Either answer is fine; the follow-up question carries the result.
const NEUTRAL = ['methodsOrEquipmentChanged', 'additionalChecksRequired', 'complaintsReceived'];

export function weeklyAttentionAnswer(key: string): 'yes' | 'no' | null {
  if (NEUTRAL.includes(key)) return null;
  return YES_NEEDS_ATTENTION.includes(key) ? 'yes' : 'no';
}

/** Questions whose answer needs attention (the website asks for a deviation row for these). */
export function weeklyAttentionAnswers(checks: Record<string, Answer | undefined>): string[] {
  return [...HOUSE_RULES, ...REVIEW_QUESTIONS]
    .filter((q) => { const attention = weeklyAttentionAnswer(q.key); return attention !== null && checks[q.key] === attention; })
    .map((q) => q.label);
}

export function weeklyAnsweredCount(checks: Record<string, Answer | undefined>): number {
  return [...HOUSE_RULES, ...REVIEW_QUESTIONS].filter((q) => checks[q.key]).length;
}

export const WEEKLY_QUESTION_COUNT = HOUSE_RULES.length + REVIEW_QUESTIONS.length;

/** The website's "Submit & Sign" payload for a weekly management review. */
export function buildWeeklyReviewPayload(draft: WeeklyReviewDraft, today: string, submittedAt: string): KitchenPayloadResult {
  if (!isCalendarDate(draft.weekCommencing) || draft.weekCommencing > today) {
    return { ok: false, title: 'Check the week', message: 'Choose this week or an earlier one.' };
  }
  if (!draft.managerSignature.trim()) {
    return { ok: false, title: 'Manager signature required', message: 'Type the manager or proprietor’s name to sign the review.' };
  }
  // Only answered questions: the API accepts yes / no / n/a, not blanks.
  const checks = Object.fromEntries([...HOUSE_RULES, ...REVIEW_QUESTIONS]
    .flatMap((q) => draft.checks[q.key] ? [[q.key, draft.checks[q.key]]] : []));
  const deviations = draft.deviations
    .map((row) => ({ rule: row.rule.trim(), action: row.action.trim() }))
    .filter((row) => row.rule || row.action)
    .map((row) => ({ ...(row.rule ? { rule: row.rule } : {}), ...(row.action ? { action: row.action } : {}) }));
  const additional: Record<string, string> = {};
  if (draft.issuesThreeTimes) additional.issuesThreeTimes = draft.issuesThreeTimes;
  if (draft.actionTaken.trim()) additional.actionTaken = draft.actionTaken.trim();
  return {
    ok: true,
    payload: {
      weekCommencing: draft.weekCommencing,
      checks,
      deviations,
      additional,
      managerSignature: draft.managerSignature.trim(),
      submittedAt,
    },
  };
}

/**
 * A record for this date saved on the device and still waiting to send. A
 * refused one is not counted: the outbox panel offers Retry or Remove for it.
 */
export function pendingEntryFor<T extends { state: string; body: Record<string, unknown> }>(
  entries: T[], field: 'checkDate' | 'weekCommencing', date: string,
): T | undefined {
  return entries.find((entry) => entry.state !== 'failed' && entry.body[field] === date);
}
