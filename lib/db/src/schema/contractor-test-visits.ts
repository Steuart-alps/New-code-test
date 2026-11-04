import { check, date, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { contractorsTable } from "./contractors";
import { usersTable } from "./users";
import { patCertificatesTable } from "./pat-track";

/**
 * A contractor's testing visit logged through a link (api-server
 * src/routes/contractor-tests.ts). A manager sets up the visit for one site
 * and one track (PATrack for now) and the link is emailed to the contractor.
 * The contractor signs in at the site (contractor_sign_ins), logs a pass or
 * fail for each item, then signs off with their own certificate. Results are
 * saved straight onto the track (pat_tests.contractor_test_visit_id); sign-off
 * adds the track's certificate record. Also created by the runtime migrations.
 *
 * status: open (link works until expires_at), signed_off, or ended (a manager
 * closed the link). The link token is stored only as a digest.
 */
export const contractorTestVisitModules = ["pat"] as const;
export const contractorTestVisitStatuses = ["open", "signed_off", "ended"] as const;
export const contractorTestVisitsTable = pgTable("contractor_test_visits", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  module: text("module").notNull().default("pat"),
  contractorId: integer("contractor_id").references(() => contractorsTable.id, { onDelete: "set null" }),
  contractorName: text("contractor_name").notNull(),
  contractorEmail: text("contractor_email"),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  linkTokenHash: text("link_token_hash").notNull(),
  status: text("status").notNull().default("open"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Sign-off: the contractor's own certificate and their signature.
  signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
  signedOffName: text("signed_off_name"),
  signedOffCompany: text("signed_off_company"),
  signedOffSignature: text("signed_off_signature"),
  certificateRef: text("certificate_ref"),
  nextTestDue: date("next_test_due"),
  signOffNotes: text("sign_off_notes"),
  certificateObjectPath: text("certificate_object_path"),
  certificateFileName: text("certificate_file_name"),
  patCertificateId: integer("pat_certificate_id").references(() => patCertificatesTable.id, { onDelete: "set null" }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedBy: integer("ended_by").references(() => usersTable.id, { onDelete: "set null" }),
}, (table) => [
  uniqueIndex("uq_contractor_test_visits_link_token").on(table.linkTokenHash),
  index("idx_contractor_test_visits_site").on(table.clientId, table.siteId, table.createdAt),
  check("ck_contractor_test_visits_module", sql`${table.module} IN ('pat')`),
  check("ck_contractor_test_visits_status", sql`${table.status} IN ('open', 'signed_off', 'ended')`),
]);

export type ContractorTestVisit = typeof contractorTestVisitsTable.$inferSelect;
