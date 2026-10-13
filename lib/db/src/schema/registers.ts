import { pgTable, serial, text, timestamp, integer, date, bigint, boolean, jsonb } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

// Site registers: allergen records (KitchenTrack), COSHH substances and
// asbestos records (core). Rows are soft-deleted via deleted_at so a removed
// entry stays available for audit and data export.

export const allergenItemsTable = pgTable("allergen_items", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  // Keys from the 14 regulated allergens (see api-server routes/registers.ts).
  allergens: jsonb("allergens").$type<string[]>().notNull().default([]),
  ppds: boolean("ppds").notNull().default(false),
  lastReviewedAt: date("last_reviewed_at"),
  reviewedBy: text("reviewed_by"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

// Append-only change log: one row when an item is created, when its allergen
// ticks change (with the recipe/supplier reason) and when it is removed.
export const allergenItemChangesTable = pgTable("allergen_item_changes", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => allergenItemsTable.id, { onDelete: "cascade" }),
  changeType: text("change_type").notNull(),
  allergensBefore: jsonb("allergens_before").$type<string[]>(),
  allergensAfter: jsonb("allergens_after").$type<string[]>(),
  reason: text("reason"),
  changedBy: integer("changed_by").references(() => usersTable.id, { onDelete: "set null" }),
  changedByName: text("changed_by_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const coshhSubstancesTable = pgTable("coshh_substances", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  supplier: text("supplier"),
  // GHS pictogram keys (ghs01..ghs09).
  hazardPictograms: jsonb("hazard_pictograms").$type<string[]>().notNull().default([]),
  whereUsed: text("where_used"),
  sdsObjectPath: text("sds_object_path"),
  sdsFileName: text("sds_file_name"),
  sdsFileSize: bigint("sds_file_size", { mode: "number" }),
  sdsMimeType: text("sds_mime_type"),
  assessmentDate: date("assessment_date"),
  reviewDue: date("review_due"),
  controls: text("controls"),
  status: text("status").notNull().default("in_use"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

// One current asbestos record per site (partial unique index in runtime
// migrations), holding the latest survey and the management plan review.
export const asbestosRecordsTable = pgTable("asbestos_records", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  builtBefore2000: text("built_before_2000").notNull().default("unknown"),
  noAsbestosExpected: boolean("no_asbestos_expected").notNull().default(false),
  surveyType: text("survey_type"),
  surveyDate: date("survey_date"),
  surveyor: text("surveyor"),
  reportObjectPath: text("report_object_path"),
  reportFileName: text("report_file_name"),
  reportFileSize: bigint("report_file_size", { mode: "number" }),
  reportMimeType: text("report_mime_type"),
  planReviewDue: date("plan_review_due"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

// Earlier surveys of an asbestos record: when the survey report is replaced
// or detached, the previous survey and its file are kept here (append-only),
// so the old report stays listed, downloadable and in the data export.
export const asbestosSurveyHistoryTable = pgTable("asbestos_survey_history", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  recordId: integer("record_id").notNull().references(() => asbestosRecordsTable.id, { onDelete: "cascade" }),
  surveyType: text("survey_type"),
  surveyDate: date("survey_date"),
  surveyor: text("surveyor"),
  reportObjectPath: text("report_object_path").notNull(),
  reportFileName: text("report_file_name"),
  reportFileSize: bigint("report_file_size", { mode: "number" }),
  reportMimeType: text("report_mime_type"),
  replacedBy: integer("replaced_by").references(() => usersTable.id, { onDelete: "set null" }),
  replacedAt: timestamp("replaced_at").notNull().defaultNow(),
});

export const asbestosRegisterEntriesTable = pgTable("asbestos_register_entries", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  recordId: integer("record_id").notNull().references(() => asbestosRecordsTable.id, { onDelete: "cascade" }),
  location: text("location").notNull(),
  material: text("material").notNull(),
  condition: text("condition").notNull().default("good"),
  riskScore: integer("risk_score"),
  priority: text("priority").notNull().default("low"),
  action: text("action").notNull().default("manage"),
  lastInspected: date("last_inspected"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});
