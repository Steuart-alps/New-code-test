import { pgTable, serial, integer, text, date, timestamp, doublePrecision } from "drizzle-orm/pg-core";
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

/** How busy the area under a tree is: the busier, the more a failure matters. */
export const TREE_RISK_ZONES = ["high", "medium", "low"] as const;
export type TreeRiskZone = (typeof TREE_RISK_ZONES)[number];

/** The tree register: each tree (or group) inspected, where it is and how often. */
export const treesTable = pgTable("trees", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  ref: text("ref").notNull(),                 // tag number, name or group ("T12", "Beech group by 9th tee")
  species: text("species"),
  location: text("location"),                 // where on site, in words
  what3words: text("what3words"),             // "filled.count.soap", no leading slashes
  latitude: doublePrecision("latitude"),      // GPS spot from "Use my location"
  longitude: doublePrecision("longitude"),
  riskZone: text("risk_zone").notNull().default("medium"),
  inspectionIntervalMonths: integer("inspection_interval_months").notNull().default(12),
  notes: text("notes"),
  removedAt: date("removed_at"),              // felled or removed; kept for its records
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Tree = typeof treesTable.$inferSelect;

export const treeInspectionsTable = pgTable("tree_inspections", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  treeId: integer("tree_id").references(() => treesTable.id, { onDelete: "set null" }),
  checkType: text("check_type").notNull(),
  checkDate: date("check_date").notNull(),
  result: text("result").notNull().default("pass"), // new writes: pass | fail; legacy aliases remain readable
  actionSeverity: text("action_severity"), // monitor | action_required | urgent_action
  treeRef: text("tree_ref"),          // tree tag number, name or group
  location: text("location"),         // where on site
  what3words: text("what3words"),     // where the issue is, "filled.count.soap"
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  inspector: text("inspector"),       // inspector name / company
  followUpDate: date("follow_up_date"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Submitter's department when the row was created, set by a database
  // trigger and never changed (submitterDepartmentMigration.ts).
  submitterDepartmentId: integer("submitter_department_id"),
  submitterDepartmentSource: text("submitter_department_source").notNull().default("recorded"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TreeInspection = typeof treeInspectionsTable.$inferSelect;
export type NewTreeInspection = typeof treeInspectionsTable.$inferInsert;
