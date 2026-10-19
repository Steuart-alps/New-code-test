// Pure helpers for the FireTrack check form: call points on weekly alarm
// tests and night staff on fire drills. Mirrors the website and the rules in
// artifacts/api-server/src/routes/fire-safety.ts (resolveFireDetails). Kept
// free of React Native imports so tests can run them directly.

export const FIRE_TYPES = [
  { value: 'alarm', label: 'Weekly fire alarm test' },
  { value: 'emergency_lights', label: 'Monthly emergency lighting flick test' },
  { value: 'extinguishers', label: 'Weekly extinguisher visual check' },
  { value: 'fire_doors', label: 'Fire door check' },
  { value: 'fire_drill', label: 'Fire drill (6-monthly, with night staff)' },
  // Contractor jobs, each kept in step with a ComplyTrack task.
  { value: 'alarm_service', label: '6-monthly fire alarm service' },
  { value: 'extinguisher_service', label: 'Annual fire extinguisher service' },
  { value: 'emergency_lights_annual', label: 'Annual 3-hour emergency lighting discharge test' },
];

export type NightStaff = 'included' | 'not_included' | 'no_night_staff';

export const NIGHT_STAFF_OPTIONS: { value: NightStaff; label: string }[] = [
  { value: 'included', label: 'Night staff took part' },
  { value: 'not_included', label: 'Night staff did not take part' },
  { value: 'no_night_staff', label: 'No night staff at this site' },
];

export const FLICK_TEST_GUIDE =
  'Monthly 5 minute flick test. Switch the emergency lighting to test for 5 minutes and check every fitting lights. Record Fail and note which fittings, if any, do not.';

/** Contractor jobs that are also ComplyTrack tasks: who usually does it and the task a pass completes. */
const LINKED_TASK_GUIDES: Record<string, { heading: string; who: string; task: string }> = {
  emergency_lights_annual: {
    heading: 'Annual 3-hour discharge test.', who: 'emergency lighting contractor, who certifies it', task: 'Emergency Light Maintenance',
  },
  alarm_service: { heading: '6-monthly fire alarm service.', who: 'fire alarm contractor (BS 5839)', task: 'Fire Alarm Maintenance' },
  extinguisher_service: {
    heading: 'Annual fire extinguisher service.', who: 'extinguisher contractor (BS 5306-3)', task: 'Fire Extinguishers Maintenance',
  },
};

/** Guidance shown under a contractor job, as on the website, or null. */
export function linkedTaskGuide(checkType: string): string | null {
  const guide = LINKED_TASK_GUIDES[checkType];
  if (!guide) return null;
  return `${guide.heading} Usually done by your ${guide.who}. A pass here also completes the "${guide.task}" task in ComplyTrack, and completing that task records it here.`;
}

export const CALL_POINT_REQUIRED = 'Say which call point was tested';
export const NIGHT_STAFF_REQUIRED = 'Say whether night staff took part in the drill';

export interface CallPoint {
  id: number;
  siteId: number | null;
  name: string;
  archivedAt?: string | null;
  lastTestedDate?: string | null;
}

export interface CallPointChoice {
  callPointId: number | null;
  callPoint: string;
}

export const NO_CALL_POINT: CallPointChoice = { callPointId: null, callPoint: '' };

/** The list for one site, or for records with no site ("none"). */
export function callPointsPath(siteId: number | null): string {
  return `/api/fire-safety/call-points?siteId=${siteId ?? 'none'}`;
}

/**
 * Active call points of this site from a response. Anything that is not a
 * list (an older API without call points answers 404) counts as no list, so
 * the form asks for the call point as text.
 */
export function activeCallPoints(data: unknown, siteId: number | null): CallPoint[] {
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is CallPoint =>
    !!row && typeof row === 'object'
    && Number.isInteger((row as CallPoint).id)
    && typeof (row as CallPoint).name === 'string'
    && !(row as CallPoint).archivedAt
    && ((row as CallPoint).siteId ?? null) === siteId);
}

/** The call point to suggest: never tested first, then the one tested longest ago. */
export function nextCallPoint(points: CallPoint[]): CallPoint | undefined {
  return [...points].sort((a, b) => {
    if (!a.lastTestedDate !== !b.lastTestedDate) return a.lastTestedDate ? 1 : -1;
    return (a.lastTestedDate ?? '').localeCompare(b.lastTestedDate ?? '') || a.name.localeCompare(b.name);
  })[0];
}

/** The reason the form can't be sent yet, or null. */
export function fireDetailsError(
  checkType: string,
  choice: CallPointChoice,
  nightStaff: NightStaff | null,
): string | null {
  if (checkType === 'alarm' && choice.callPointId == null && !choice.callPoint.trim()) return CALL_POINT_REQUIRED;
  if (checkType === 'fire_drill' && !nightStaff) return NIGHT_STAFF_REQUIRED;
  return null;
}

/** The extra fields this check type sends. */
export function fireDetailsBody(
  checkType: string,
  choice: CallPointChoice,
  nightStaff: NightStaff | null,
): Record<string, unknown> {
  if (checkType === 'alarm') {
    return choice.callPointId != null
      ? { callPointId: choice.callPointId }
      : { callPoint: choice.callPoint.trim() };
  }
  if (checkType === 'fire_drill') return { nightStaff };
  return {};
}

export function nightStaffLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return NIGHT_STAFF_OPTIONS.find((option) => option.value === value)?.label ?? value.replace(/_/g, ' ');
}

/** "Call point: …" and "Night staff …" lines for a history row (either casing). */
export function fireHistoryDetails(row: Record<string, unknown>): string[] {
  const callPoint = row.callPoint ?? row.call_point;
  const night = nightStaffLabel(row.nightStaff ?? row.night_staff);
  return [
    ...(typeof callPoint === 'string' && callPoint.trim() ? [`Call point: ${callPoint.trim()}`] : []),
    ...(night ? [night] : []),
  ];
}
