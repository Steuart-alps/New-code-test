import { pgTable, serial, integer, text, timestamp, date, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { staffMembersTable } from "./staff-members";

export const premisesInspectionsTable = pgTable("premises_inspections", {
  id:              serial("id").primaryKey(),
  clientId:        integer("client_id").notNull(),
  siteId:          integer("site_id"),
  inspectionDate:  date("inspection_date").notNull(),
  nextInspectionDate: date("next_inspection_date"),
  inspectionType:  text("inspection_type").notNull().default("routine"),
  area:            text("area"),
  findings:        text("findings"),
  hazardDetails:   text("hazard_details"),
  actionRequired:  text("action_required"),
  actionTaken:     text("action_taken"),
  status:          text("status").notNull().default("open"),
  inspectedBy:     text("inspected_by"),
  staffRosterId:   integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  createdBy:       integer("created_by"),
  // Mobile outbox entry ID and payload fingerprint: a replay of an applied
  // submission is recognised instead of creating a duplicate. Not a credential.
  clientEntryId:   text("client_entry_id"),
  clientEntryHash: text("client_entry_hash"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_premises_inspections_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
]);
