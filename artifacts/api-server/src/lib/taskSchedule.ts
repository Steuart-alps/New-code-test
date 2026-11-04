/**
 * Occurrence rules for staff tasks (routes/tasks.ts). Occurrences are derived
 * from a task's start date and recurrence when read; nothing is generated
 * ahead of time. All dates are calendar dates (YYYY-MM-DD) with no time zone.
 *
 *  - once:    on its start date only (the due date).
 *  - daily:   every day from the start date.
 *  - weekly:  on the start date's weekday, from the start date.
 *  - monthly: on the start date's day of the month, or the last day of a
 *             shorter month (a task starting on the 31st falls on 30 April).
 */
export type TaskRecurrence = "once" | "daily" | "weekly" | "monthly";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parts(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m, d };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function occursOn(task: { recurrence: string; startsOn: string }, day: string): boolean {
  if (day < task.startsOn) return false;
  switch (task.recurrence) {
    case "once":
      return day === task.startsOn;
    case "daily":
      return true;
    case "weekly":
      return new Date(`${day}T00:00:00Z`).getUTCDay() === new Date(`${task.startsOn}T00:00:00Z`).getUTCDay();
    case "monthly": {
      const start = parts(task.startsOn);
      const cur = parts(day);
      return cur.d === Math.min(start.d, daysInMonth(cur.y, cur.m));
    }
    default:
      return false;
  }
}

/** Calendar months after a day, clamped to the month's last day. */
export function addMonthsToDay(day: string, months: number): string {
  const { y, m, d } = parts(day);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  first.setUTCDate(Math.min(d, daysInMonth(first.getUTCFullYear(), first.getUTCMonth() + 1)));
  return first.toISOString().slice(0, 10);
}

/** Today's calendar date in the given IANA zone (UK by default). */
export function todayIn(timeZone = "Europe/London", now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
}
