/**
 * When SafeTrack acknowledgement reminders go out. Shared by the API scheduler
 * and the Settings preview so the two cannot disagree.
 *
 * The scheduler checks every five minutes on the UTC clock. An account is due
 * once its local time reaches the delivery time (every day, or Mondays only
 * for the weekly cadence) and no reminder has gone out yet in the current
 * local day (daily) or the local week starting Monday (weekly). The rest of
 * that day stays due, so a reminder held back because nothing was outstanding
 * goes out at the first check after something becomes outstanding.
 */

export const SAFE_TRACK_REMINDER_FREQUENCY_SETTING = "safeTrackReminderFrequency";
export const SAFE_TRACK_REMINDER_TIME_SETTING = "safeTrackReminderTime";
export const DEFAULT_SAFE_TRACK_REMINDER_FREQUENCY = "daily" as const;
export const DEFAULT_SAFE_TRACK_REMINDER_TIME = "08:50";
export const DEFAULT_SAFE_TRACK_REMINDER_TIMEZONE = "Europe/London";
/** Matches the API scheduler's "*\/5 * * * *" cron. */
export const SAFE_TRACK_REMINDER_CHECK_MINUTES = 5;

const CHECK_MS = SAFE_TRACK_REMINDER_CHECK_MINUTES * 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type SafeTrackReminderFrequency = "daily" | "weekly";

export interface SafeTrackReminderSettings {
  frequency: SafeTrackReminderFrequency;
  /** 24-hour HH:MM in the account timezone. */
  time: string;
  timeZone: string;
}

export function parseSafeTrackReminderSettings(
  settings: Record<string, string | null | undefined> = {},
): SafeTrackReminderSettings {
  const frequency = settings[SAFE_TRACK_REMINDER_FREQUENCY_SETTING] === "weekly"
    ? "weekly"
    : DEFAULT_SAFE_TRACK_REMINDER_FREQUENCY;
  const rawTime = settings[SAFE_TRACK_REMINDER_TIME_SETTING] ?? "";
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rawTime) ? rawTime : DEFAULT_SAFE_TRACK_REMINDER_TIME;
  let timeZone = settings.accountTimezone?.trim() || DEFAULT_SAFE_TRACK_REMINDER_TIMEZONE;
  try {
    formatterFor(timeZone);
  } catch {
    timeZone = DEFAULT_SAFE_TRACK_REMINDER_TIMEZONE;
  }
  return { frequency, time, timeZone };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface LocalClock {
  /** Wall-clock time as if it were UTC, in ms. */
  wallMs: number;
  /** Minutes since local midnight. */
  minutes: number;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
}

function localClock(at: Date, timeZone: string): LocalClock {
  const parts = formatterFor(timeZone).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  return {
    wallMs: Date.UTC(Number(value("year")), Number(value("month")) - 1, Number(value("day")), hour, minute, Number(value("second"))),
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS.indexOf(value("weekday")),
  };
}

function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour! * 60 + minute!;
}

/** The instant a local wall-clock time (in UTC-shaped ms) occurs in the zone. */
function wallToInstant(wallMs: number, timeZone: string): Date {
  const offset = (at: number) => localClock(new Date(at), timeZone).wallMs - Math.floor(at / 1000) * 1000;
  // Two passes settle the offset either side of a daylight-saving change.
  let instant = wallMs - offset(wallMs);
  instant = wallMs - offset(instant);
  return new Date(instant);
}

export function isSafeTrackReminderDue(now: Date, settings: SafeTrackReminderSettings): boolean {
  const local = localClock(now, settings.timeZone);
  if (local.minutes < minutesOf(settings.time)) return false;
  return settings.frequency === "daily" || local.weekday === 0;
}

/**
 * Start of the cadence window containing `now`: local midnight today (daily)
 * or on this week's Monday (weekly). One reminder is sent per window.
 */
export function safeTrackReminderWindowStart(now: Date, settings: SafeTrackReminderSettings): Date {
  const local = localClock(now, settings.timeZone);
  const midnight = Math.floor(local.wallMs / DAY_MS) * DAY_MS;
  const daysBack = settings.frequency === "weekly" ? local.weekday : 0;
  return wallToInstant(midnight - daysBack * DAY_MS, settings.timeZone);
}

export interface SafeTrackReminderPreview {
  /** The scheduler check at which the next reminder is expected. */
  at: Date;
  /**
   * True when that check is later than the delivery time on its day: the
   * time has passed in the current window and nothing has gone out yet.
   */
  late: boolean;
}

/**
 * The next scheduler check that would send a reminder, if anything is still
 * awaiting acknowledgement then. Walks the scheduler's own five-minute checks
 * through the same due and once-per-window rules the API applies.
 */
export function nextSafeTrackReminder(
  now: Date,
  settings: SafeTrackReminderSettings,
  lastSentAt: Date | null = null,
): SafeTrackReminderPreview | null {
  const slot = minutesOf(settings.time);
  const first = Math.ceil(now.getTime() / CHECK_MS) * CHECK_MS;
  for (let tick = first; tick <= first + 8 * DAY_MS; tick += CHECK_MS) {
    const at = new Date(tick);
    if (!isSafeTrackReminderDue(at, settings)) continue;
    if (lastSentAt && lastSentAt.getTime() >= safeTrackReminderWindowStart(at, settings).getTime()) continue;
    return { at, late: localClock(at, settings.timeZone).minutes >= slot + SAFE_TRACK_REMINDER_CHECK_MINUTES };
  }
  return null;
}
