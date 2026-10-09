import { boolean, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";

export const trackEvidenceRequirementsTable = pgTable("track_evidence_requirements", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  module: text("module").notNull(),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  requirementKey: text("requirement_key").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  evidenceType: text("evidence_type").notNull(),
  minimumCount: integer("minimum_count").notNull().default(1),
  reviewRequired: boolean("review_required").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, table => ({
  clientModuleKeyScope: unique("UQ_track_evidence_requirements_scope").on(
    table.clientId, table.module, table.siteId, table.requirementKey,
  ),
}));