import { pgTable, serial, text, timestamp, integer, date, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
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
  staffRosterId: integer("staff_roster_id"),
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

export const dailyChecklistSubmissionsTable = pgTable("daily_checklist_submissions", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id")
    .notNull()
    .references(() => sitesTable.id, { onDelete: "cascade" }),
  checklistDate: text("checklist_date").notNull(), // YYYY-MM-DD
  type: text("type").$type<"am" | "pm">().notNull(), // 'am' | 'pm'
  answers: jsonb("answers")
    .$type<Array<{ question: string; checked: boolean; notes?: string }>>()
    .notNull()
    .default([]),
  submittedById: integer("submitted_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  submittedByName: text("submitted_by_name"),
  submittedAt: timestamp("submitted_at"),
  // PM-only: manager sign-off
  signedOffById: integer("signed_off_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  signedOffByName: text("signed_off_by_name"),
  signedOffAt: timestamp("signed_off_at"),
  signOffNotes: text("sign_off_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_daily_checklist_submissions_client_site_date_type").on(
    table.clientId,
    table.siteId,
    table.checklistDate,
    table.type,
  ),
]);

export type DailyChecklistSubmission = typeof dailyChecklistSubmissionsTable.$inferSelect;
