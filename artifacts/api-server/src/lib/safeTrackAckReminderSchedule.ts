import { logger } from "./logger";
import { runSafeTrackAckReminderJob } from "./safeTrackAckReminders";

export type CronSchedule = (expression: string, task: () => void | Promise<void>) => unknown;

/** Registers just this job, keeping scheduler wiring independently testable. */
export function registerSafeTrackAckReminderSchedule(
  schedule: CronSchedule,
  run: () => Promise<unknown> = runSafeTrackAckReminderJob,
): void {
  // Tenant preferences decide whether the current local time is due. Running
  // every five minutes lets accounts use their own delivery time and timezone.
  schedule("*/5 * * * *", async () => {
    logger.info("Running SafeTrack acknowledgement reminder job...");
    try {
      const result = await run();
      logger.info({ result }, "SafeTrack acknowledgement reminder job complete");
    } catch (err) {
      logger.error({ err }, "SafeTrack acknowledgement reminder job failed");
    }
  });
}