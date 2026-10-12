import { RIDDOR_CATEGORIES } from "@workspace/db/schema";

export type RiddorCategory = (typeof RIDDOR_CATEGORIES)[number];

/**
 * RIDDOR 2013 reporting windows, counted in calendar days from the incident.
 * Deaths, specified injuries, non-workers taken to hospital and dangerous
 * occurrences must be notified without delay and reported within 10 days;
 * over-7-day injuries within 15 days. Occupational diseases are reported
 * without delay once a written diagnosis is received, so they have no date
 * here. Over-3-day injuries are recorded but not reported.
 */
const REPORT_WINDOW_DAYS: Partial<Record<RiddorCategory, number>> = {
  death: 10,
  specified_injury: 10,
  non_worker_hospital: 10,
  dangerous_occurrence: 10,
  over_7_day_injury: 15,
};
const NOTIFY_WITHOUT_DELAY = new Set<RiddorCategory>([
  "death", "specified_injury", "non_worker_hospital", "dangerous_occurrence", "occupational_disease",
]);

export function isRiddorCategory(value: unknown): value is RiddorCategory {
  return typeof value === "string" && (RIDDOR_CATEGORIES as readonly string[]).includes(value);
}

/** Every category except over-3-day injuries is reportable to the HSE. */
export function isReportableRiddorCategory(category: RiddorCategory): boolean {
  return category !== "over_3_day_record_only";
}

export type RiddorDeadlineState = "reported" | "overdue" | "due" | "on_diagnosis" | "record_only";

export interface RiddorDeadline {
  category: RiddorCategory;
  /** Last day to report (YYYY-MM-DD), or null where no fixed window applies. */
  reportBy: string | null;
  notifyWithoutDelay: boolean;
  state: RiddorDeadlineState;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in the UK. */
export function ukToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}

/** The reporting deadline for an incident with a RIDDOR category, or null. */
export function riddorDeadline(
  incident: { riddorCategory: string | null; incidentDate: string; reportedToHse: boolean },
  today: string = ukToday(),
): RiddorDeadline | null {
  const category = incident.riddorCategory;
  if (!isRiddorCategory(category)) return null;
  const notifyWithoutDelay = NOTIFY_WITHOUT_DELAY.has(category);
  const window = REPORT_WINDOW_DAYS[category];
  const reportBy = window === undefined ? null : addDays(incident.incidentDate, window);
  let state: RiddorDeadlineState;
  if (category === "over_3_day_record_only") state = "record_only";
  else if (incident.reportedToHse) state = "reported";
  else if (reportBy === null) state = "on_diagnosis";
  else state = today > reportBy ? "overdue" : "due";
  return { category, reportBy, notifyWithoutDelay, state };
}

/** Adds the computed RIDDOR deadline to an incident response. */
export function withRiddorDeadline<T extends { riddorCategory: string | null; incidentDate: string; reportedToHse: boolean }>(incident: T) {
  return { ...incident, riddorDeadline: riddorDeadline(incident) };
}
