import { pgTable, serial, text, timestamp, integer, date } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const safeRiskAssessmentsTable = pgTable("safe_risk_assessments", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  assessedBy: text("assessed_by"),
  reviewDate: date("review_date"),
  status: text("status").notNull().default("draft"),
  version: text("version").notNull().default("1.0"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const safeSopsTable = pgTable("safe_sops", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  scope: text("scope"),
  content: text("content"),
  version: text("version").notNull().default("1.0"),
  publishedAt: timestamp("published_at"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const safeTrainingRecordsTable = pgTable("safe_training_records", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  staffName: text("staff_name").notNull(),
  trainingType: text("training_type").notNull(),
  completedAt: date("completed_at").notNull(),
  expiryDate: date("expiry_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const safeInductionsTable = pgTable("safe_inductions", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  staffName: text("staff_name").notNull(),
  startDate: date("start_date").notNull(),
  completedAt: date("completed_at"),
  checklist: text("checklist"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const safeCompetencySignoffsTable = pgTable("safe_competency_signoffs", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  staffName: text("staff_name").notNull(),
  taskName: text("task_name").notNull(),
  signedOffBy: text("signed_off_by").notNull(),
  signedOffAt: date("signed_off_at").notNull(),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SafeRiskAssessment = typeof safeRiskAssessmentsTable.$inferSelect;
export type SafeSop = typeof safeSopsTable.$inferSelect;
export type SafeTrainingRecord = typeof safeTrainingRecordsTable.$inferSelect;
export type SafeInduction = typeof safeInductionsTable.$inferSelect;
export type SafeCompetencySignoff = typeof safeCompetencySignoffsTable.$inferSelect;
