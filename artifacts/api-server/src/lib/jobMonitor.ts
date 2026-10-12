/**
 * Scheduled-job bookkeeping: failure capture, last-success records, in-flight
 * tracking for graceful shutdown, and the stale-job note in `/readyz`.
 *
 * Every scheduled job runs through runMonitoredJob. A failure is logged and
 * sent to Sentry (when SENTRY_DSN is set); success stamps
 * scheduled_job_runs.last_success_at. Daily jobs whose last success is older
 * than 26 hours are listed in `/readyz` details (informational: readiness does
 * not fail because of them).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { Sentry } from "./sentry";

const STALE_DAILY_JOB_MS = 26 * 60 * 60 * 1000;
const processStartedAt = Date.now();

const dailyJobs = new Set<string>();
const lastSuccess = new Map<string, number>();
const inFlight = new Set<Promise<unknown>>();
let accepting = true;

/** Report this job in `/readyz` when it has not succeeded for 26 hours. */
export function registerDailyJob(name: string): void {
  dailyJobs.add(name);
}

/** Send a background failure to Sentry, tagged with the job name. Never throws. */
export function captureJobFailure(job: string, err: unknown): void {
  if (!process.env.SENTRY_DSN) return;
  try {
    Sentry.captureException(err, { tags: { job } });
  } catch {
    // Monitoring must never break the job loop.
  }
}

async function recordRun(job: string, outcome: "started" | "success" | "failure"): Promise<void> {
  const column = outcome === "started" ? sql`last_started_at` : outcome === "success" ? sql`last_success_at` : sql`last_failure_at`;
  await db.execute(sql`
    INSERT INTO scheduled_job_runs (job_name, ${column}, updated_at)
    VALUES (${job}, now(), now())
    ON CONFLICT (job_name) DO UPDATE SET ${column} = now(), updated_at = now()
  `);
}

/**
 * Run one scheduled job: skipped once shutdown has begun; failures are
 * logged, captured and recorded instead of thrown. Resolves with the job's
 * result, or undefined when it failed or was skipped.
 */
export function runMonitoredJob<T>(job: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (!accepting) return Promise.resolve(undefined);
  const run = (async () => {
    await recordRun(job, "started").catch(() => {});
    try {
      const result = await fn();
      lastSuccess.set(job, Date.now());
      await recordRun(job, "success").catch((err) => logger.warn({ err, job }, "Could not record job success"));
      return result;
    } catch (err) {
      logger.error({ err, job }, `Scheduled job failed: ${job}`);
      captureJobFailure(job, err);
      await recordRun(job, "failure").catch(() => {});
      return undefined;
    }
  })();
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
  return run;
}

/** Load last-success times recorded by earlier processes (best-effort). */
export async function loadJobRunHistory(): Promise<void> {
  try {
    const rows = await db.execute(sql`SELECT job_name, last_success_at FROM scheduled_job_runs WHERE last_success_at IS NOT NULL`);
    for (const row of rows.rows as Array<{ job_name: string; last_success_at: string | Date }>) {
      const at = new Date(row.last_success_at).getTime();
      if (Number.isFinite(at) && at > (lastSuccess.get(row.job_name) ?? 0)) lastSuccess.set(row.job_name, at);
    }
  } catch (err) {
    logger.warn({ err }, "Could not load scheduled job history");
  }
}

/** Last recorded success of a job, from the database (null if never). */
export async function getJobLastSuccess(job: string): Promise<Date | null> {
  const rows = await db.execute(sql`SELECT last_success_at FROM scheduled_job_runs WHERE job_name = ${job}`);
  const value = (rows.rows[0] as { last_success_at?: string | Date | null } | undefined)?.last_success_at;
  return value ? new Date(value) : null;
}

/**
 * Daily jobs with no success in the last 26 hours. A job that has never run is
 * measured from this process's start, so a fresh deploy is not reported stale.
 */
export function getStaleDailyJobs(now = Date.now()): string[] {
  return [...dailyJobs]
    .filter((job) => now - (lastSuccess.get(job) ?? processStartedAt) > STALE_DAILY_JOB_MS)
    .sort();
}

/** Stop starting new job runs (graceful shutdown). */
export function stopAcceptingJobs(): void {
  accepting = false;
}

/** Wait for running jobs to finish, up to `timeoutMs`. Resolves true when all finished. */
export async function waitForInFlightJobs(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const all = Promise.allSettled([...inFlight]).then(() => true as const);
  const finished = await Promise.race([all, timeout]);
  if (timer) clearTimeout(timer);
  return finished;
}
