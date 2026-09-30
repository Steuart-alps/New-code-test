export interface HistoryChecklist {
  checkDate: string;
  siteId: number | null;
  checklistType: string;
  submittedAt: string | null;
}

export interface HistorySignoff {
  signoffDate: string;
  siteId: number | null;
  submittedAt: string | null;
}

export type DayStatus = "complete" | "partial" | "missing" | "future";

const REQUIREMENTS = [
  "kitchen_opening", "premises_opening", "kitchen_closing", "premises_closing", "signoff",
] as const;

export function monthDayStatuses(
  month: string,
  today: string,
  sites: { id: number }[],
  checklists: HistoryChecklist[],
  signoffs: HistorySignoff[],
): { date: string; status: DayStatus; submitted: number; started: number }[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const siteIds = new Set(sites.map(site => site.id));
  const expectedPerDay = siteIds.size * REQUIREMENTS.length;
  const requirements = new Set<string>(REQUIREMENTS);
  const days = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    if (date > today) {
      days.push({ date, status: "future" as const, submitted: 0, started: 0 });
      continue;
    }
    // Distinct (site, requirement) pairs prevent duplicate and site-less
    // records from making an incomplete day look complete.
    const started = new Set<string>();
    const done = new Set<string>();
    for (const record of checklists) {
      if (record.checkDate !== date || record.siteId == null ||
        !siteIds.has(record.siteId) || !requirements.has(record.checklistType)) continue;
      const key = `${record.siteId}:${record.checklistType}`;
      started.add(key);
      if (record.submittedAt) done.add(key);
    }
    for (const record of signoffs) {
      if (record.signoffDate !== date || record.siteId == null || !siteIds.has(record.siteId)) continue;
      const key = `${record.siteId}:signoff`;
      started.add(key);
      if (record.submittedAt) done.add(key);
    }
    const status: DayStatus = expectedPerDay !== 0 && done.size >= expectedPerDay
      ? "complete" : started.size > 0 ? "partial" : "missing";
    days.push({ date, status, submitted: done.size, started: started.size });
  }
  return days;
}