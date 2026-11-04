import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Last run of each scheduled background job, so `/readyz` can report daily
 * jobs that have not succeeded recently and missed weekly jobs can catch up
 * after a restart. Holds job names and timestamps only (no error text).
 */
export const scheduledJobRunsTable = pgTable("scheduled_job_runs", {
  jobName: text("job_name").primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Expiring delivery leases for scheduled reminder emails. A worker claims
 * (job, delivery key) before sending; the claim expires if the worker dies, so
 * a later run can retry with the same provider idempotency key. `sent_at` is
 * set once the provider accepted the message.
 */
export const scheduledEmailClaimsTable = pgTable("scheduled_email_claims", {
  job: text("job").notNull(),
  deliveryKey: text("delivery_key").notNull(),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.job, table.deliveryKey] })]);

export type ScheduledJobRun = typeof scheduledJobRunsTable.$inferSelect;
