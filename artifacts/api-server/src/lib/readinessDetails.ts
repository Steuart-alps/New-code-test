/**
 * Informational notes shown under `details` in `/readyz`. They never change
 * the readiness status. `/readyz` is public, so notes are fixed, non-secret
 * strings (configuration names and job names only).
 */
import { getStaleDailyJobs } from "./jobMonitor";
import type { ReadinessReport } from "./stripeStartup";

const notes = new Map<string, unknown>();

/** Set (or clear, with null) a named readiness note. */
export function setReadinessNote(name: string, value: unknown): void {
  if (value === null || value === undefined) notes.delete(name);
  else notes.set(name, value);
}

export function getReadinessDetails(): Record<string, unknown> {
  const details: Record<string, unknown> = Object.fromEntries(notes);
  const staleDailyJobs = getStaleDailyJobs();
  if (staleDailyJobs.length > 0) details.staleDailyJobs = staleDailyJobs;
  return details;
}

/** Attach the current notes (if any) to a /readyz report without changing its status. */
export function withReadinessDetails(report: ReadinessReport): ReadinessReport {
  const details = getReadinessDetails();
  if (Object.keys(details).length > 0) report.body.details = details;
  return report;
}
