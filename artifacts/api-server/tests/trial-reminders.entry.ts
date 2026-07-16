// Bundled by tests/trial-reminders.mjs so the plain-Node test can exercise the
// real TypeScript job implementation against the dev database.
export { runTrialReminderJob, TRIAL_REMINDER_LEAD_DAYS } from "../src/lib/trialReminders";
export { db, pool } from "@workspace/db";
export { clientsTable, usersTable } from "@workspace/db/schema";
export { sql, eq, inArray, and, isNull } from "drizzle-orm";
