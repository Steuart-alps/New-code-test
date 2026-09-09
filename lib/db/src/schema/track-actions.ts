import { boolean, date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { departmentsTable } from "./departments";
import { sitesTable } from "./sites";

// Operational action register and its client-maintained required-action catalogue.
export const trackActionTemplatesTable = pgTable("track_action_templates", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  module: text("module"),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  instruction: text("instruction"),
  severity: text("severity").notNull().default("action_required"),
  ownerDefault: text("owner_default"),
  leadTimeDays: integer("lead_time_days").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const trackActionsTable = pgTable("track_actions", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  module: text("module").notNull(),
  sourceKind: text("source_kind"),
  sourceRecordId: integer("source_record_id"),
  templateId: integer("template_id").references(() => trackActionTemplatesTable.id, { onDelete: "set null" }),
  provenance: text("provenance").notNull().default("one_off"),
  title: text("title").notNull(),
  instruction: text("instruction"),
  severity: text("severity").notNull(),
  ownerName: text("owner_name"),
  leadTimeDays: integer("lead_time_days"),
  dueDate: date("due_date"),
  remedialAction: text("remedial_action"),
  evidenceReference: text("evidence_reference"),
  resolutionNotes: text("resolution_notes"),
  status: text("status").notNull(),
  createdBy: integer("created_by"),
  resolvedBy: integer("resolved_by"),
  resolvedByName: text("resolved_by_name"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});