import { pgTable, serial, text, timestamp, integer, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { staffMembersTable } from "./staff-members";

/**
 * A site's manual call points (break-glass units). Managers list them once and
 * each weekly alarm test names the one it used, so rotation shows over time.
 * Call points are archived, never deleted, so old tests keep their link.
 */
export const fireCallPointsTable = pgTable("fire_call_points", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Where it is, e.g. "Kitchen fire exit, ground floor".
  location: text("location"),
  // Position in the site's test rotation (1 = first). Weekly alarm tests
  // suggest the next call point after the one tested last.
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: timestamp("archived_at"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("IDX_fire_call_points_client_site").on(table.clientId, table.siteId),
]);

export type FireCallPoint = typeof fireCallPointsTable.$inferSelect;

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
  // Weekly alarm tests: the call point used. The name is copied onto the test
  // so a later rename or archive never changes what the record says.
  callPointId: integer("call_point_id").references(() => fireCallPointsTable.id, { onDelete: "set null" }),
  callPoint: text("call_point"),
  // Fire drills: "included", "not_included" or "no_night_staff".
  nightStaff: text("night_staff"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Submitter's department when the row was created, set by a database
  // trigger and never changed (submitterDepartmentMigration.ts).
  submitterDepartmentId: integer("submitter_department_id"),
  submitterDepartmentSource: text("submitter_department_source").notNull().default("recorded"),
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
