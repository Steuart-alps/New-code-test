import type { NextFunction, Request, Response } from "express";

/**
 * Track records are day-bound operational evidence. Staff can submit the
 * current day's record until 23:58:59 in the account's operating timezone.
 * At 23:59 the day closes; after midnight, only the new current day can be
 * entered. Client admins and consultants can correct or backfill at any time.
 *
 * Keep this guard at the API boundary so web, mobile, and other clients share
 * the same rule. The date field is intentionally best-effort because legacy
 * routes use different names; writes without a date are closed during the
 * cutoff minute but remain available at the start of a new day.
 */

const TRACK_WRITE_PREFIXES = [
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
  "actionDate",
  "trainingDate",
  "visitDate",
  "testDate",
  "assessmentDate",
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

function findEntryDate(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  for (const field of ENTRY_DATE_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      return value.slice(0, 10);
    }
  }
  return null;
}

export function getDailyEntryCutoffDecision(
  req: Pick<Request, "method" | "path" | "body">,
  user: { role?: string } | null | undefined,
  now = new Date(),
  timeZone = ACCOUNT_TIMEZONE,
): { blocked: boolean; today: string; reason?: string } {
  if (!isTrackWrite(req as Request)) return { blocked: false, today: "" };
  if (user?.role === "client_admin" || user?.role === "consultant") {
    return { blocked: false, today: "" };
  }

  const clock = localClock(now, timeZone);
  const entryDate = findEntryDate(req.body);
  const cutoffMinute = clock.hour === 23 && clock.minute >= 59;
  const isEarlierDay = entryDate != null && entryDate < clock.date;
  const isTodayAtCutoff = entryDate != null && entryDate === clock.date && cutoffMinute;
  const undatedWriteAtCutoff = entryDate == null && cutoffMinute;

  if (isEarlierDay || isTodayAtCutoff || undatedWriteAtCutoff) {
    return {
      blocked: true,
      today: clock.date,
      reason: entryDate && entryDate < clock.date ? "backdated_entry" : "daily_cutoff",
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
    error: "Daily entry window closed",
    code: "DAILY_ENTRY_CUTOFF",
    cutoffTime: "23:59",
    cutoffDate: decision.today,
    requiresAdministratorOverride: true,
  });
}