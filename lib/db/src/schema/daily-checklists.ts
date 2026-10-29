import { pgTable, serial, text, timestamp, integer, date, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { departmentsTable } from "./departments";

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
  // Submitter's department when the row was created, set by a database
  // trigger and never changed (submitterDepartmentMigration.ts).
  submitterDepartmentId: integer("submitter_department_id"),
  submitterDepartmentSource: text("submitter_department_source").notNull().default("recorded"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Not unique: legacy duplicates may exist; writes dedupe in a transaction.
  index("IDX_daily_checklists_client_date_site_type").on(
    table.clientId,
    table.checkDate,
    table.siteId,
    table.checklistType,
  ),
]);

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
  // Submitter's department when the row was created, set by a database
  // trigger and never changed (submitterDepartmentMigration.ts).
  submitterDepartmentId: integer("submitter_department_id"),
  submitterDepartmentSource: text("submitter_department_source").notNull().default("recorded"),
  submittedByName: text("submitted_by_name"),
  submittedAt: timestamp("submitted_at"),
  // PM-only: manager sign-off
  signedOffById: integer("signed_off_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  signedOffByName: text("signed_off_by_name"),
  signedOffAt: timestamp("signed_off_at"),
  signOffNotes: text("sign_off_notes"),
  // Device entry ID sent by the mobile outbox; lets a replayed submission be
  // recognised as already applied. Not a credential.
  clientEntryId: text("client_entry_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_daily_checklist_submissions_client_site_date_type").on(
    table.clientId,
    table.siteId,
    table.checklistDate,
    table.type,
  ),
  uniqueIndex("UQ_daily_checklist_submissions_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
]);

export type DailyChecklistSubmission = typeof dailyChecklistSubmissionsTable.$inferSelect;

/**
 * Which department does a site's kitchen or premises checklists (opening and
 * closing), e.g. Kitchen and Clubhouse at a golf club. A checklist given to a
 * team is shown under that team and chased on its own
 * (api-server lib/dailyChecklistTeams.ts). Also created by the runtime
 * migrations.
 */
export const dailyChecklistTeamsTable = pgTable("daily_checklist_teams", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  area: text("area").$type<"kitchen" | "premises">().notNull(),
  departmentId: integer("department_id").notNull().references(() => departmentsTable.id, { onDelete: "cascade" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_daily_checklist_teams_site_area").on(table.siteId, table.area),
  check("ck_daily_checklist_teams_area", sql`${table.area} IN ('kitchen', 'premises')`),
]);

export type DailyChecklistTeam = typeof dailyChecklistTeamsTable.$inferSelect;
