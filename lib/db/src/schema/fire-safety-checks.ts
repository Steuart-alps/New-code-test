import { pgTable, serial, text, timestamp, integer, real, boolean, date, index, uniqueIndex } from "drizzle-orm/pg-core";
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
  // Near bedrooms or other sleeping areas, where the alarm must reach 75 dB at
  // the bedhead rather than 65 dB (BS 5839-1). Pre-selects the alarm test's
  // sound level limit.
  sleepingArea: boolean("sleeping_area").notNull().default(false),
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
  // Fire drills: the time the alarm was raised ("HH:MM", the business's local
  // time) and how long everyone took to get out, in seconds. Staff present
  // are in fire_drill_attendance.
  drillTime: text("drill_time"),
  evacuationSeconds: integer("evacuation_seconds"),
  // Weekly alarm tests, optional: the sound level heard, in dB; how it was
  // taken ("meter", read off a sound meter, or "phone", a rough reading from
  // the phone's microphone); and whether it was taken at a bedhead (75 dB
  // needed) rather than a general area (65 dB). See lib/fireSoundLevel.ts.
  soundLevelDb: real("sound_level_db"),
  soundLevelMethod: text("sound_level_method"),
  soundLevelBedhead: boolean("sound_level_bedhead"),
  // Night fire walks (check type "night_walk"): the walk's time ("22:00",
  // "02:00" or "06:00"; check_date is the calendar day it fell on). The
  // walker's signature is in record_signatures, as for every check.
  walkTime: text("walk_time"),
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

/**
 * Staff ticked as present at a fire drill, from the staff roster. The name is
 * copied so a later rename or removal from the roster never changes the
 * record. A roster member's latest drill shows who has not taken part in one
 * recently (FireTrack and TrainTrack).
 */
export const fireDrillAttendanceTable = pgTable("fire_drill_attendance", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  fireCheckId: integer("fire_check_id")
    .notNull()
    .references(() => fireSafetyChecksTable.id, { onDelete: "cascade" }),
  staffRosterId: integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  staffName: text("staff_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("IDX_fire_drill_attendance_check").on(table.fireCheckId),
  index("IDX_fire_drill_attendance_client_staff").on(table.clientId, table.staffRosterId),
  uniqueIndex("UQ_fire_drill_attendance_check_staff").on(table.fireCheckId, table.staffRosterId),
]);

export type FireDrillAttendance = typeof fireDrillAttendanceTable.$inferSelect;
