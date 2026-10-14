/**
 * The account's local calendar. Due dates, "today's" checklists and the record
 * lock all follow the business's configured timezone (Settings, default
 * Europe/London), never the server's UTC clock: between 00:00 and 01:00 BST
 * the UTC date is still yesterday.
 */

import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import {
  ACCOUNT_TIMEZONE_SETTING,
  DEFAULT_ACCOUNT_TIMEZONE,
  normalizeAccountTimezone,
} from "../middleware/dailyEntryCutoff";

const MS_DAY = 86_400_000;

/** Calendar date (YYYY-MM-DD) at `now` in the given IANA timezone. */
export function localDateIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: normalizeAccountTimezone(timeZone),
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Shift a YYYY-MM-DD date by whole calendar days (no clock arithmetic). */
export function addCalendarDays(isoDate: string, days: number): string {
  const day = Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / MS_DAY) + days;
  return new Date(day * MS_DAY).toISOString().slice(0, 10);
}

/** The client's configured timezone, falling back to Europe/London. */
export async function getAccountTimezone(clientId: number): Promise<string> {
  try {
    const [row] = await db.select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, ACCOUNT_TIMEZONE_SETTING)))
      .limit(1);
    return normalizeAccountTimezone(row?.value);
  } catch {
    return DEFAULT_ACCOUNT_TIMEZONE;
  }
}

/** Today's date in the client's timezone. */
export async function getAccountToday(clientId: number, now: Date = new Date()): Promise<string> {
  return localDateIn(await getAccountTimezone(clientId), now);
}

/** Milliseconds the zone's wall clock is ahead of UTC at the given instant. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const wallClock = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return wallClock - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which a local date and time (as recorded on a check form)
 * occurred in the given timezone. A time missing from the record means the
 * start of that local day.
 */
export function zonedDateTimeToUtc(isoDate: string, time: string | null | undefined, timeZone: string): Date {
  const zone = normalizeAccountTimezone(timeZone);
  const [hour = 0, minute = 0, second = 0] = String(time ?? "").split(":").map(part => Number(part) || 0);
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  const wallClock = Date.UTC(year!, month! - 1, day!, hour, minute, Math.floor(second));
  // Two passes settle the offset either side of a daylight-saving change.
  let instant = wallClock - zoneOffsetMs(new Date(wallClock), zone);
  instant = wallClock - zoneOffsetMs(new Date(instant), zone);
  return new Date(instant);
}
