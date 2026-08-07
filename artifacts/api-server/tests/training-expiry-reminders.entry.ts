// Bundled by tests/training-expiry-reminders.mjs so the plain-Node test can
// exercise the real TypeScript job implementation against the dev database.
export {
  runTrainingExpiryReminderJob,
  getTrainingExpiryAlerts,
  TRAINING_LEAD_DAYS,
} from "../src/lib/trainingExpiryReminders";
export { db, pool } from "@workspace/db";
export { clientsTable, usersTable } from "@workspace/db/schema";
export { sql, eq, inArray, and } from "drizzle-orm";
