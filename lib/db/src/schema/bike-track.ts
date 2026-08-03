import { pgTable, serial, integer, text, date, boolean, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const BIKE_TYPES = ["road", "mountain", "hybrid", "ebike", "kids", "cargo", "other"] as const;
export const BIKE_STATUSES = ["available", "hired", "maintenance", "retired"] as const;
export const BIKE_CHECK_ITEMS = ["brakes_front", "brakes_rear", "tyre_front", "tyre_rear", "chain_gears", "lights_front", "lights_rear", "frame", "saddle_seatpost", "handlebars", "pedals", "helmet_provided"] as const;

export type BikeType = (typeof BIKE_TYPES)[number];
export type BikeStatus = (typeof BIKE_STATUSES)[number];
export type BikeCheckItem = (typeof BIKE_CHECK_ITEMS)[number];

export const bikesTable = pgTable("bikes", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  ref: text("ref").notNull(),              // e.g. "BIKE-01" — shown on the bike
  name: text("name"),                      // optional friendly name
  type: text("type").notNull().default("hybrid"),
  status: text("status").notNull().default("available"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const bikeHireRecordsTable = pgTable("bike_hire_records", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  bikeId: integer("bike_id").notNull().references(() => bikesTable.id, { onDelete: "restrict" }),
  guestName: text("guest_name").notNull(),
  guestContact: text("guest_contact"),
  hireDate: date("hire_date").notNull(),
  returnDateExpected: date("return_date_expected"),
  returnDateActual: date("return_date_actual"),
  depositPence: integer("deposit_pence"),
  depositReturned: boolean("deposit_returned").notNull().default(false),
  status: text("status").notNull().default("active"), // active | returned | overdue | cancelled
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const bikeChecksTable = pgTable("bike_checks", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  hireRecordId: integer("hire_record_id").references(() => bikeHireRecordsTable.id, { onDelete: "set null" }),
  bikeId: integer("bike_id").notNull().references(() => bikesTable.id, { onDelete: "restrict" }),
  checkType: text("check_type").notNull(), // pre_hire | post_return | routine
  checkDate: date("check_date").notNull(),
  performedBy: text("performed_by"),
  overallResult: text("overall_result").notNull().default("pass"), // pass | fail | action_required
  // Individual check items: pass | fail | na
  brakesFront: text("brakes_front"),
  brakesRear: text("brakes_rear"),
  tyreFront: text("tyre_front"),
  tyreRear: text("tyre_rear"),
  chainGears: text("chain_gears"),
  lightsFront: text("lights_front"),
  lightsRear: text("lights_rear"),
  frame: text("frame"),
  saddleSeatpost: text("saddle_seatpost"),
  handlebars: text("handlebars"),
  pedals: text("pedals"),
  helmetProvided: text("helmet_provided"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Bike = typeof bikesTable.$inferSelect;
export type NewBike = typeof bikesTable.$inferInsert;
export type BikeHireRecord = typeof bikeHireRecordsTable.$inferSelect;
export type NewBikeHireRecord = typeof bikeHireRecordsTable.$inferInsert;
export type BikeCheck = typeof bikeChecksTable.$inferSelect;
export type NewBikeCheck = typeof bikeChecksTable.$inferInsert;
