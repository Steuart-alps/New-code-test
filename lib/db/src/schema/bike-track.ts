import { pgTable, serial, integer, text, date, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { staffMembersTable } from "./staff-members";

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
  // Last successfully delivered overdue alert. Repeat alerts are eligible after
  // the server-side cadence; the claim fields prevent concurrent workers sending
  // the same alert.
  overdueNotifiedAt: timestamp("overdue_notified_at"),
  overdueNotificationClaimToken: text("overdue_notification_claim_token"),
  overdueNotificationClaimedAt: timestamp("overdue_notification_claimed_at"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Durable outbox for overdue-hire email digests. The rendered message and its
 * provider idempotency key are persisted before dispatch, so a retry after an
 * uncertain provider outcome (e.g. a response timeout) replays the identical
 * request and the provider can deduplicate it. One open row per client.
 */
export const bikeOverdueNotificationLogTable = pgTable("bike_overdue_notification_log", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"), // pending | sending | sent | cancelled | expired
  idempotencyKey: text("idempotency_key").notNull(),
  claimToken: text("claim_token").notNull(),
  hireIds: jsonb("hire_ids").notNull().default([]).$type<number[]>(),
  recipientEmails: jsonb("recipient_emails").notNull().default([]).$type<string[]>(),
  recipientUserIds: jsonb("recipient_user_ids").notNull().default([]).$type<number[]>(),
  subject: text("subject").notNull(),
  html: text("html").notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  sentAt: timestamp("sent_at"),
}, (table) => [
  uniqueIndex("UQ_bike_overdue_notification_log_key").on(table.idempotencyKey),
  uniqueIndex("UQ_bike_overdue_notification_log_open")
    .on(table.clientId)
    .where(sql`${table.status} IN ('pending', 'sending')`),
]);

export const bikeChecksTable = pgTable("bike_checks", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  hireRecordId: integer("hire_record_id").references(() => bikeHireRecordsTable.id, { onDelete: "set null" }),
  bikeId: integer("bike_id").notNull().references(() => bikesTable.id, { onDelete: "restrict" }),
  checkType: text("check_type").notNull(), // pre_hire | post_return | routine
  checkDate: date("check_date").notNull(),
  performedBy: text("performed_by"),
  staffRosterId: integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  overallResult: text("overall_result").notNull().default("pass"), // new writes: pass | fail; legacy action_required remains readable
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
