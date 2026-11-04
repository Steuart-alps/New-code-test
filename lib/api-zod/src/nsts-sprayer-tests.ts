/**
 * When a sprayer's National Sprayer Testing Scheme (NSTS) test is due. Shared
 * by the API (which fills in the next test date) and GreenTrack's page (which
 * shows each sprayer's status) so the two cannot disagree.
 *
 * Plant Protection Products (Sustainable Use) Regulations 2012: every
 * pesticide application machine is first tested before it is five years old,
 * then booms wider than 3 m and air-assisted sprayers every 3 years, and booms
 * of 3 m or less and other application equipment every 6 years. Knapsack and
 * hand-held sprayers need no formal test but a competent person's recorded
 * inspection; GreenTrack suggests one a year.
 */

export const NSTS_TEST_INSPECTION_TYPE = "nsts_test";
/** The first test is due before the machine is this many years old. */
export const NSTS_FIRST_TEST_MAX_AGE_YEARS = 5;
/** Days before the due date that a test shows as due soon. */
export const NSTS_DUE_SOON_DAYS = 60;

export const NSTS_SPRAYER_CATEGORIES = {
  boom_over_3m:      { label: "Boom sprayer wider than 3 m",                          retestYears: 3, formalTest: true },
  air_assisted:      { label: "Air-assisted sprayer",                                 retestYears: 3, formalTest: true },
  boom_3m_or_less:   { label: "Boom sprayer 3 m or narrower",                         retestYears: 6, formalTest: true },
  other_application: { label: "Other application equipment (granular, weed wiper)", retestYears: 6, formalTest: true },
  knapsack_handheld: { label: "Knapsack or hand-held sprayer",                        retestYears: 1, formalTest: false },
} as const;

export type NstsSprayerCategory = keyof typeof NSTS_SPRAYER_CATEGORIES;

export function isNstsSprayerCategory(value: unknown): value is NstsSprayerCategory {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NSTS_SPRAYER_CATEGORIES, value);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `day` (YYYY-MM-DD) plus whole years; 29 February falls back to the 28th. */
export function addYearsIso(day: string, years: number): string | null {
  const match = ISO_DAY.exec(day.slice(0, 10));
  if (!match) return null;
  const year = Number(match[1]) + years;
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayOfMonth = Math.min(Number(match[3]), lastDay);
  return `${String(year).padStart(4, "0")}-${match[2]}-${String(dayOfMonth).padStart(2, "0")}`;
}

/** The next test after one on `testDate`, or null for an unknown category. */
export function nstsNextTestDate(category: unknown, testDate: string): string | null {
  if (!isNstsSprayerCategory(category)) return null;
  return addYearsIso(testDate, NSTS_SPRAYER_CATEGORIES[category].retestYears);
}

/**
 * When an untested sprayer's first test (or, for a knapsack, first check) is
 * due: from the purchase date when known, else from 1 January of its year.
 */
export function nstsFirstTestDueDate(
  category: unknown,
  machine: { purchaseDate?: string | null; year?: number | null },
): string | null {
  if (!isNstsSprayerCategory(category)) return null;
  const years = NSTS_SPRAYER_CATEGORIES[category].formalTest ? NSTS_FIRST_TEST_MAX_AGE_YEARS : 1;
  const from = machine.purchaseDate
    ? machine.purchaseDate
    : Number.isInteger(machine.year) && machine.year! > 0 ? `${String(machine.year).padStart(4, "0")}-01-01` : null;
  return from ? addYearsIso(from, years) : null;
}

export type NstsState = "overdue" | "due_soon" | "ok" | "unknown";

export interface NstsStatus {
  /** When the next test is due; null when neither a test nor a date is known. */
  dueDate: string | null;
  /** Whether the date follows the latest test or is the first test's deadline. */
  basis: "latest_test" | "first_test" | null;
  state: NstsState;
}

/**
 * A sprayer's NSTS status on `today` (YYYY-MM-DD). The latest test's own next
 * date wins (it may have been typed, for example for a yearly assurance
 * scheme test); without one it is worked out from the category.
 */
export function nstsStatus(
  category: unknown,
  machine: { purchaseDate?: string | null; year?: number | null },
  latestTest: { inspectionDate: string; nextInspectionDate?: string | null } | null,
  today: string,
): NstsStatus {
  const dueDate = latestTest
    ? latestTest.nextInspectionDate || nstsNextTestDate(category, latestTest.inspectionDate)
    : nstsFirstTestDueDate(category, machine);
  const basis = dueDate ? (latestTest ? "latest_test" : "first_test") : null;
  if (!dueDate) return { dueDate: null, basis, state: "unknown" };
  if (dueDate < today) return { dueDate, basis, state: "overdue" };
  const soon = addDaysIso(today, NSTS_DUE_SOON_DAYS);
  return { dueDate, basis, state: soon && dueDate <= soon ? "due_soon" : "ok" };
}

function addDaysIso(day: string, days: number): string | null {
  const match = ISO_DAY.exec(day.slice(0, 10));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}
