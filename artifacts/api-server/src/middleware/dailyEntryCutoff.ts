import type { NextFunction, Request, Response } from "express";

/**
 * Track records are day-bound operational evidence. Staff have the record's
 * scheduled day plus the following local calendar day to complete corrections.
 * After that 24-hour grace window, the record is immutable for staff. Client
 * admins and consultants (account owners) may still correct, delete or
 * backfill an older record, but only with a reason (the X-Override-Reason
 * header), which is kept in the audit trail.
 *
 * Keep this guard at the API boundary so web, mobile, and other clients share
 * the same rule. The date field is intentionally best-effort because legacy
 * routes use different names. The lookup includes nested request bodies, query
 * values, and date segments in the request path so route shapes do not silently
 * bypass the shared lock.
 */

export const TRACK_WRITE_PREFIXES = [
  "/food-safety",
  "/daily-checklists",
  "/staff-training",
  "/documents",
  "/fire-safety",
  "/legionella",
  "/safe-track",
  "/fix-track",
  "/doc-track",
  "/train-track",
  "/hot-tub",
  "/tree-track",
  "/bike-track",
  "/pool-track",
  "/green-track",
  "/swim-track",
  "/kitchen-weekly",
  "/kitchen-cleaning",
  "/daily-track-am",
  "/daily-track-pm",
  "/incidents",
  "/pat-track",
  "/pest-track",
  "/premises-track",
  "/room-track",
  "/compliance-hub",
  "/track-actions",
  "/sign-off",
] as const;

const ENTRY_DATE_FIELDS = [
  "date",
  "checkDate",
  "recordDate",
  "entryDate",
  "sessionDate",
  "logDate",
  "incidentDate",
  "reportDate",
  "inspectionDate",
  "serviceDate",
  "completionDate",
  "completedAt",
  "startDate",
  "signedOffAt",
  "completedDate",
  "actionDate",
  "trainingDate",
  "visitDate",
  "testDate",
  "assessmentDate",
  "activityDate",
  "signoffDate",
  "reportedDate",
  "recordedDate",
  "hireDate",
  "replacementDate",
  "replacedOn",
  "resolvedDate",
  "riskAssessmentDate",
  "reviewDate",
  "weekCommencing",
  "dueDate",
  "targetDate",
] as const;

export const DEFAULT_ACCOUNT_TIMEZONE = "Europe/London";
export const ACCOUNT_TIMEZONE_SETTING = "accountTimezone";
const SUPPORTED_IANA_TIMEZONES = new Set(
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : [],
);

/**
 * Validate through the runtime's IANA timezone database rather than keeping a
 * partial application-owned allowlist. This accepts regional zones such as
 * Europe/London and America/New_York while rejecting arbitrary offsets and
 * invalid names.
 */
export function isValidAccountTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  const timeZone = value.trim();
  // UTC is an IANA identifier but is omitted by supportedValuesOf because it
  // is the database's canonical zero-offset alias.
  return timeZone === "UTC" || SUPPORTED_IANA_TIMEZONES.has(timeZone);
}

export function normalizeAccountTimezone(value: unknown): string {
  return isValidAccountTimezone(value) ? value.trim() : DEFAULT_ACCOUNT_TIMEZONE;
}

type LocalClock = {
  date: string;
  hour: number;
  minute: number;
};

function localClock(now: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

/**
 * Express routes paths case-insensitively, ignores a trailing slash and
 * decodes percent-encoded segments, so `/PAT-TRACK/tests/%37/` reaches the
 * same handler as `/pat-track/tests/7`. Every lock decision reads this
 * canonical form so no other spelling of a route can skip the check.
 */
export function canonicalTrackPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed escapes are rejected by Express before any handler runs.
  }
  return decoded.toLowerCase().replace(/\/+$/, "") || "/";
}

function isTrackWrite(req: Pick<Request, "method" | "path">): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return false;
  const path = canonicalTrackPath(req.path);
  return TRACK_WRITE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * ID mutation routes must use the persisted date, not a date supplied in the
 * update body (which is itself mutable).  This is deliberately an explicit
 * allowlist: both halves are SQL identifiers and must never come from a URL.
 * Metadata/configuration routes are intentionally absent.
 *
 * `department` is a SQL expression (over the `record` alias) giving the
 * department of the record's site, for tracks whose routes are department
 * scoped. Department-scoped staff get the boundary's 403 for another
 * department's record before any date is compared, so the lock response never
 * reveals that record or its date.
 */
const siteDepartment = (siteId: string) =>
  `(SELECT site.department_id FROM "sites" AS site WHERE site.id = ${siteId} AND site.client_id = record.client_id)`;
const RECORD_SITE_DEPARTMENT = siteDepartment("record.site_id");

export const STORED_DATE_LOOKUPS: Array<{ path: RegExp; table: string; date: string; department?: string }> = [
  { path: /^\/food-safety\/\d+$/, table: "food_safety_records", date: "record_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/fire-safety\/\d+$/, table: "fire_safety_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/legionella\/\d+$/, table: "legionella_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/hot-tub\/\d+$/, table: "hot_tub_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/tree-track\/\d+$/, table: "tree_inspections", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/pool-track\/\d+$/, table: "pool_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/daily-track-am\/\d+$/, table: "daily_checklists", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/daily-track-pm\/\d+$/, table: "daily_checklists", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/daily-track-pm\/signoffs\/\d+$/, table: "daily_manager_signoffs", date: "signoff_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/incidents\/\d+$/, table: "incidents", date: "incident_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/premises-track\/\d+$/, table: "premises_inspections", date: "inspection_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/room-track\/checks\/\d+$/, table: "room_track_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/staff-training\/\d+$/, table: "staff_training_records", date: "issued_at" },
  { path: /^\/train-track\/records\/\d+$/, table: "train_track_records", date: "completed_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/swim-track\/sessions\/\d+$/, table: "swim_sessions", date: "session_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/swim-track\/surveillance\/\d+$/, table: "swim_surveillance_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/swim-track\/first-aid\/\d+$/, table: "swim_first_aid_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/swim-track\/incidents\/\d+$/, table: "swim_incidents", date: "incident_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/kitchen-weekly\/weekly\/\d+$/, table: "kitchen_weekly_records", date: "week_commencing", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/kitchen-weekly\/probe\/\d+$/, table: "kitchen_probe_checks", date: "check_date", department: RECORD_SITE_DEPARTMENT },
  // A hire belongs to its own site, else its bike's; a service to its bike's.
  { path: /^\/bike-track\/hires\/\d+$/, table: "bike_hire_records", date: "hire_date",
    department: siteDepartment(`COALESCE(record.site_id, (SELECT bike.site_id FROM "bikes" AS bike
      WHERE bike.id = record.bike_id AND bike.client_id = record.client_id))`) },
  { path: /^\/bike-track\/services\/\d+$/, table: "bike_services", date: "service_date",
    department: siteDepartment(`(SELECT bike.site_id FROM "bikes" AS bike
      WHERE bike.id = record.bike_id AND bike.client_id = record.client_id)`) },
  { path: /^\/green-track\/pre-use-checks\/\d+$/, table: "green_pre_use_checks", date: "check_date" },
  { path: /^\/green-track\/service-records\/\d+$/, table: "green_service_records", date: "service_date" },
  { path: /^\/green-track\/defects\/\d+$/, table: "green_defects", date: "report_date" },
  { path: /^\/green-track\/puwer-inspections\/\d+$/, table: "green_puwer_inspections", date: "inspection_date" },
  { path: /^\/green-track\/fuel-logs\/\d+$/, table: "green_fuel_logs", date: "log_date" },
  // PAT tests keep the department recorded with them; the others follow the
  // site recorded with the replacement, or the failure's certificate.
  { path: /^\/pat-track\/tests\/\d+$/, table: "pat_tests", date: "test_date",
    department: `COALESCE(record.department_id_snapshot, ${siteDepartment("record.site_id_snapshot")})` },
  { path: /^\/pat-track\/certificates\/\d+$/, table: "pat_certificates", date: "visit_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/pat-track\/replacements\/\d+$/, table: "pat_replacements", date: "replaced_on",
    department: siteDepartment(`COALESCE(record.site_id_snapshot, (SELECT room.site_id FROM "pat_rooms" AS room
      WHERE room.id = record.room_id AND room.client_id = record.client_id))`) },
  { path: /^\/pat-track\/failures\/\d+$/, table: "pat_failures", date: "created_at",
    department: siteDepartment(`(SELECT certificate.site_id FROM "pat_certificates" AS certificate
      WHERE certificate.id = record.certificate_id AND certificate.client_id = record.client_id)`) },
  { path: /^\/pest-track\/visits\/\d+$/, table: "pest_visits", date: "visit_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/pest-track\/activity\/\d+$/, table: "pest_activity", date: "recorded_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/safe-track\/training-records\/\d+$/, table: "safe_training_records", date: "completed_at", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/safe-track\/inductions\/\d+$/, table: "safe_inductions", date: "start_date", department: RECORD_SITE_DEPARTMENT },
  { path: /^\/safe-track\/competency\/\d+$/, table: "safe_competency_signoffs", date: "signed_off_at", department: RECORD_SITE_DEPARTMENT },
];

/**
 * Checks whose due status comes from the latest recorded date. A future date
 * (for example a 2027 typo) would keep the check "up to date" for a year, so
 * these routes accept a check date of at most today in the account's
 * timezone, for every role. The field is named explicitly because other date
 * fields on these routes (due or review dates) may legitimately be future.
 */
export const NO_FUTURE_CHECK_DATE_ROUTES: Array<{ method: "POST" | "PUT"; path: RegExp; field: string }> = [
  { method: "POST", path: /^\/fire-safety\/?$/, field: "checkDate" },
  { method: "PUT", path: /^\/fire-safety\/\d+$/, field: "checkDate" },
  { method: "POST", path: /^\/legionella\/?$/, field: "checkDate" },
  { method: "PUT", path: /^\/legionella\/\d+$/, field: "checkDate" },
  { method: "POST", path: /^\/hot-tub\/?$/, field: "checkDate" },
  { method: "PUT", path: /^\/hot-tub\/\d+$/, field: "checkDate" },
  { method: "POST", path: /^\/pool-track\/?$/, field: "checkDate" },
  { method: "PUT", path: /^\/pool-track\/\d+$/, field: "checkDate" },
  { method: "POST", path: /^\/tree-track\/?$/, field: "checkDate" },
  { method: "PUT", path: /^\/tree-track\/\d+$/, field: "checkDate" },
];

/**
 * Pure decision: the submitted check date when it is after the account's
 * local today, otherwise null.
 */
export function futureCheckDate(
  req: Pick<Request, "method" | "path" | "body">,
  now = new Date(),
  timeZone = DEFAULT_ACCOUNT_TIMEZONE,
): { date: string; today: string } | null {
  const path = canonicalTrackPath(req.path);
  const rule = NO_FUTURE_CHECK_DATE_ROUTES.find(route => route.method === req.method && route.path.test(path));
  if (!rule || !req.body || typeof req.body !== "object") return null;
  const value = (req.body as Record<string, unknown>)[rule.field];
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const today = localClock(now, normalizeAccountTimezone(timeZone)).date;
  return value.slice(0, 10) > today ? { date: value.slice(0, 10), today } : null;
}

function storedDateLookup(path: string) {
  const canonical = canonicalTrackPath(path);
  return STORED_DATE_LOOKUPS.find(lookup => lookup.path.test(canonical));
}

/**
 * A mapped record path whose id is not plain digits, such as `+7`, ` 7` or
 * `0x7`. Routes parse ids with Number() or a Postgres integer cast, which
 * accept those spellings, so staff writes to them are refused rather than
 * treated as unmapped. Word and date segments (`/signoffs`, `/2026-10-12`)
 * are sibling routes and pass through.
 */
export function isNonCanonicalRecordPath(path: string): boolean {
  const match = canonicalTrackPath(path).match(/^(.*\/)([^/]+)$/);
  if (!match || /^(?:\d+|[a-z][a-z0-9_-]*|\d{4}-\d{2}-\d{2})$/.test(match[2])) return false;
  return storedDateLookup(`${match[1]}0`) !== undefined;
}

async function findStoredEntryDate(
  req: Request,
  timeZone: string,
): Promise<string | null | "missing" | "forbidden"> {
  // Lazy imports keep the pure decision helper usable by lightweight clients
  // and tooling that evaluates this module without a database connection.
  const [{ db }, { getClientId, getActiveDepartmentId }, { sql }] = await Promise.all([
    import("@workspace/db"),
    import("./requireAuth"),
    import("drizzle-orm"),
  ]);
  const lookup = storedDateLookup(req.path);
  if (!lookup) return null;
  const clientId = getClientId(req);
  // This middleware runs before routers are mounted, so route params are not
  // populated yet.  The mapping regex guarantees the final numeric segment is
  // the record id (including nested/composite routes).
  const idText = canonicalTrackPath(req.path).match(/\/(\d+)$/)?.[1];
  const id = Number(idText);
  if (!clientId || !Number.isInteger(id) || id <= 0) return "missing";
  // Identifiers are selected only from STORED_DATE_LOOKUPS above; values remain
  // ordinary tagged parameters (never interpolated into SQL text).
  const result = await db.execute(sql`
    SELECT ${sql.raw(`record."${lookup.date}"`)} AS entry_date
      ${lookup.department ? sql`, ${sql.raw(lookup.department)} AS record_department_id` : sql``}
    FROM ${sql.raw(`"${lookup.table}"`)} AS record
    WHERE record.id = ${id} AND record.client_id = ${clientId}
    LIMIT 1
  `);
  const row = (result as any).rows?.[0] as {
    entry_date?: string | Date | null;
    record_department_id?: number | null;
  } | undefined;
  const departmentId = getActiveDepartmentId(req);
  // Department-scoped staff get the same answer for another department's
  // record and for one that does not exist, so ids reveal nothing.
  if (!row) return lookup.department && departmentId !== null ? "forbidden" : "missing";
  if (lookup.department && departmentId !== null
    && row.record_department_id != null && row.record_department_id !== departmentId) {
    return "forbidden";
  }
  if (!row.entry_date) return null;
  return row.entry_date instanceof Date
    ? localClock(row.entry_date, timeZone).date
    : String(row.entry_date).slice(0, 10);
}

async function findAccountTimezone(req: Request): Promise<string> {
  const [{ db }, { appSettingsTable }, { and, eq }, { getClientId }] = await Promise.all([
    import("@workspace/db"),
    import("@workspace/db/schema"),
    import("drizzle-orm"),
    import("./requireAuth"),
  ]);
  const clientId = getClientId(req);
  if (!clientId) return DEFAULT_ACCOUNT_TIMEZONE;

  const rows = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(
      eq(appSettingsTable.clientId, clientId),
      eq(appSettingsTable.key, ACCOUNT_TIMEZONE_SETTING),
    ));
  const setting = rows[0];
  return normalizeAccountTimezone(setting?.value);
}

function findEntryDate(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findEntryDate(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  for (const field of ENTRY_DATE_FIELDS) {
    const fieldValue = (value as Record<string, unknown>)[field];
    if (typeof fieldValue === "string" && /^\d{4}-\d{2}-\d{2}/.test(fieldValue)) {
      return fieldValue.slice(0, 10);
    }
  }
  for (const nestedValue of Object.values(value as Record<string, unknown>)) {
    const nested = findEntryDate(nestedValue, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function findPathDate(path: string): string | null {
  const match = path.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\/|$)/);
  return match?.[1] ?? null;
}

function calendarDay(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
}

/** Roles that may change records past the correction window, with a reason. */
export function isRecordOwnerRole(role: unknown): boolean {
  return role === "client_admin" || role === "consultant";
}

/**
 * Workflow records rather than dated evidence: FixTrack jobs and track
 * actions carry reported/target/due dates that are routinely in the past
 * (an overdue job), and their edit forms resend them. Owners change these
 * without a reason, as before; the staff rule for them is unchanged.
 */
export const OWNER_REASON_EXEMPT_PREFIXES = ["/fix-track", "/track-actions"] as const;

function isOwnerReasonExempt(path: string): boolean {
  return OWNER_REASON_EXEMPT_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/** Request header carrying an owner's reason (URI-encoded by clients). */
export const OVERRIDE_REASON_HEADER = "x-override-reason";
export const OVERRIDE_REASON_MIN_LENGTH = 5;
export const OVERRIDE_REASON_MAX_LENGTH = 500;

/**
 * Pure: the usable reason from an X-Override-Reason header value, or null.
 * Clients URI-encode the text so any characters survive HTTP headers; a value
 * that is not valid URI encoding is taken as sent. Control characters and
 * runs of whitespace collapse to single spaces; the result is trimmed, must
 * have at least OVERRIDE_REASON_MIN_LENGTH characters and is capped at
 * OVERRIDE_REASON_MAX_LENGTH.
 */
export function parseOverrideReason(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  // eslint-disable-next-line no-control-regex
  const reason = decoded.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if (reason.length < OVERRIDE_REASON_MIN_LENGTH) return null;
  return reason.slice(0, OVERRIDE_REASON_MAX_LENGTH).trim();
}

export type DailyEntryCutoffDecision = {
  blocked: boolean;
  today: string;
  /**
   * record_lock: staff (and anyone who is not an owner) cannot write it.
   * override_reason_required: an owner can, but only with a reason.
   */
  reason?: "record_lock" | "override_reason_required";
  /** The record date that fell outside the correction window. */
  entryDate?: string;
};

/**
 * Weekly and monthly records are dated at the start of their period (a weekly
 * kitchen review by its Monday, a monthly cleaning schedule by the 1st) but
 * are filled in during it. Their correction window runs from the period's last
 * day, so staff can complete them until the day after the period ends.
 * Everything else covers one day: its last day is its date.
 */
export function entryPeriodLastDay(
  req: Pick<Request, "path" | "body">,
  entryDate: string,
): string {
  const path = req.path.toLowerCase().replace(/\/+$/, "");
  const frequency = (req.body as { frequency?: unknown } | undefined)?.frequency;
  const weekly = /^\/kitchen-weekly\/weekly(?:\/\d+)?$/.test(path)
    || (path === "/kitchen-cleaning/logs" && frequency === "weekly");
  if (weekly) {
    return new Date((calendarDay(entryDate) + 6) * 86_400_000).toISOString().slice(0, 10);
  }
  if (path === "/kitchen-cleaning/logs" && frequency === "monthly") {
    const [year, month] = entryDate.split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }
  return entryDate;
}

export function getDailyEntryCutoffDecision(
  req: Pick<Request, "method" | "path" | "body"> & { query?: unknown },
  user: { role?: string } | null | undefined,
  now = new Date(),
  timeZone = DEFAULT_ACCOUNT_TIMEZONE,
): DailyEntryCutoffDecision {
  if (!isTrackWrite(req as Request)) return { blocked: false, today: "" };
  const owner = isRecordOwnerRole(user?.role);
  if (owner && isOwnerReasonExempt(req.path)) return { blocked: false, today: "" };

  const clock = localClock(now, normalizeAccountTimezone(timeZone));
  const entryDate = findEntryDate(req.body) ?? findEntryDate(req.query) ?? findPathDate(canonicalTrackPath(req.path));
  const isPastGraceWindow = entryDate != null
    && calendarDay(clock.date) - calendarDay(entryPeriodLastDay(req, entryDate)) > 1;

  if (isPastGraceWindow) {
    return {
      blocked: true,
      today: clock.date,
      reason: owner ? "override_reason_required" : "record_lock",
      entryDate,
    };
  }
  return { blocked: false, today: clock.date };
}

const OVERRIDE_REASON_REQUIRED_MESSAGE = "This record is more than a day old. Add a reason to change it.";

/**
 * Owners (client admins and consultants) may write a record past the
 * correction window only with a reason. The window is judged as for staff:
 * by the stored date for ID-addressed records, and by the requested date
 * (body, query or path), so a current record cannot be moved to an older day,
 * nor a new one backfilled there, without a reason either. Each accepted
 * reason is written to audit_events before the route runs; if that write
 * fails the request is refused rather than let through unaudited.
 */
async function enforceOwnerOverrideReason(req: Request, res: Response, next: NextFunction) {
  const user = req.currentUser;
  const now = new Date();
  const lookup = storedDateLookup(req.path);
  let lateEntryDate: string | null = null;
  let cutoffDate = "";
  let recordId = 0;
  let deferToRoute = false;
  try {
    const timeZone = await findAccountTimezone(req);
    if (lookup) {
      const storedDate = await findStoredEntryDate(req, timeZone);
      // Unknown, other-tenant or other-department records: the route gives
      // its own 404/403, and nothing is audited for a record the caller
      // cannot see.
      if (storedDate === "missing" || storedDate === "forbidden") {
        deferToRoute = true;
      } else {
        recordId = Number(req.path.match(/\/(\d+)$/)?.[1] ?? 0);
        if (storedDate) {
          const stored = getDailyEntryCutoffDecision(
            { method: req.method, path: req.path, body: { recordDate: storedDate } },
            user,
            now,
            timeZone,
          );
          if (stored.blocked) {
            lateEntryDate = storedDate;
            cutoffDate = stored.today;
          }
        }
      }
    }
    if (!deferToRoute && !lateEntryDate) {
      const requested = getDailyEntryCutoffDecision(req, user, now, timeZone);
      if (requested.blocked && requested.entryDate) {
        lateEntryDate = requested.entryDate;
        cutoffDate = requested.today;
      }
    }
  } catch {
    res.status(500).json({ error: lookup ? "Unable to verify record date" : "Unable to verify account timezone" });
    return;
  }
  if (deferToRoute || !lateEntryDate) {
    next();
    return;
  }

  const reason = parseOverrideReason(req.get(OVERRIDE_REASON_HEADER));
  if (!reason) {
    res.status(423).json({
      error: OVERRIDE_REASON_REQUIRED_MESSAGE,
      code: "OVERRIDE_REASON_REQUIRED",
      cutoffDate,
      entryDate: lateEntryDate,
      minReasonLength: OVERRIDE_REASON_MIN_LENGTH,
    });
    return;
  }

  try {
    // Lazy imports keep this module loadable without a database (see
    // findStoredEntryDate).
    const [{ appendAuditEvent }, { getClientId }] = await Promise.all([
      import("../lib/audit"),
      import("./requireAuth"),
    ]);
    // The tenant comes only from the authenticated, access-checked context.
    const clientId = getClientId(req);
    if (!clientId) throw new Error("No business selected for the override audit event");
    await appendAuditEvent(req, {
      clientId,
      entityType: "track_record",
      entityId: Number.isInteger(recordId) && recordId > 0 ? recordId : 0,
      action: "late_edit_override",
      metadata: {
        method: req.method,
        path: req.path,
        entryDate: lateEntryDate,
        reason,
        role: user?.role ?? null,
      },
    });
  } catch {
    res.status(500).json({ error: "Unable to record the reason for this change" });
    return;
  }
  next();
}

export async function enforceDailyEntryCutoff(req: Request, res: Response, next: NextFunction) {
  const canonicalPath = canonicalTrackPath(req.path);
  if (req.currentUser && NO_FUTURE_CHECK_DATE_ROUTES.some(route => route.method === req.method && route.path.test(canonicalPath))) {
    // Judge the date on the account's own calendar (default Europe/London).
    let accountTimezone = DEFAULT_ACCOUNT_TIMEZONE;
    try {
      accountTimezone = await findAccountTimezone(req);
    } catch {
      res.status(500).json({ error: "Unable to verify account timezone" });
      return;
    }
    const future = futureCheckDate(req, new Date(), accountTimezone);
    if (future) {
      res.status(400).json({
        error: "The check date cannot be in the future",
        code: "CHECK_DATE_IN_FUTURE",
        today: future.today,
      });
      return;
    }
  }
  if (isTrackWrite(req) && req.currentUser && isRecordOwnerRole(req.currentUser.role)) {
    await enforceOwnerOverrideReason(req, res, next);
    return;
  }
  const lookup = storedDateLookup(req.path);
  const staffTrackWrite = isTrackWrite(req) && req.currentUser;
  let timeZone = DEFAULT_ACCOUNT_TIMEZONE;
  if (staffTrackWrite && isNonCanonicalRecordPath(req.path)) {
    res.status(404).json({ error: "Record not found" });
    return;
  }
  if (staffTrackWrite) {
    try {
      timeZone = await findAccountTimezone(req);
      if (lookup) {
        const storedDate = await findStoredEntryDate(req, timeZone);
        if (storedDate === "missing") {
          res.status(404).json({ error: "Record not found" });
          return;
        }
        if (storedDate === "forbidden") {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        // A mapped record with a NULL date fails closed; never fall back to a
        // date supplied by the client. Unmapped metadata routes continue to the
        // route's existing authorization and validation.
        if (storedDate) {
          const decision = getDailyEntryCutoffDecision(
            { method: req.method, path: req.path, body: { recordDate: storedDate } },
            req.currentUser,
            new Date(),
            timeZone,
          );
          if (decision.blocked) {
            res.status(423).json({
              error: "This record is locked because its 24-hour correction window has closed",
              code: "TRACK_RECORD_LOCKED",
              lockAfterHours: 24,
              cutoffDate: decision.today,
              requiresAdministratorOverride: true,
            });
            return;
          }
          // Also retain the existing check on requested dates: a current record
          // cannot be moved to a historical day by submitting a backdated body.
        }
        if (storedDate === null) {
          res.status(423).json({
            error: "Record has no stored date and cannot be modified by staff",
            code: "TRACK_RECORD_LOCKED",
            requiresAdministratorOverride: true,
          });
          return;
        }
      }
    } catch {
      res.status(500).json({ error: lookup ? "Unable to verify record date" : "Unable to verify account timezone" });
      return;
    }
  }
  const decision = getDailyEntryCutoffDecision(req, req.currentUser, new Date(), timeZone);
  if (!decision.blocked) {
    next();
    return;
  }
  res.status(423).json({
    error: "This record is locked because its 24-hour correction window has closed",
    code: "TRACK_RECORD_LOCKED",
    lockAfterHours: 24,
    cutoffDate: decision.today,
    requiresAdministratorOverride: true,
  });
}