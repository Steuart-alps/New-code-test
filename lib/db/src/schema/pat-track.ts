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

// Certificate-level PAT register. The legacy appliance/test register above is
// intentionally retained; these tables support room-template based testing.
export const patEquipmentTemplatesTable = pgTable("pat_equipment_templates", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const patEquipmentTemplateItemsTable = pgTable("pat_equipment_template_items", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  templateId: integer("template_id").notNull().references(() => patEquipmentTemplatesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  applianceType: text("appliance_type").notNull().default("Other"),
  quantity: integer("quantity").notNull().default(1),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const patRoomsTable = pgTable("pat_rooms", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  areaType: text("area_type").notNull().default("room"),
  templateId: integer("template_id").references(() => patEquipmentTemplatesTable.id, { onDelete: "set null" }),
  testIntervalMonths: integer("test_interval_months").notNull().default(12),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const patFailuresTable = pgTable("pat_failures", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  certificateId: integer("certificate_id").notNull(),
  roomId: integer("room_id"),
  // Snapshots retain the audit location even when an area has no register room,
  // or is later renamed.
  locationText: text("location_text"),
  roomNameSnapshot: text("room_name_snapshot"),
  applianceName: text("appliance_name").notNull(),
  actionTaken: text("action_taken"),
  resolution: text("resolution"),
  resolvedDate: date("resolved_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PatAppliance = typeof patAppliancesTable.$inferSelect;
export type NewPatAppliance = typeof patAppliancesTable.$inferInsert;
export type PatTest = typeof patTestsTable.$inferSelect;
export type NewPatTest = typeof patTestsTable.$inferInsert;
