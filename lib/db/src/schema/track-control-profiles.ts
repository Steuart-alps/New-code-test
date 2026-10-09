import { integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";

// Site-specific control profile snapshots for tracks whose inspection cadence
// and supporting records are determined by the local risk assessment.
export const trackControlProfilesTable = pgTable("track_control_profiles", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").notNull().references(() => sitesTable.id, { onDelete: "cascade" }),
  module: text("module").notNull(),
  profile: jsonb("profile").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  clientSiteModuleUnique: uniqueIndex("UQ_track_control_profiles_client_site_module")
    .on(table.clientId, table.siteId, table.module),
}));

export type TrackControlProfile = typeof trackControlProfilesTable.$inferSelect;