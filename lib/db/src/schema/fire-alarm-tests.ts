import { pgTable, serial, text, integer, boolean, timestamp, date } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const fireAlarmTestResultEnum = ["pass", "fail"] as const;
export type FireAlarmTestResult = (typeof fireAlarmTestResultEnum)[number];

export const fireAlarmTestsTable = pgTable("fire_alarm_tests", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id")
    .notNull()
    .references(() => sitesTable.id, { onDelete: "cascade" }),
  weekOf: date("week_of").notNull(),
  testedBy: text("tested_by").notNull(),
  result: text("result").$type<FireAlarmTestResult>().notNull(),
  alarmActivated: boolean("alarm_activated").notNull().default(true),
  allCallPointsTested: boolean("all_call_points_tested").notNull().default(true),
  faultFound: text("fault_found"),
  actionTaken: text("action_taken"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FireAlarmTest = typeof fireAlarmTestsTable.$inferSelect;
export type InsertFireAlarmTest = typeof fireAlarmTestsTable.$inferInsert;
