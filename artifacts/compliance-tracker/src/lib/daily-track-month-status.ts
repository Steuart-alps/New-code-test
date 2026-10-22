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

export const DAILY_TRACK_REQUIREMENTS = [
  "kitchen_opening", "premises_opening", "kitchen_closing", "premises_closing", "signoff",
] as const;

export type DailyTrackRequirement = (typeof DAILY_TRACK_REQUIREMENTS)[number];

/**
 * GET /daily-track-status/history. `requirements` lists the checks the client's
 * services make each site responsible for (a KitchenTrack-only client has no
 * premises checklists, a DailyTrack AM-only client no PM checks or sign-off).
 */
export interface DailyTrackHistory {
  requirements: DailyTrackRequirement[];
  checklists: HistoryChecklist[];
  signoffs: HistorySignoff[];
}

export type RecordStatus = "submitted" | "draft" | "none";
export type DayStatus = "complete" | "partial" | "missing" | "future";

/** Keeps the known requirements of a history response, in display order. */
export function parseDailyTrackHistory(body: unknown): DailyTrackHistory {
  const data = (body ?? {}) as Partial<Record<keyof DailyTrackHistory, unknown>>;
  if (!Array.isArray(data.requirements) || !Array.isArray(data.checklists) || !Array.isArray(data.signoffs)) {
    throw new Error("Unexpected checklist history response");
  }
  const requirements = data.requirements as unknown[];
  return {
    requirements: DAILY_TRACK_REQUIREMENTS.filter(key => requirements.includes(key)),
    checklists: data.checklists as HistoryChecklist[],
    signoffs: data.signoffs as HistorySignoff[],
  };
}

/**
 * One day's state of every enabled requirement per site, keyed `site:requirement`.
 * Duplicate rows collapse and a submitted row wins over a draft; site-less rows,
 * other sites and requirements outside the client's services are ignored, so
 * none of them can make an incomplete day look complete.
 */
function dayRecords(date: string, siteIds: Set<number>, history: DailyTrackHistory): Map<string, "submitted" | "draft"> {
  const requirements = new Set<string>(history.requirements);
  const records = new Map<string, "submitted" | "draft">();
  const add = (siteId: number | null, requirement: string, submittedAt: string | null) => {
    if (siteId == null || !siteIds.has(siteId) || !requirements.has(requirement)) return;
    const key = `${siteId}:${requirement}`;
    if (submittedAt) records.set(key, "submitted");
    else if (!records.has(key)) records.set(key, "draft");
  };
  for (const record of history.checklists) {
    if (record.checkDate === date && record.checklistType !== "signoff") {
      add(record.siteId, record.checklistType, record.submittedAt);
    }
  }
  for (const record of history.signoffs) {
    if (record.signoffDate === date) add(record.siteId, "signoff", record.submittedAt);
  }
  return records;
}

/** Each site's status for each enabled requirement on one day (the day grid). */
export function siteDayStatuses(
  date: string,
  sites: { id: number }[],
  history: DailyTrackHistory,
): Map<number, Partial<Record<DailyTrackRequirement, RecordStatus>>> {
  const records = dayRecords(date, new Set(sites.map(site => site.id)), history);
  return new Map(sites.map(site => [site.id, Object.fromEntries(history.requirements.map(requirement =>
    [requirement, records.get(`${site.id}:${requirement}`) ?? "none"],
  ))]));
}

export function monthDayStatuses(
  month: string,
  today: string,
  sites: { id: number }[],
  history: DailyTrackHistory,
): { date: string; status: DayStatus; submitted: number; started: number; expected: number }[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const siteIds = new Set(sites.map(site => site.id));
  const expected = siteIds.size * history.requirements.length;
  const days = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    if (date > today) {
      days.push({ date, status: "future" as const, submitted: 0, started: 0, expected });
      continue;
    }
    const records = [...dayRecords(date, siteIds, history).values()];
    const submitted = records.filter(state => state === "submitted").length;
    const status: DayStatus = expected !== 0 && submitted >= expected
      ? "complete" : records.length > 0 ? "partial" : "missing";
    days.push({ date, status, submitted, started: records.length, expected });
  }
  return days;
}
