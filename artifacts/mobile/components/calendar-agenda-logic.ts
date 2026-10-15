/**
 * Calendar on the phone (app/manage/calendar.tsx): the website's calendar
 * (compliance-tracker pages/calendar.tsx, GET /api/calendar) as an agenda —
 * Overdue, Today, This week and Later — with each entry opening the matching
 * phone screen where one exists. Read-only.
 *
 * Import-free so tests can load it directly with Node.
 */

export type CalendarKind =
  | 'compliance_due' | 'contractor_visit' | 'contractor_insurance' | 'contractor_indemnity'
  | 'contractor_dbs' | 'contractor_accreditation' | 'fix_visit' | 'pest_visit' | 'training_expiry'
  | 'coshh_review' | 'asbestos_plan_review';

export interface CalendarEntry {
  id: string;
  date: string;
  kind: CalendarKind;
  title: string;
  detail: string | null;
  siteName: string | null;
  href: string;
  status: 'overdue' | 'due' | 'done';
}

export interface CalendarResponse {
  from: string;
  to: string;
  today: string;
  siteId: number | null;
  entries: CalendarEntry[];
  truncated: boolean;
}

/** The API allows at most 93 days per request (both ends included). */
export const MAX_RANGE_DAYS = 93;

/** The website's five colour groups. */
export const CALENDAR_GROUPS = {
  checks: { label: 'Compliance checks', color: '#3b82f6' },
  visits: { label: 'Contractor visits', color: '#8b5cf6' },
  expiries: { label: 'Contractor insurance, DBS and accreditations', color: '#f59e0b' },
  training: { label: 'Training expiries', color: '#ec4899' },
  registers: { label: 'COSHH and asbestos reviews', color: '#14b8a6' },
} as const;

export type CalendarGroup = keyof typeof CALENDAR_GROUPS;

export const KIND_GROUP: Record<CalendarKind, CalendarGroup> = {
  compliance_due: 'checks',
  contractor_visit: 'visits',
  fix_visit: 'visits',
  pest_visit: 'visits',
  contractor_insurance: 'expiries',
  contractor_indemnity: 'expiries',
  contractor_dbs: 'expiries',
  contractor_accreditation: 'expiries',
  training_expiry: 'training',
  coshh_review: 'registers',
  asbestos_plan_review: 'registers',
};

export function groupOf(kind: string): CalendarGroup {
  return KIND_GROUP[kind as CalendarKind] ?? 'checks';
}

function parseIso(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(time).toISOString().slice(0, 10) === date ? time : null;
}

/** The device's calendar date as YYYY-MM-DD. */
export function localIsoDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const time = parseIso(date);
  if (time === null) throw new Error(`Not a calendar date: ${date}`);
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Two requests within the API's limit: the last three months (for anything
 * still overdue) and the next three months. Both include today; entries are
 * de-duplicated by id after loading.
 */
export function agendaWindows(today: string): { from: string; to: string }[] {
  const span = MAX_RANGE_DAYS - 1;
  return [
    { from: addDays(today, -span), to: today },
    { from: today, to: addDays(today, span) },
  ];
}

export function calendarPath(window: { from: string; to: string }, siteId: number | null): string {
  const params = [`from=${window.from}`, `to=${window.to}`];
  if (siteId !== null) params.push(`siteId=${siteId}`);
  return `/api/calendar?${params.join('&')}`;
}

/** GET /api/calendar read in either field style (snake_case or camelCase); bad rows dropped. */
export function normalizeCalendarResponse(value: unknown): CalendarResponse {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rows = Array.isArray(body.entries) ? body.entries : [];
  const text = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  const entries: CalendarEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const date = String(row.date ?? '');
    if (parseIso(date) === null || row.id === undefined || row.id === null) continue;
    const status = row.status === 'overdue' || row.status === 'done' ? row.status : 'due';
    entries.push({
      id: String(row.id),
      date,
      kind: String(row.kind ?? 'compliance_due') as CalendarKind,
      title: String(row.title ?? ''),
      detail: text(row.detail),
      siteName: text(row.site_name ?? row.siteName),
      href: String(row.href ?? ''),
      status,
    });
  }
  const siteId = body.site_id ?? body.siteId;
  return {
    from: String(body.from ?? ''),
    to: String(body.to ?? ''),
    today: String(body.today ?? ''),
    siteId: typeof siteId === 'number' ? siteId : null,
    entries,
    truncated: body.truncated === true,
  };
}

/** One list, each entry once, in the API's order (date, kind, title). */
export function mergeCalendarEntries(responses: readonly Pick<CalendarResponse, 'entries'>[]): CalendarEntry[] {
  const byId = new Map<string, CalendarEntry>();
  for (const response of responses) for (const entry of response.entries ?? []) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}

/** Sunday of today's Monday-first week (the website's calendar weeks start on Monday). */
export function endOfWeek(today: string): string {
  const time = parseIso(today);
  if (time === null) throw new Error(`Not a calendar date: ${today}`);
  const weekday = (new Date(time).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(today, 6 - weekday);
}

export type AgendaSectionKey = 'overdue' | 'today' | 'week' | 'later';

export interface AgendaSection {
  key: AgendaSectionKey;
  title: string;
  entries: CalendarEntry[];
}

const SECTION_TITLES: Record<AgendaSectionKey, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
};

/**
 * Overdue: past and not done (oldest first). Today, This week (to Sunday)
 * and Later: everything from today on, done entries included like the
 * website shows them. Past entries that are done drop out.
 */
export function buildAgenda(entries: readonly CalendarEntry[], today: string): AgendaSection[] {
  const weekEnd = endOfWeek(today);
  const sections: Record<AgendaSectionKey, CalendarEntry[]> = { overdue: [], today: [], week: [], later: [] };
  for (const entry of entries) {
    if (entry.date < today) {
      if (entry.status === 'overdue') sections.overdue.push(entry);
    } else if (entry.date === today) sections.today.push(entry);
    else if (entry.date <= weekEnd) sections.week.push(entry);
    else sections.later.push(entry);
  }
  return (Object.keys(SECTION_TITLES) as AgendaSectionKey[]).map((key) => ({
    key, title: SECTION_TITLES[key], entries: sections[key],
  }));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 15 Oct", like the website's day headings. */
export function agendaDayLabel(date: string): string {
  const time = parseIso(date);
  if (time === null) return date;
  const day = new Date(time);
  return `${WEEKDAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
}

/**
 * The phone screen for an entry's website link, or null when the phone has
 * no matching screen (compliance check records, COSHH and asbestos registers).
 */
export function phoneRouteForCalendarHref(href: string): string | null {
  const path = String(href ?? '').split(/[?#]/, 1)[0].replace(/\/+$/, '');
  const contractor = /^\/contractors\/(\d{1,9})$/.exec(path);
  if (contractor) return `/manage/contractor/${contractor[1]}`;
  const issue = /^\/fix-track\/(\d{1,9})$/.exec(path);
  if (issue) return `/issues/${issue[1]}`;
  if (path === '/pest-track') return '/checks/pest';
  if (path === '/train-track') return '/(tabs)/docs?tab=training';
  return null;
}

/** Spoken summary for a row (status first, like the website's screen-reader prefix). */
export function entryAccessibilityLabel(entry: CalendarEntry): string {
  const prefix = entry.status === 'overdue' ? 'Overdue: ' : entry.status === 'done' ? 'Done: ' : '';
  return `${prefix}${[entry.title, entry.detail, entry.siteName, agendaDayLabel(entry.date)].filter(Boolean).join(', ')}`;
}
