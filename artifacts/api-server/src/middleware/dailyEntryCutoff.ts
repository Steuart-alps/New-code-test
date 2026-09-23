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

export function enforceDailyEntryCutoff(req: Request, res: Response, next: NextFunction) {
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