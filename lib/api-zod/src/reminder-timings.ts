/**
 * When each kind of reminder goes to the person responsible, set per business
 * in Settings → Reminder Notifications and used by the API's personal
 * reminder job (artifacts/api-server/src/lib/personalReminders.ts).
 *
 * Each type has:
 *   - daysBefore: the reminder is in the 08:00 email this many days before the
 *     due (or expiry) date; 0 is on the day itself, null switches the
 *     reminders for that type off, and "next_week" lists it instead in a
 *     Friday 08:00 email of what is due the following Monday to Sunday (not
 *     for expiries). Expiries also get a reminder the day before.
 *   - overdueEvery: once overdue, the item is in the email the day after it
 *     was due and then every this many days; 0 means only that once.
 * Types left unset use the defaults: 1 day before (30 for expiries) and every
 * 7 days when overdue.
 *
 * Stored as JSON under the "reminderTimings" setting.
 */

export const REMINDER_TIMINGS_SETTING = "reminderTimings";

/** daysBefore value for the Friday "due next week" email. */
export const NEXT_WEEK = "next_week";

export interface ReminderTiming {
  daysBefore: number | typeof NEXT_WEEK | null;
  overdueEvery: number;
}

export interface ReminderType {
  /** Track module key, or "tasks" / "contractors". */
  key: string;
  label: string;
  /** Expiry dates (training, contractor documents) rather than due dates. */
  expiry?: boolean;
}

export const REMINDER_TYPES: readonly ReminderType[] = [
  { key: "fire", label: "FireTrack checks" },
  { key: "legionella", label: "LegionellaTrack checks" },
  { key: "pool", label: "AquaTrack water tests" },
  { key: "hot_tub", label: "TubTrack checks" },
  { key: "coshh", label: "COSHHTrack reviews and checks" },
  { key: "pat", label: "PATtrack testing" },
  { key: "pest", label: "PestTrack visits" },
  { key: "premises", label: "PremisesTrack inspections" },
  { key: "green", label: "GreenTrack servicing and examinations" },
  { key: "tree", label: "TreeTrack assessments" },
  { key: "bike", label: "BikeTrack servicing" },
  { key: "doc", label: "DocTrack document reviews" },
  { key: "safe", label: "SafeTrack risk assessment reviews" },
  { key: "compliance", label: "Compliance checks (gas, EICR, LOLER…)" },
  { key: "fix", label: "FixTrack issues" },
  { key: "tasks", label: "Staff tasks" },
  { key: "train", label: "Staff training expiring", expiry: true },
  { key: "contractors", label: "Contractor insurance, DBS and certificates expiring", expiry: true },
];

/** Track actions follow the timing of their track. */
export const DEFAULT_DUE_DAYS_BEFORE = 1;
export const DEFAULT_EXPIRY_DAYS_BEFORE = 30;
export const DEFAULT_OVERDUE_EVERY = 7;
export const MAX_DAYS_BEFORE = 60;
export const MAX_OVERDUE_EVERY = 30;

/** Choices offered on the Settings screen. */
export const DAYS_BEFORE_CHOICES = [0, 1, 2, 3, 7, 14, 30, 60] as const;
export const OVERDUE_EVERY_CHOICES = [0, 1, 3, 7, 14, 28] as const;

export function defaultReminderTiming(type: Pick<ReminderType, "expiry"> | undefined): ReminderTiming {
  return {
    daysBefore: type?.expiry ? DEFAULT_EXPIRY_DAYS_BEFORE : DEFAULT_DUE_DAYS_BEFORE,
    overdueEvery: DEFAULT_OVERDUE_EVERY,
  };
}

const isWhole = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

/**
 * Validate a stored or submitted value: the timings it sets, or an error for
 * an unknown type or a malformed entry.
 */
export function validateReminderTimings(raw: unknown):
  { ok: true; value: Record<string, ReminderTiming> } | { ok: false; error: string } {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return { ok: false, error: "Reminder timings must be valid JSON" };
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Reminder timings must be an object" };
  }
  const value: Record<string, ReminderTiming> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!REMINDER_TYPES.some((type) => type.key === key)) return { ok: false, error: `Unknown reminder type: ${key}` };
    const timing = entry as Partial<ReminderTiming> | null;
    if (timing == null || typeof timing !== "object") return { ok: false, error: `Reminder timing for ${key} is invalid` };
    if (timing.daysBefore === NEXT_WEEK) {
      if (REMINDER_TYPES.find((type) => type.key === key)?.expiry) {
        return { ok: false, error: `The weekly "due next week" email isn't available for ${key}` };
      }
    } else if (timing.daysBefore !== null && !isWhole(timing.daysBefore, MAX_DAYS_BEFORE)) {
      return { ok: false, error: `Days before for ${key} must be a whole number from 0 to ${MAX_DAYS_BEFORE}, or off` };
    }
    if (!isWhole(timing.overdueEvery, MAX_OVERDUE_EVERY)) {
      return { ok: false, error: `Overdue repeat for ${key} must be a whole number of days from 0 to ${MAX_OVERDUE_EVERY}` };
    }
    value[key] = { daysBefore: timing.daysBefore, overdueEvery: timing.overdueEvery };
  }
  return { ok: true, value };
}

/** The timings in force: stored entries over the defaults. A bad stored value falls back to the defaults. */
export function resolveReminderTimings(raw: unknown, defaults: Partial<Record<string, ReminderTiming>> = {}): Record<string, ReminderTiming> {
  const stored = validateReminderTimings(raw ?? {});
  const result: Record<string, ReminderTiming> = {};
  for (const type of REMINDER_TYPES) {
    result[type.key] = (stored.ok ? stored.value[type.key] : undefined) ?? defaults[type.key] ?? defaultReminderTiming(type);
  }
  return result;
}
