/**
 * AquaTrack lifeguard surveillance checks, first-aid equipment checks and pool
 * incidents on the phone: the website's forms (compliance-tracker
 * pages/aqua-track.tsx), same fields and payloads for POST
 * /api/swim-track/surveillance, /first-aid and /incidents. Edits, deletes and
 * outcomes recorded later stay on the website.
 *
 * Every value is checked here before anything is saved on the device: a bad
 * date or time would fail in the database after the record was queued.
 *
 * Import-free so tests can load it directly with Node.
 */

export interface SurveillanceCheck {
  id: number;
  check_date: string;
  check_time: string | null;
  bather_count: number | null;
  scan_completed: boolean;
  observations: string | null;
  checked_by: string | null;
  result: string;
}

export interface FirstAidCheck {
  id: number;
  check_date: string;
  aed_ok: boolean;
  first_aid_kit_ok: boolean;
  rescue_pole_ok: boolean;
  throw_bag_ok: boolean;
  spine_board_ok: boolean;
  ring_buoy_ok: boolean;
  oxygen_kit_ok: boolean;
  checked_by: string | null;
  defects_found: string | null;
  notes: string | null;
  result: string;
}

export interface PoolIncident {
  id: number;
  incident_date: string;
  incident_time: string | null;
  incident_type: string;
  severity: string;
  persons_involved: string | null;
  description: string;
  action_taken: string | null;
  outcome: string | null;
}

export const FIRST_AID_ITEMS = [
  { key: 'aedOk', column: 'aed_ok', label: 'AED / defibrillator' },
  { key: 'firstAidKitOk', column: 'first_aid_kit_ok', label: 'First-aid kit' },
  { key: 'rescuePoleOk', column: 'rescue_pole_ok', label: 'Rescue pole' },
  { key: 'throwBagOk', column: 'throw_bag_ok', label: 'Throw bag / rope' },
  { key: 'spineBoardOk', column: 'spine_board_ok', label: 'Spine board' },
  { key: 'ringBuoyOk', column: 'ring_buoy_ok', label: 'Ring buoy' },
  { key: 'oxygenKitOk', column: 'oxygen_kit_ok', label: 'Oxygen kit' },
] as const;
export type FirstAidItemKey = (typeof FIRST_AID_ITEMS)[number]['key'];
export type FirstAidItems = Record<FirstAidItemKey, boolean>;

export const INCIDENT_TYPES = [
  { value: 'near_miss', label: 'Near miss' },
  { value: 'minor_injury', label: 'Minor injury' },
  { value: 'major_injury', label: 'Major injury' },
  { value: 'drowning_rescue', label: 'Drowning / rescue' },
  { value: 'pool_evacuation', label: 'Pool evacuation' },
  { value: 'medical', label: 'Medical emergency' },
  { value: 'other', label: 'Other' },
] as const;
export const INCIDENT_SEVERITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
] as const;

export const incidentTypeLabel = (value: string) => INCIDENT_TYPES.find((type) => type.value === value)?.label ?? value;
export const severityLabel = (value: string) => INCIDENT_SEVERITIES.find((item) => item.value === value)?.label ?? value;

const NAME_MAX = 200;
const TEXT_MAX = 2000;

export type BuildResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; title: string; error: string };

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const textOrNull = (value: string) => value.trim() || null;
const fail = (title: string, error: string): BuildResult => ({ ok: false, title, error });

function tooLong(names: string[], texts: string[]): boolean {
  return names.some((value) => value.trim().length > NAME_MAX) || texts.some((value) => value.trim().length > TEXT_MAX);
}
const TOO_LONG = fail('Text is too long', 'Names must be 200 characters or fewer and notes 2,000 or fewer.');

export interface SurveillanceForm {
  checkDate: string;
  checkTime: string;
  batherCount: string;
  scanCompleted: boolean;
  observations: string;
  checkedBy: string;
}

/** POST /api/swim-track/surveillance, as the website's "Log surveillance check". */
export function buildSurveillancePayload(form: SurveillanceForm, siteId: number): BuildResult {
  if (!isCalendarDate(form.checkDate)) return fail('Check the date', 'Enter a real calendar date as YYYY-MM-DD.');
  const checkTime = form.checkTime.trim();
  if (checkTime && !isTime(checkTime)) return fail('Check the time', 'Enter the local time as HH:MM, or leave it blank.');
  let batherCount: number | null = null;
  if (form.batherCount.trim()) {
    batherCount = Number(form.batherCount.trim());
    if (!Number.isSafeInteger(batherCount) || batherCount < 0 || batherCount > 100_000) {
      return fail('Check the bather count', 'Bather count must be a whole number of 0 or more.');
    }
  }
  if (tooLong([form.checkedBy], [form.observations])) return TOO_LONG;
  return {
    ok: true,
    payload: {
      siteId,
      checkDate: form.checkDate,
      checkTime: checkTime || null,
      batherCount,
      scanCompleted: form.scanCompleted,
      observations: textOrNull(form.observations),
      checkedBy: textOrNull(form.checkedBy),
      result: form.scanCompleted ? 'pass' : 'fail',
    },
  };
}

export const allFirstAidItemsOk = (): FirstAidItems =>
  Object.fromEntries(FIRST_AID_ITEMS.map((item) => [item.key, true])) as FirstAidItems;

/** The server's result: any item not ready fails the check (and raises an action). */
export function firstAidResult(items: FirstAidItems): 'pass' | 'fail' {
  return FIRST_AID_ITEMS.every((item) => items[item.key] !== false) ? 'pass' : 'fail';
}

export interface FirstAidForm {
  checkDate: string;
  items: FirstAidItems;
  checkedBy: string;
  defectsFound: string;
  notes: string;
}

/** POST /api/swim-track/first-aid, as the website's "First-aid readiness check". */
export function buildFirstAidPayload(form: FirstAidForm, siteId: number): BuildResult {
  if (!isCalendarDate(form.checkDate)) return fail('Check the date', 'Enter a real calendar date as YYYY-MM-DD.');
  if (tooLong([form.checkedBy], [form.defectsFound, form.notes])) return TOO_LONG;
  return {
    ok: true,
    payload: {
      siteId,
      checkDate: form.checkDate,
      checkedBy: textOrNull(form.checkedBy),
      defectsFound: textOrNull(form.defectsFound),
      notes: textOrNull(form.notes),
      ...Object.fromEntries(FIRST_AID_ITEMS.map((item) => [item.key, form.items[item.key] !== false])),
    },
  };
}

export interface IncidentForm {
  incidentDate: string;
  incidentTime: string;
  incidentType: string;
  severity: string;
  personsInvolved: string;
  description: string;
  actionTaken: string;
  reportedTo: string;
  reportedDate: string;
  outcome: string;
  notes: string;
}

/** POST /api/swim-track/incidents, as the website's "Log incident / near miss". */
export function buildIncidentPayload(form: IncidentForm, siteId: number): BuildResult {
  if (!isCalendarDate(form.incidentDate)) return fail('Check the date', 'Enter the incident date as YYYY-MM-DD.');
  const incidentTime = form.incidentTime.trim();
  if (incidentTime && !isTime(incidentTime)) return fail('Check the time', 'Enter the time as HH:MM, or leave it blank.');
  if (!INCIDENT_TYPES.some((type) => type.value === form.incidentType)) return fail('Choose a type', 'Select the type of incident.');
  if (!INCIDENT_SEVERITIES.some((item) => item.value === form.severity)) return fail('Choose a severity', 'Select the severity.');
  if (!form.description.trim()) return fail('Description required', 'Describe what happened.');
  const reportedDate = form.reportedDate.trim();
  if (reportedDate && !isCalendarDate(reportedDate)) return fail('Check the date reported', 'Enter the date reported as YYYY-MM-DD, or leave it blank.');
  if (tooLong([form.personsInvolved, form.reportedTo], [form.description, form.actionTaken, form.outcome, form.notes])) return TOO_LONG;
  return {
    ok: true,
    payload: {
      siteId,
      incidentDate: form.incidentDate,
      incidentTime: incidentTime || null,
      incidentType: form.incidentType,
      severity: form.severity,
      personsInvolved: textOrNull(form.personsInvolved),
      description: form.description.trim(),
      actionTaken: textOrNull(form.actionTaken),
      reportedTo: textOrNull(form.reportedTo),
      reportedDate: reportedDate || null,
      outcome: textOrNull(form.outcome),
      notes: textOrNull(form.notes),
    },
  };
}

/**
 * How a record is sent. Without required photos it goes through the check
 * outbox: saved on the device first, so it survives no signal and is resent
 * under the same entry ID. When the account requires photos for this record
 * type, the photos are staged receipts that need a connection, so the record
 * is sent directly (entry ID reused while the answers are unchanged) and the
 * draft stays open if there is no signal. When the requirement could not be
 * checked (offline) the record is queued without photos; if the server then
 * insists on photos, the device copy shows as not accepted, with the reason.
 */
export function aquaRecordRoute(photos: { required: boolean; loadFailed: boolean }): 'outbox' | 'direct' {
  return photos.required && !photos.loadFailed ? 'direct' : 'outbox';
}

/** Incidents without an outcome are open (the website's "open incidents"). */
export const isOpenIncident = (incident: Pick<PoolIncident, 'outcome'>) => !incident.outcome?.trim();
