export interface AquaTrackAccess {
  pool: boolean;
  sessions: boolean;
  any: boolean;
}

export function aquaTrackAccess(hasService: (service: string) => boolean): AquaTrackAccess {
  const pool = hasService('aquatrack') || hasService('pooltrack');
  const sessions = hasService('aquatrack') || hasService('swimtrack');
  return { pool, sessions, any: pool || sessions };
}

export function aquaTrackSiteQuery(siteId: number | null): string {
  return siteId === null ? '' : `?siteId=${encodeURIComponent(String(siteId))}`;
}

export function hasSelectedAquaSite(
  siteId: number | null,
  sites: { id: number }[] | undefined,
): boolean {
  return siteId !== null && !!sites?.some((site) => site.id === siteId);
}

export function localDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localTimeString(date: Date = new Date()): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function sessionsForDate<T extends { session_date: string }>(
  sessions: T[],
  date: string,
): T[] {
  return sessions.filter((session) => session.session_date.slice(0, 10) === date);
}

export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysPerMonth[month - 1];
}

export function isLocalTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function poolCheckSuggestedResult(readings: {
  ph: number | null;
  freeChlorine: number | null;
  combinedChlorine: number | null;
  turbidity: string | null;
  waterTemperature: number | null;
}): 'pass' | 'fail' | null {
  const hasAssessment = readings.ph !== null ||
    readings.freeChlorine !== null ||
    readings.combinedChlorine !== null ||
    readings.turbidity !== null ||
    readings.waterTemperature !== null;
  if (!hasAssessment) return null;

  if (
    (readings.ph !== null && (readings.ph < 7.2 || readings.ph > 7.6)) ||
    (readings.freeChlorine !== null &&
      (readings.freeChlorine < 1 || readings.freeChlorine > 3)) ||
    (readings.combinedChlorine !== null && readings.combinedChlorine >= 0.5) ||
    readings.turbidity === 'hazy' ||
    readings.turbidity === 'cloudy' ||
    (readings.waterTemperature !== null && readings.waterTemperature > 30)
  ) {
    return 'fail';
  }
  return 'pass';
}

export function isPoolResultAcknowledged(result: string | null): result is 'pass' | 'fail' {
  return result === 'pass' || result === 'fail';
}

export function canSubmitPoolCheckResult(
  suggestedResult: 'pass' | 'fail' | null,
  selectedResult: string | null,
): boolean {
  return suggestedResult === 'pass' || isPoolResultAcknowledged(selectedResult);
}

export function validateOptionalNumber(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): { value: number | null; error: string | null } {
  if (!value.trim()) return { value: null, error: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { value: null, error: `${label} must be a finite number.` };
  }
  if (parsed < minimum || parsed > maximum) {
    return { value: null, error: `${label} must be between ${minimum} and ${maximum}.` };
  }
  return { value: parsed, error: null };
}

export function validateOptionalInteger(
  value: string,
  label: string,
): { value: number | null; error: string | null } {
  if (!value.trim()) return { value: null, error: null };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    return { value: null, error: `${label} must be a whole number between 0 and 2,147,483,647.` };
  }
  return { value: parsed, error: null };
}