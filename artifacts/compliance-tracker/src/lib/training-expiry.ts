const DAY_MS = 86_400_000;

export type TrainingExpiryState = "overdue" | "expiring_soon" | "current" | "no_expiry";

/** Compare calendar dates, not elapsed hours: DST must not shift a warning. */
export function getTrainingExpiry(
  expiryDate?: string | null,
  today = new Date(),
): { days: number | null; state: TrainingExpiryState } {
  if (!expiryDate) return { days: null, state: "no_expiry" };
  const [year, month, day] = expiryDate.split("-").map(Number);
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.floor((Date.UTC(year, month - 1, day) - todayUtc) / DAY_MS);
  return {
    days,
    state: days < 0 ? "overdue" : days <= 30 ? "expiring_soon" : "current",
  };
}

export function compareTrainingExpiry<T extends { expiryDate?: string | null; staffName: string }>(
  a: T, b: T, today = new Date(),
): number {
  const rank: Record<TrainingExpiryState, number> = {
    overdue: 0, expiring_soon: 1, current: 2, no_expiry: 3,
  };
  return rank[getTrainingExpiry(a.expiryDate, today).state] -
    rank[getTrainingExpiry(b.expiryDate, today).state] ||
    (a.expiryDate ?? "9999-12-31").localeCompare(b.expiryDate ?? "9999-12-31") ||
    a.staffName.localeCompare(b.staffName);
}