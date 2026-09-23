import type { NextFunction, Request, Response } from "express";

/**
 * Track records are day-bound operational evidence. Staff have the record's
 * scheduled day plus the following local calendar day to complete corrections.
 * After that 24-hour grace window, the record is immutable for staff. Client
 * admins and consultants retain the correction/backfill override.
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
  "resolvedDate",
  "riskAssessmentDate",
  "reviewDate",
  "weekCommencing",
  "dueDate",
  "targetDate",
] as const;

const ACCOUNT_TIMEZONE = process.env.COMPLYTRACK_TIMEZONE ?? "Europe/London";

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

function isTrackWrite(req: Request): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return false;
  return TRACK_WRITE_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`));
}

/**
 * ID mutation routes must use the persisted date, not a date supplied in the
 * update body (which is itself mutable).  This is deliberately an explicit
 * allowlist: both halves are SQL identifiers and must never come from a URL.
 * Metadata/configuration routes are intentionally absent.
 */
export const STORED_DATE_LOOKUPS: Array<{ path: RegExp; table: string; date: string }> = [
  { path: /^\/food-safety\/\d+$/, table: "food_safety_records", date: "record_date" },
  { path: /^\/fire-safety\/\d+$/, table: "fire_safety_checks", date: "check_date" },
  { path: /^\/legionella\/\d+$/, table: "legionella_checks", date: "check_date" },
  { path: /^\/hot-tub\/\d+$/, table: "hot_tub_checks", date: "check_date" },
  { path: /^\/tree-track\/\d+$/, table: "tree_inspections", date: "check_date" },
  { path: /^\/pool-track\/\d+$/, table: "pool_checks", date: "check_date" },
  { path: /^\/daily-track-am\/\d+$/, table: "daily_checklists", date: "check_date" },
  { path: /^\/daily-track-pm\/\d+$/, table: "daily_checklists", date: "check_date" },
  { path: /^\/daily-track-pm\/signoffs\/\d+$/, table: "daily_manager_signoffs", date: "signoff_date" },
  { path: /^\/incidents\/\d+$/, table: "incidents", date: "incident_date" },
  { path: /^\/premises-track\/\d+$/, table: "premises_inspections", date: "inspection_date" },
  { path: /^\/room-track\/checks\/\d+$/, table: "room_track_checks", date: "check_date" },
  { path: /^\/staff-training\/\d+$/, table: "staff_training_records", date: "issued_at" },
  { path: /^\/train-track\/records\/\d+$/, table: "train_track_records", date: "completed_date" },
  { path: /^\/fix-track\/issues\/\d+$/, table: "fix_track_issues", date: "created_at" },
  { path: /^\/swim-track\/sessions\/\d+$/, table: "swim_sessions", date: "session_date" },
  { path: /^\/swim-track\/surveillance\/\d+$/, table: "swim_surveillance_checks", date: "check_date" },
  { path: /^\/swim-track\/first-aid\/\d+$/, table: "swim_first_aid_checks", date: "check_date" },
  { path: /^\/swim-track\/incidents\/\d+$/, table: "swim_incidents", date: "incident_date" },
  { path: /^\/kitchen-weekly\/weekly\/\d+$/, table: "kitchen_weekly_records", date: "week_commencing" },
  { path: /^\/kitchen-weekly\/probe\/\d+$/, table: "kitchen_probe_checks", date: "check_date" },
  { path: /^\/bike-track\/hires\/\d+$/, table: "bike_hire_records", date: "hire_date" },
  { path: /^\/bike-track\/services\/\d+$/, table: "bike_services", date: "service_date" },
  { path: /^\/green-track\/pre-use-checks\/\d+$/, table: "green_pre_use_checks", date: "check_date" },
  { path: /^\/green-track\/service-records\/\d+$/, table: "green_service_records", date: "service_date" },
  { path: /^\/green-track\/defects\/\d+$/, table: "green_defects", date: "report_date" },
  { path: /^\/green-track\/puwer-inspections\/\d+$/, table: "green_puwer_inspections", date: "inspection_date" },
  { path: /^\/green-track\/fuel-logs\/\d+$/, table: "green_fuel_logs", date: "log_date" },
  { path: /^\/pat-track\/tests\/\d+$/, table: "pat_tests", date: "test_date" },
  { path: /^\/pat-track\/certificates\/\d+$/, table: "pat_certificates", date: "visit_date" },
  { path: /^\/pat-track\/replacements\/\d+$/, table: "pat_replacements", date: "replaced_on" },
  { path: /^\/pat-track\/failures\/\d+$/, table: "pat_failures", date: "created_at" },
  { path: /^\/pest-track\/visits\/\d+$/, table: "pest_visits", date: "visit_date" },
  { path: /^\/pest-track\/activity\/\d+$/, table: "pest_activity", date: "recorded_date" },
  { path: /^\/safe-track\/training-records\/\d+$/, table: "safe_training_records", date: "completed_at" },
  { path: /^\/safe-track\/inductions\/\d+$/, table: "safe_inductions", date: "start_date" },
  { path: /^\/safe-track\/competency\/\d+$/, table: "safe_competency_signoffs", date: "signed_off_at" },
];

function storedDateLookup(path: string) {
  return STORED_DATE_LOOKUPS.find(lookup => lookup.path.test(path));
}

async function findStoredEntryDate(req: Request): Promise<string | null | "missing"> {
  // Lazy imports keep the pure decision helper usable by lightweight clients
  // and tooling that evaluates this module without a database connection.
  const [{ db }, { getClientId }, { sql }] = await Promise.all([
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
  const idText = req.path.match(/\/(\d+)$/)?.[1];
  const id = Number(idText);
  if (!clientId || !Number.isInteger(id) || id <= 0) return "missing";
  // Identifiers are selected only from STORED_DATE_LOOKUPS above; values remain
  // ordinary tagged parameters (never interpolated into SQL text).
  const result = await db.execute(sql`
    SELECT ${sql.raw(`"${lookup.date}"`)} AS entry_date
    FROM ${sql.raw(`"${lookup.table}"`)}
    WHERE id = ${id} AND client_id = ${clientId}
    LIMIT 1
  `);
  const row = (result as any).rows?.[0] as { entry_date?: string | Date | null } | undefined;
  if (!row) return "missing";
  if (!row.entry_date) return null;
  return row.entry_date instanceof Date
    ? localClock(row.entry_date, ACCOUNT_TIMEZONE).date
    : String(row.entry_date).slice(0, 10);
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

export function getDailyEntryCutoffDecision(
  req: Pick<Request, "method" | "path" | "body"> & { query?: unknown },
  user: { role?: string } | null | undefined,
  now = new Date(),
  timeZone = ACCOUNT_TIMEZONE,
): { blocked: boolean; today: string; reason?: string } {
  if (!isTrackWrite(req as Request)) return { blocked: false, today: "" };
  if (user?.role === "client_admin" || user?.role === "consultant") {
    return { blocked: false, today: "" };
  }

  const clock = localClock(now, timeZone);
  const entryDate = findEntryDate(req.body) ?? findEntryDate(req.query) ?? findPathDate(req.path);
  const isPastGraceWindow = entryDate != null
    && calendarDay(clock.date) - calendarDay(entryDate) > 1;

  if (isPastGraceWindow) {
    return {
      blocked: true,
      today: clock.date,
      reason: "record_lock",
    };
  }
  return { blocked: false, today: clock.date };
}

export async function enforceDailyEntryCutoff(req: Request, res: Response, next: NextFunction) {
  const lookup = storedDateLookup(req.path);
  if (isTrackWrite(req) && lookup && req.currentUser
    && req.currentUser.role !== "client_admin" && req.currentUser.role !== "consultant") {
    try {
      const storedDate = await findStoredEntryDate(req);
      if (storedDate === "missing") {
        res.status(404).json({ error: "Record not found" });
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
    } catch {
      res.status(500).json({ error: "Unable to verify record date" });
      return;
    }
  }
  const decision = getDailyEntryCutoffDecision(req, req.currentUser, new Date());
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