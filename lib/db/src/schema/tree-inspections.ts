import { pgTable, serial, integer, text, date, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const TREE_CHECK_TYPES = [
  "visual_assessment",
  "detailed_assessment",
  "post_storm",
  "remedial_works",
  "risk_assessment",
] as const;

export type TreeCheckType = (typeof TREE_CHECK_TYPES)[number];

export const treeInspectionsTable = pgTable("tree_inspections", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  checkType: text("check_type").notNull(),
  checkDate: date("check_date").notNull(),
  result: text("result").notNull().default("pass"), // pass | monitor | action_required | urgent_action
  treeRef: text("tree_ref"),          // tree tag number, name or group
  location: text("location"),         // where on site
  inspector: text("inspector"),       // inspector name / company
  followUpDate: date("follow_up_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TreeInspection = typeof treeInspectionsTable.$inferSelect;
export type NewTreeInspection = typeof treeInspectionsTable.$inferInsert;
