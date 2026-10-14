import { pgTable, serial, text, timestamp, integer, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { staffMembersTable } from "./staff-members";

export const fireSafetyChecksTable = pgTable("fire_safety_checks", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  checkType: text("check_type").notNull(),
  checkDate: date("check_date").notNull(),
  result: text("result").notNull().default("pass"),
  location: text("location"),
  notes: text("notes"),
  performedBy: text("performed_by"),
  staffRosterId: integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Mobile outbox entry ID and payload fingerprint: a replay of an applied
  // submission is recognised instead of creating a duplicate. Not a credential.
  clientEntryId: text("client_entry_id"),
  clientEntryHash: text("client_entry_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Created by the api-server runtime migrations (dashboard read paths).
  index("IDX_fire_safety_client_site_type_date").on(table.clientId, table.siteId, table.checkType, table.checkDate),
  uniqueIndex("UQ_fire_safety_checks_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
]);

export type FireSafetyCheck = typeof fireSafetyChecksTable.$inferSelect;
