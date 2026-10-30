/**
 * When each site's opening and closing checks are due. Owners, Managers and
 * consultants set them per site (sites.opening_checks_due /
 * closing_checks_due, "HH:MM" on the business's own clock); a blank time means
 * the default, 06:00 for opening and 18:00 for closing.
 *
 * One pair of times covers every opening and closing checklist at the site:
 * KitchenTrack and PremisesTrack (DailyTrack AM / PM) and the GreenTrack
 * greenkeeping shed checks. A checklist not submitted by its due time is
 * overdue on the dashboard. The reminder to the track owner goes out at the
 * site's reminder time instead (sites.opening_reminder_at /
 * closing_reminder_at, default 11:00 and 21:00), on the first hourly reminder
 * run after it (lib/trackReminders.ts).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const DEFAULT_CHECKLIST_DUE_TIMES = { opening: "06:00", closing: "18:00" } as const;
export const DEFAULT_CHECKLIST_REMINDER_TIMES = { opening: "11:00", closing: "21:00" } as const;

export type ChecklistPeriod = "opening" | "closing";

export interface SiteChecklistDueTimes {
  opening: string;
  closing: string;
  /** When the reminder goes out if the checklist is still not submitted. */
  reminder: { opening: string; closing: string };
}

interface SiteTimeColumns {
  openingChecksDue?: string | null;
  closingChecksDue?: string | null;
  openingReminderAt?: string | null;
  closingReminderAt?: string | null;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A due time as stored: "HH:MM" (24-hour), null for the default, or
 * "invalid". Accepts "H:MM" and a trailing ":SS" (time inputs), which are
 * normalised.
 */
export function parseChecklistDueTime(raw: unknown): string | null | "invalid" {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!match) return "invalid";
  const time = `${match[1]!.padStart(2, "0")}:${match[2]}`;
  return TIME_PATTERN.test(time) ? time : "invalid";
}

/** The site's due times with the defaults filled in. */
export function siteChecklistDueTimes(site: SiteTimeColumns): SiteChecklistDueTimes {
  const valid = (value: string | null | undefined) => {
    const parsed = parseChecklistDueTime(value);
    return parsed === "invalid" ? null : parsed;
  };
  return {
    opening: valid(site.openingChecksDue) ?? DEFAULT_CHECKLIST_DUE_TIMES.opening,
    closing: valid(site.closingChecksDue) ?? DEFAULT_CHECKLIST_DUE_TIMES.closing,
    reminder: {
      opening: valid(site.openingReminderAt) ?? DEFAULT_CHECKLIST_REMINDER_TIMES.opening,
      closing: valid(site.closingReminderAt) ?? DEFAULT_CHECKLIST_REMINDER_TIMES.closing,
    },
  };
}

/** A sites row (snake_case) as read with raw SQL. */
export function siteChecklistTimesFromRow(row: {
  opening_checks_due?: string | null; closing_checks_due?: string | null;
  opening_reminder_at?: string | null; closing_reminder_at?: string | null;
}): SiteChecklistDueTimes {
  return siteChecklistDueTimes({
    openingChecksDue: row.opening_checks_due, closingChecksDue: row.closing_checks_due,
    openingReminderAt: row.opening_reminder_at, closingReminderAt: row.closing_reminder_at,
  });
}

/** Local wall-clock time ("HH:MM", 24-hour) at `now` in the timezone. */
export function localTimeIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("hour")}:${value("minute")}`;
}

/** True once the local time has reached the due time ("HH:MM" compare as strings). */
export function isPastDue(localTime: string, dueTime: string): boolean {
  return localTime >= dueTime;
}

/** Each site's due times (defaults filled in), for sites of this business. */
export async function loadSiteChecklistDueTimes(clientId: number, siteIds: number[]): Promise<Map<number, SiteChecklistDueTimes>> {
  const result = new Map<number, SiteChecklistDueTimes>();
  if (siteIds.length === 0) return result;
  const rows = ((await db.execute(sql`
    SELECT id, opening_checks_due, closing_checks_due, opening_reminder_at, closing_reminder_at
    FROM sites
    WHERE client_id = ${clientId} AND id IN (${sql.join(siteIds.map((id) => sql`${id}`), sql`, `)})
  `)) as { rows?: Array<{ id: number } & Parameters<typeof siteChecklistTimesFromRow>[0]> }).rows ?? [];
  for (const row of rows) result.set(Number(row.id), siteChecklistTimesFromRow(row));
  for (const siteId of siteIds) {
    if (!result.has(siteId)) result.set(siteId, siteChecklistDueTimes({}));
  }
  return result;
}
