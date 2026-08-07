// Bundled by tests/contractor-compliance-reminders.mjs so the plain-Node test
// can exercise the real TypeScript job implementation against the dev database.
export {
  runContractorComplianceReminderJob,
  getContractorComplianceAlerts,
  INSURANCE_LEAD_DAYS,
  DBS_MAX_AGE_YEARS,
} from "../src/lib/contractorComplianceReminders";
export { db, pool } from "@workspace/db";
export { clientsTable, usersTable, contractorsTable } from "@workspace/db/schema";
export { sql, eq, inArray, and } from "drizzle-orm";
