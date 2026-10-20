import { pgTable, serial, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

/**
 * Plant and equipment that no track keeps a record of: cold water tanks,
 * calorifiers, boilers, lifts and the like. Water checks (legionella_checks)
 * and Compliance Checks (compliance_items) point at an item through their
 * equipment_id, so the item's QR label can say whether it is in date.
 * Items are archived (active = false), never deleted, so history keeps them.
 */
export const EQUIPMENT_TYPES = [
  "cold_water_tank",
  "calorifier",
  "boiler",
  "water_heater",
  "lift",
  "hoist",
  "lifting_equipment",
  "pressure_system",
  "gas_appliance",
  "air_conditioning",
  "fire_extinguisher",
  "ladder",
  "other",
] as const;

export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const equipmentItemsTable = pgTable("equipment_items", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  type: text("type").$type<EquipmentType>().notNull().default("other"),
  location: text("location"),
  make: text("make"),
  model: text("model"),
  serialNo: text("serial_no"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("IDX_equipment_items_client_site").on(table.clientId, table.siteId),
]);

export type EquipmentItem = typeof equipmentItemsTable.$inferSelect;

/**
 * The kinds of record a QR label can point at. `target_ref` is the record's id,
 * except for kitchen cold units, which live in the KitchenTrack settings and
 * use "<siteId or 0>:<unit id>".
 */
export const EQUIPMENT_LABEL_KINDS = [
  "green_machine",
  "pat_appliance",
  "hot_tub",
  "fire_call_point",
  "water_outlet",
  "bike",
  "room",
  "cold_unit",
  "equipment",
] as const;

export type EquipmentLabelKind = (typeof EQUIPMENT_LABEL_KINDS)[number];

/**
 * One printed QR label. The code is random, so it says nothing about the item;
 * a replaced label keeps its row (replaced_at set) and stops resolving.
 */
export const equipmentLabelsTable = pgTable("equipment_labels", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  kind: text("kind").$type<EquipmentLabelKind>().notNull(),
  targetRef: text("target_ref").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  replacedAt: timestamp("replaced_at"),
}, (table) => [
  uniqueIndex("UQ_equipment_labels_code").on(table.code),
  uniqueIndex("UQ_equipment_labels_active_target")
    .on(table.clientId, table.kind, table.targetRef)
    .where(sql`${table.replacedAt} IS NULL`),
]);

export type EquipmentLabel = typeof equipmentLabelsTable.$inferSelect;
