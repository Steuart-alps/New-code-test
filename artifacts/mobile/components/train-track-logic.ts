/**
 * TrainTrack on the phone (app/manage/training.tsx and training-person.tsx):
 * a read-only view of GET /api/train-track/records against the active staff
 * roster (GET /api/staff-roster), mirroring the website's TrainTrack page and
 * its training matrix (compliance-tracker src/lib/training-matrix.ts):
 *
 * - certificate status uses the website's rule: expired before today,
 *   "Expiring Soon" within 30 days, otherwise valid; no expiry date is
 *   "No Expiry" (and counts as current in the matrix);
 * - "missing" required training is the matrix's: a certificate type held by
 *   anyone in the selected site scope that this active roster member has no
 *   certificate for;
 * - records attach to a person by staff_roster_id; a legacy record without
 *   one attaches by name only when exactly one active roster member in scope
 *   has that normalised name. Other legacy records are grouped by name as
 *   "Not linked" people rather than guessed or dropped.
 *
 * Import-free so tests can load it with Node.
 */

export type TrainRecordType = 'certificate' | 'signoff' | 'internal';

/** A row of GET /api/train-track/records (snake_case, as the website reads it). */
export interface TrainRecord {
  id: number;
  site_id: number | null;
  site_name: string | null;
  record_type: TrainRecordType | string;
  staff_name: string;
  staff_roster_id: number | null;
  training_type: string | null;
  document_title: string | null;
  document_type: string | null;
  provider: string | null;
  trainer: string | null;
  completed_date: string;
  expiry_date: string | null;
  notes: string | null;
}

/** A row of GET /api/staff-roster (active members only by default). */
export interface RosterMember {
  id: number;
  name: string;
  site_id: number | null;
  site_name: string | null;
  department: string | null;
  job_title: string | null;
  email: string | null;
  active: boolean;
}

export type CertStatus = 'expired' | 'expiring_soon' | 'valid' | 'no_expiry';
/** A person's overall state; also the status filter on the list. */
export type PersonStatus = 'expired' | 'missing' | 'expiring_soon' | 'valid';
export type CourseState = 'expired' | 'expiring_soon' | 'valid' | 'no_expiry' | 'missing';

/** Same labels as the website's TrainTrack status badges and matrix. */
export const CERT_STATUS_LABELS: Record<CourseState, string> = {
  expired: 'Expired',
  expiring_soon: 'Expiring Soon',
  valid: 'Valid',
  no_expiry: 'No Expiry',
  missing: 'Missing',
};

export const PERSON_STATUS_LABELS: Record<PersonStatus, string> = {
  expired: 'Expired',
  missing: 'Missing training',
  expiring_soon: 'Expiring Soon',
  valid: 'Up to date',
};

export const PERSON_STATUSES: PersonStatus[] = ['expired', 'missing', 'expiring_soon', 'valid'];

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  risk_assessment: 'Risk Assessment',
  sop: 'SOP',
  handbook: 'Handbook',
  policy: 'Policy',
  procedure: 'Procedure',
  other: 'Other',
};

const PERSON_RANK: Record<PersonStatus, number> = { expired: 0, missing: 1, expiring_soon: 2, valid: 3 };
const CERT_RANK: Record<CertStatus, number> = { expired: 0, expiring_soon: 1, valid: 2, no_expiry: 3 };

function startOfDay(today: Date): Date {
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  return d;
}

function localMidnight(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** Calendar days from today to a date (negative when past); null without a date. */
export function daysUntil(date: string | null | undefined, today = new Date()): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const from = startOfDay(today);
  const to = localMidnight(date);
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
    - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000);
}

/** The website's certificate status for an expiry date. */
export function certificateStatus(expiryDate: string | null | undefined, today = new Date()): CertStatus {
  const days = daysUntil(expiryDate, today);
  if (days === null) return 'no_expiry';
  if (days < 0) return 'expired';
  return days <= 30 ? 'expiring_soon' : 'valid';
}

/** Document sign-offs are "Acknowledged" until an annual expiry passes. */
export function signoffStatus(expiryDate: string | null | undefined, today = new Date()): 'acknowledged' | 'expired' {
  return certificateStatus(expiryDate, today) === 'expired' ? 'expired' : 'acknowledged';
}

/** "3d", "Today", "12d ago" as on the website's expiry column. */
export function expiryCountdown(expiryDate: string | null | undefined, today = new Date()): string | null {
  const days = daysUntil(expiryDate, today);
  if (days === null) return null;
  if (days < 0) return `${Math.abs(days)}d ago`;
  return days === 0 ? 'Today' : `${days}d`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '—';
  return localMidnight(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Case-, width- and whitespace-insensitive form used only for legacy matching. */
export function normaliseStaffName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB');
}

export function courseOf(record: Pick<TrainRecord, 'training_type'>): string {
  return record.training_type || 'Other';
}

export function recordTitle(record: TrainRecord): string {
  if (record.record_type === 'signoff') return record.document_title || 'Document sign-off';
  return record.training_type || 'Training record';
}

export function recordTypeLabel(type: string): string {
  return type === 'certificate' ? 'Certificate' : type === 'signoff' ? 'Document sign-off' : 'Internal training';
}

/** Provider / trainer / document type line for a record. */
export function recordDetail(record: TrainRecord): string {
  if (record.record_type === 'certificate') return record.provider ? `Provider: ${record.provider}` : '';
  if (record.record_type === 'internal') return record.trainer ? `Delivered by: ${record.trainer}` : '';
  return record.document_type ? DOCUMENT_TYPE_LABELS[record.document_type] ?? record.document_type : '';
}

export interface Person {
  /** `r:<roster id>` for a roster member, `n:<normalised name>` for unlinked records. */
  key: string;
  name: string;
  /** Disambiguated when several people in scope share a name. */
  label: string;
  rosterId: number | null;
  siteName: string | null;
  department: string | null;
  jobTitle: string | null;
  records: TrainRecord[];
  /** Latest certificate state per required course (matrix cells). */
  courses: { course: string; state: CourseState; expiryDate: string | null; recordId: number | null }[];
  status: PersonStatus;
  /** Whether this person is not on the active roster (legacy, name-only records). */
  unlinked: boolean;
}

export function rosterKey(id: number): string {
  return `r:${id}`;
}

function isNewer(candidate: TrainRecord, existing: TrainRecord): boolean {
  const a = candidate.completed_date.slice(0, 10);
  const b = existing.completed_date.slice(0, 10);
  if (a !== b) return a > b;
  return candidate.id > existing.id;
}

function courseState(record: TrainRecord | undefined, today: Date): CourseState {
  return record ? certificateStatus(record.expiry_date, today) : 'missing';
}

function statusFromCourses(states: CourseState[]): PersonStatus {
  if (states.includes('expired')) return 'expired';
  if (states.includes('missing')) return 'missing';
  if (states.includes('expiring_soon')) return 'expiring_soon';
  return 'valid';
}

function recordSort(today: Date) {
  const typeRank: Record<string, number> = { certificate: 0, signoff: 1, internal: 2 };
  return (a: TrainRecord, b: TrainRecord) => {
    const ta = typeRank[a.record_type] ?? 3;
    const tb = typeRank[b.record_type] ?? 3;
    if (ta !== tb) return ta - tb;
    if (a.record_type === 'certificate') {
      const ra = CERT_RANK[certificateStatus(a.expiry_date, today)];
      const rb = CERT_RANK[certificateStatus(b.expiry_date, today)];
      if (ra !== rb) return ra - rb;
      if (a.expiry_date && b.expiry_date && a.expiry_date !== b.expiry_date) return a.expiry_date.localeCompare(b.expiry_date);
    }
    return b.completed_date.localeCompare(a.completed_date) || b.id - a.id;
  };
}

/**
 * Everyone with training in a site scope (null = all sites): active roster
 * members first, then unlinked names. Records outside the scope, and records
 * linked to a roster member who is inactive or outside it, are left out, as
 * the website's matrix does.
 */
export function buildPeople(
  records: readonly TrainRecord[],
  roster: readonly RosterMember[],
  siteId: number | null,
  today = new Date(),
): { people: Person[]; courses: string[] } {
  const inSite = (row: { site_id: number | null }) => siteId === null || row.site_id === siteId;
  const scopedRecords = records.filter(inSite);
  const staff = roster.filter((member) => member.active !== false && inSite(member));

  const byId = new Map<number, RosterMember>();
  const byName = new Map<string, RosterMember[]>();
  for (const member of staff) {
    if (byId.has(member.id)) continue;
    byId.set(member.id, member);
    const name = normaliseStaffName(member.name);
    byName.set(name, [...(byName.get(name) ?? []), member]);
  }

  const owned = new Map<string, TrainRecord[]>();
  const unlinkedNames = new Map<string, string>();
  for (const record of scopedRecords) {
    let key: string | null = null;
    if (record.staff_roster_id != null) {
      key = byId.has(record.staff_roster_id) ? rosterKey(record.staff_roster_id) : null;
    } else {
      const normalised = normaliseStaffName(record.staff_name ?? '');
      const candidates = byName.get(normalised) ?? [];
      if (candidates.length === 1) key = rosterKey(candidates[0].id);
      else if (normalised) {
        key = `n:${normalised}`;
        if (!unlinkedNames.has(key)) unlinkedNames.set(key, record.staff_name.trim());
      }
    }
    if (key) owned.set(key, [...(owned.get(key) ?? []), record]);
  }

  const courses = Array.from(new Set(scopedRecords
    .filter((record) => record.record_type === 'certificate')
    .map(courseOf))).sort((a, b) => a.localeCompare(b));

  const sort = recordSort(today);
  const latestByCourse = (rows: TrainRecord[]) => {
    const latest = new Map<string, TrainRecord>();
    for (const record of rows) {
      if (record.record_type !== 'certificate') continue;
      const existing = latest.get(courseOf(record));
      if (!existing || isNewer(record, existing)) latest.set(courseOf(record), record);
    }
    return latest;
  };

  const people: Person[] = [];
  for (const member of byId.values()) {
    const rows = (owned.get(rosterKey(member.id)) ?? []).sort(sort);
    const latest = latestByCourse(rows);
    const cells = courses.map((course) => {
      const record = latest.get(course);
      return { course, state: courseState(record, today), expiryDate: record?.expiry_date ?? null, recordId: record?.id ?? null };
    });
    const shared = (byName.get(normaliseStaffName(member.name)) ?? []).length > 1;
    people.push({
      key: rosterKey(member.id),
      name: member.name,
      label: shared ? `${member.name} (${member.site_name || 'no site'}, roster #${member.id})` : member.name,
      rosterId: member.id,
      siteName: member.site_name,
      department: member.department,
      jobTitle: member.job_title,
      records: rows,
      courses: cells,
      status: statusFromCourses(cells.map((cell) => cell.state)),
      unlinked: false,
    });
  }
  for (const [key, name] of unlinkedNames) {
    const rows = (owned.get(key) ?? []).sort(sort);
    const latest = latestByCourse(rows);
    // Not on the roster, so nothing can be "missing"; only what they hold.
    const cells = Array.from(latest.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([course, record]) => ({ course, state: courseState(record, today), expiryDate: record.expiry_date, recordId: record.id }));
    const sites = Array.from(new Set(rows.map((row) => row.site_name).filter(Boolean)));
    people.push({
      key,
      name,
      label: name,
      rosterId: null,
      siteName: sites.length === 1 ? sites[0] : null,
      department: null,
      jobTitle: null,
      records: rows,
      courses: cells,
      status: statusFromCourses(cells.map((cell) => cell.state)),
      unlinked: true,
    });
  }
  return { people, courses };
}

export interface TrainingFilters {
  siteId: number | null;
  department: string | null;
  /** A certificate type; the person's status is then their state for it. */
  course: string | null;
  status: PersonStatus | null;
  search: string;
}

export const EMPTY_FILTERS: TrainingFilters = { siteId: null, department: null, course: null, status: null, search: '' };

export interface TrainingOverview {
  people: Person[];
  /** People per status after the site, department, course and search filters. */
  counts: Record<PersonStatus, number>;
  courses: string[];
  departments: string[];
  total: number;
}

/** A person's state under a course filter, or their overall status. */
export function statusFor(person: Person, course: string | null): PersonStatus | null {
  if (!course) return person.status;
  const cell = person.courses.find((entry) => entry.course === course);
  if (!cell) return null;
  return cell.state === 'no_expiry' ? 'valid' : cell.state;
}

/** The list shown on the TrainTrack screen. */
export function trainingOverview(
  records: readonly TrainRecord[],
  roster: readonly RosterMember[],
  filters: TrainingFilters,
  today = new Date(),
): TrainingOverview {
  const { people, courses } = buildPeople(records, roster, filters.siteId, today);
  const departments = Array.from(new Set(roster
    .filter((member) => member.active !== false && member.department)
    .map((member) => member.department as string))).sort((a, b) => a.localeCompare(b));
  const course = filters.course && courses.includes(filters.course) ? filters.course : null;
  const query = filters.search.trim().toLocaleLowerCase('en-GB');

  const matching = people.filter((person) => {
    if (filters.department && person.department !== filters.department) return false;
    if (course && statusFor(person, course) === null) return false;
    if (!query) return true;
    return [person.name, person.jobTitle, person.siteName, person.department]
      .some((value) => (value ?? '').toLocaleLowerCase('en-GB').includes(query))
      || person.records.some((record) => [record.training_type, record.document_title, record.provider, record.trainer]
        .some((value) => (value ?? '').toLocaleLowerCase('en-GB').includes(query)));
  });
  const counts: Record<PersonStatus, number> = { expired: 0, missing: 0, expiring_soon: 0, valid: 0 };
  for (const person of matching) counts[statusFor(person, course) as PersonStatus] += 1;

  const shown = matching
    .filter((person) => !filters.status || statusFor(person, course) === filters.status)
    .sort((a, b) =>
      PERSON_RANK[statusFor(a, course) as PersonStatus] - PERSON_RANK[statusFor(b, course) as PersonStatus]
      || Number(a.unlinked) - Number(b.unlinked)
      || a.name.localeCompare(b.name)
      || a.key.localeCompare(b.key));
  return { people: shown, counts, courses, departments, total: matching.length };
}

/** One person's records across all sites, for the person screen. */
export function personByKey(
  records: readonly TrainRecord[],
  roster: readonly RosterMember[],
  key: string,
  today = new Date(),
): Person | null {
  return buildPeople(records, roster, null, today).people.find((person) => person.key === key) ?? null;
}

export type MyRosterMatch =
  | { state: 'linked'; member: RosterMember }
  | { state: 'none' }
  | { state: 'ambiguous' };

/**
 * The signed-in user's roster record, found the way the API links accounts to
 * staff (DocTrack's findMyRoster): one active member with the same email,
 * ignoring case and surrounding spaces.
 */
export function findMyRosterMember(roster: readonly RosterMember[], email: string | null | undefined): MyRosterMatch {
  const wanted = (email ?? '').trim().toLowerCase();
  if (!wanted) return { state: 'none' };
  const matches = roster.filter((member) => member.active !== false && (member.email ?? '').trim().toLowerCase() === wanted);
  if (matches.length > 1) return { state: 'ambiguous' };
  return matches.length === 1 ? { state: 'linked', member: matches[0] } : { state: 'none' };
}

/** Staff see their own training; managers and viewers see everyone's. */
export function seesOwnTrainingOnly(role: string | null | undefined): boolean {
  return role === 'client_staff';
}

/** Certificate photo URL, served by the API to a signed-in user of the account. */
export function photoUrl(apiBase: string, objectPath: string): string {
  return `${apiBase}/api/storage${objectPath.startsWith('/') ? objectPath : `/${objectPath}`}`;
}

type Raw = Record<string, unknown>;

function picker(raw: unknown) {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  return (snake: string, camel: string): unknown => item[snake] ?? item[camel];
}

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === '' ? null : String(value);
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
/** YYYY-MM-DD from a date column serialised as a date or timestamp. */
const day = (value: unknown): string | null => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''));
  return match ? match[1] : null;
};

/** A TrainTrack record from the API, in snake_case or camelCase. */
export function toTrainRecord(raw: unknown): TrainRecord {
  const pick = picker(raw);
  return {
    id: Number(pick('id', 'id')),
    site_id: num(pick('site_id', 'siteId')),
    site_name: text(pick('site_name', 'siteName')),
    record_type: String(pick('record_type', 'recordType') ?? ''),
    staff_name: String(pick('staff_name', 'staffName') ?? ''),
    staff_roster_id: num(pick('staff_roster_id', 'staffRosterId')),
    training_type: text(pick('training_type', 'trainingType')),
    document_title: text(pick('document_title', 'documentTitle')),
    document_type: text(pick('document_type', 'documentType')),
    provider: text(pick('provider', 'provider')),
    trainer: text(pick('trainer', 'trainer')),
    completed_date: day(pick('completed_date', 'completedDate')) ?? '',
    expiry_date: day(pick('expiry_date', 'expiryDate')),
    notes: text(pick('notes', 'notes')),
  };
}

/** A staff roster row from the API, in snake_case or camelCase. */
export function toRosterMember(raw: unknown): RosterMember {
  const pick = picker(raw);
  return {
    id: Number(pick('id', 'id')),
    name: String(pick('name', 'name') ?? ''),
    site_id: num(pick('site_id', 'siteId')),
    site_name: text(pick('site_name', 'siteName')),
    department: text(pick('department', 'department')),
    job_title: text(pick('job_title', 'jobTitle')),
    email: text(pick('email', 'email')),
    active: pick('active', 'active') !== false,
  };
}

/** A certificate photo row of GET /api/photos (object path in either case). */
export function photoObjectPath(raw: unknown): string | null {
  return text(picker(raw)('object_path', 'objectPath'));
}
