// Bundled by tests/contractor-compliance-reminders.mjs so the plain-Node test
// can exercise the real TypeScript job implementation against the dev database.
export {
  runContractorComplianceReminderJob,
  getContractorComplianceAlerts,
  INSURANCE_LEAD_DAYS,
  DEFAULT_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
  MIN_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
  MAX_CONTRACTOR_COMPLIANCE_LEAD_DAYS,
  parseContractorComplianceLeadDays,
  DBS_MAX_AGE_YEARS,
} from "../src/lib/contractorComplianceReminders";
export { db, pool } from "@workspace/db";
export { clientsTable, usersTable, contractorsTable, fixTrackIssuesTable } from "@workspace/db/schema";
export { sql, eq, inArray, and } from "drizzle-orm";
export { runRuntimeMigrations } from "../src/lib/runtimeMigrations";
export { reencryptQueuedTokenPayloads } from "../src/lib/runtimeMigrations";
export {
  encryptTokenPayload,
  decryptTokenPayload,
  tokenPayloadNeedsReencryption,
} from "../src/lib/bearerTokens";
