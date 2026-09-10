import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const staffKioskCapabilitiesTable = pgTable("staff_kiosk_capabilities", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  staffMemberId: integer("staff_member_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  actionType: text("action_type").notNull().default("start_shift"),
  target: text("target").notNull().default("staff_shift_check_ins"),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const staffShiftCheckInsTable = pgTable("staff_shift_check_ins", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  staffMemberId: integer("staff_member_id").notNull(),
  checkedInAt: timestamp("checked_in_at").notNull().defaultNow(),
});

export const staffKioskActionsTable = pgTable("staff_kiosk_actions", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  staffMemberId: integer("staff_member_id").notNull(),
  actionType: text("action_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});