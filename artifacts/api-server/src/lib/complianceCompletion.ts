/** Completion and recurrence of compliance checks (shared by routes). */

/** Calendar months after a date (UTC), clamped to the month's last day. */
export function addMonthsUtc(date: Date, months: number): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return start;
}

/**
 * Completing a check that has a repeat interval records the completion
 * (completedAt, plus the audit event written by the caller) and reopens the
 * check as pending, due the interval after the completion date. A check with
 * no interval simply stays completed, as before.
 */
export function completionFields(frequencyMonths: number | null | undefined, completedAt: Date) {
  if (!frequencyMonths || frequencyMonths < 1) {
    return { recurring: false as const, fields: { status: "completed" as const, completedAt } };
  }
  return {
    recurring: true as const,
    fields: { status: "pending" as const, completedAt, dueDate: addMonthsUtc(completedAt, frequencyMonths) },
  };
}

/** A YYYY-MM-DD completion date as stored (midnight UTC of that day, as the
 *  setup wizard stores "last done" dates). */
export function completionDateFromDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}
