// Shared helpers for contractor compliance flags (public liability expiry & DBS age).
// Used by the contractor list and detail views to surface review prompts.

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export type LiabilityStatus = "none" | "expired" | "expiring" | "ok";

/** Days until (positive) or since (negative) the given date, from today. */
function daysUntil(value: unknown): number | null {
  if (!value) return null;
  const target = new Date(value as string | number | Date);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / MS_PER_DAY);
}

/** Classify public liability insurance expiry: expired, expiring within 30 days, or ok. */
export function liabilityStatus(expiry: unknown): LiabilityStatus {
  const days = daysUntil(expiry);
  if (days === null) return "none";
  if (days < 0) return "expired";
  if (days <= 30) return "expiring";
  return "ok";
}

/** DBS checks older than 3 years get a "review recommended" prompt (not a hard rule). */
export function dbsNeedsReview(dbsCheckDate: unknown): boolean {
  const days = daysUntil(dbsCheckDate);
  if (days === null) return false;
  // days is negative when in the past; older than 3 years ≈ -1095 days
  return days < -365 * 3;
}
