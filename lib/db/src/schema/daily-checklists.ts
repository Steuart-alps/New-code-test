import { pgTable, serial, text, timestamp, integer, date, jsonb } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const dailyChecklistsTable = pgTable("daily_checklists", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  checklistType: text("checklist_type").notNull(),
  checkDate: date("check_date").notNull(),
  items: jsonb("items").notNull().default("[]"),
  completedBy: text("completed_by"),
  managerNote: text("manager_note"),
  submittedAt: timestamp("submitted_at"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const dailyManagerSignoffsTable = pgTable("daily_manager_signoffs", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  signoffDate: date("signoff_date").notNull(),
  managerName: text("manager_name").notNull(),
  notes: text("notes"),
  submittedAt: timestamp("submitted_at"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type DailyChecklist = typeof dailyChecklistsTable.$inferSelect;
export type DailyManagerSignoff = typeof dailyManagerSignoffsTable.$inferSelect;
