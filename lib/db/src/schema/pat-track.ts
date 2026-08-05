import { pgTable, serial, integer, text, date, boolean, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const PAT_APPLIANCE_TYPES = [
  "Class I",
  "Class II",
  "Class III",
  "Extension Lead",
  "IT Equipment",
  "Portable Tool",
  "Cleaning Equipment",
  "AV Equipment",
  "Kitchen Appliance",
  "Other",
] as const;

export const PAT_RESULTS = ["pass", "fail"] as const;
export const PAT_ITEM_RESULTS = ["pass", "fail", "na"] as const;

export type PatApplianceType = (typeof PAT_APPLIANCE_TYPES)[number];
export type PatResult = (typeof PAT_RESULTS)[number];
export type PatItemResult = (typeof PAT_ITEM_RESULTS)[number];

export const patAppliancesTable = pgTable("pat_appliances", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  applianceType: text("appliance_type").notNull().default("Other"),
  location: text("location"),
  assetTag: text("asset_tag"),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const patTestsTable = pgTable("pat_tests", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  applianceId: integer("appliance_id").notNull().references(() => patAppliancesTable.id, { onDelete: "cascade" }),
  testDate: date("test_date").notNull(),
  result: text("result").notNull().default("pass"),      // pass | fail
  nextTestDate: date("next_test_date"),
  testedBy: text("tested_by"),
  visualInspection: text("visual_inspection"),           // pass | fail | na
  earthContinuityOhms: text("earth_continuity_ohms"),   // stored as string for flexibility
  insulationMohms: text("insulation_mohms"),
  operatingCurrent: text("operating_current"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PatAppliance = typeof patAppliancesTable.$inferSelect;
export type NewPatAppliance = typeof patAppliancesTable.$inferInsert;
export type PatTest = typeof patTestsTable.$inferSelect;
export type NewPatTest = typeof patTestsTable.$inferInsert;
