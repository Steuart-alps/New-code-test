import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { contractorsTable } from "./contractors";
import { usersTable } from "./users";

/**
 * Contractor sign-in on arrival (api-server src/routes/contractor-sign-in.ts).
 * Each site has one sign-in link, printed as a QR poster for reception and
 * emailed to contractors before a visit. The contractor reads the site's fire
 * procedure and asbestos register, ticks each, signs, and signs out when they
 * leave. Both tables are also created by the runtime migrations.
 */

/**
 * A site's sign-in link and the fire procedure contractors read. link_token is
 * kept as written (not hashed) because it is printed on a poster at the site
 * and managers must be able to print it again; it is no more secret than the
 * poster. Resetting the link replaces it.
 */
export const contractorSignInSitesTable = pgTable("contractor_sign_in_sites", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  linkToken: text("link_token").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  fireProcedure: text("fire_procedure"),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_contractor_sign_in_sites_site").on(table.siteId),
  uniqueIndex("uq_contractor_sign_in_sites_link_token").on(table.linkToken),
]);

/**
 * One contractor visit. What the contractor was shown is copied onto the row
 * (fire_procedure_text, asbestos_snapshot) so the record still says what they
 * acknowledged after the site's information changes. asbestos_status is
 * "register" (a register was shown), "none_expected" (building from 2000 on)
 * or "missing"; a missing fire procedure leaves fire_procedure_text empty.
 */
export const contractorSignInStatusEnum = ["register", "none_expected", "missing"] as const;
export const contractorSignInsTable = pgTable("contractor_sign_ins", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  siteName: text("site_name").notNull(),
  contractorId: integer("contractor_id").references(() => contractorsTable.id, { onDelete: "set null" }),
  visitorName: text("visitor_name").notNull(),
  company: text("company").notNull(),
  phone: text("phone"),
  email: text("email"),
  visitReason: text("visit_reason"),
  fireProcedureText: text("fire_procedure_text"),
  asbestosStatus: text("asbestos_status").notNull(),
  asbestosSnapshot: jsonb("asbestos_snapshot").notNull().default({}),
  signature: text("signature").notNull(),
  signedInAt: timestamp("signed_in_at", { withTimezone: true }).notNull().defaultNow(),
  signedOutAt: timestamp("signed_out_at", { withTimezone: true }),
  signedOutBy: integer("signed_out_by").references(() => usersTable.id, { onDelete: "set null" }),
  signOutTokenHash: text("sign_out_token_hash").notNull(),
}, (table) => [
  index("idx_contractor_sign_ins_site_time").on(table.clientId, table.siteId, table.signedInAt),
  uniqueIndex("uq_contractor_sign_ins_sign_out_token").on(table.signOutTokenHash),
  check("ck_contractor_sign_ins_asbestos_status", sql`${table.asbestosStatus} IN ('register', 'none_expected', 'missing')`),
]);

export type ContractorSignIn = typeof contractorSignInsTable.$inferSelect;
