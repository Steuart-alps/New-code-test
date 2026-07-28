import { pgTable, serial, text, timestamp, integer, date } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

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
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FireSafetyCheck = typeof fireSafetyChecksTable.$inferSelect;
