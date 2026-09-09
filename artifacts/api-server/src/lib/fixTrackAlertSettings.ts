export const DEFAULT_FIX_TRACK_STALE_DAYS = 7;

/** Parse the persisted/API value without accepting decimals or partial strings. */
export function parseFixTrackStaleDays(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : null;
}