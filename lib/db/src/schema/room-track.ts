import { boolean, date, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const roomTrackRoomsTable = pgTable("room_track_rooms", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  siteId: integer("site_id"),
  roomNumber: text("room_number").notNull(),
  name: text("name"),
  floor: text("floor"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdBy: integer("created_by"),
  updatedBy: integer("updated_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const roomTrackChecksTable = pgTable("room_track_checks", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  roomId: integer("room_id").notNull(),
  siteId: integer("site_id"),
  checkDate: date("check_date").notNull(),
  // Legacy single-state field retained for existing records; new writes use
  // the independent criteria below.
  status: text("status"),
  clean: boolean("clean").notNull().default(false),
  tidy: boolean("tidy").notNull().default(false),
  toStandard: boolean("to_standard").notNull().default(false),
  notes: text("notes"),
  checkedBy: text("checked_by"),
  checkedByRosterId: integer("checked_by_roster_id"),
  createdBy: integer("created_by"),
  updatedBy: integer("updated_by"),
  // Mobile outbox entry ID and payload fingerprint: a replay of an applied
  // submission is recognised instead of creating a duplicate. Not a credential.
  clientEntryId: text("client_entry_id"),
  clientEntryHash: text("client_entry_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  oneCheckPerRoomDay: uniqueIndex("UQ_room_track_checks_room_date").on(table.roomId, table.checkDate),
  clientEntry: uniqueIndex("UQ_room_track_checks_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
}));