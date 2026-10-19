import { pgTable, serial, integer, text, boolean, timestamp, date, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const pestVisitsTable = pgTable("pest_visits", {
  id:                 serial("id").primaryKey(),
  clientId:           integer("client_id").notNull(),
  siteId:             integer("site_id"),
  visitDate:          date("visit_date").notNull(),
  contractorName:     text("contractor_name"),
  contractorCompany:  text("contractor_company"),
  areasInspected:     text("areas_inspected"),
  findings:           text("findings"),
  treatmentsApplied:  text("treatments_applied"),
  recommendations:    text("recommendations"),
  nextVisitDate:      date("next_visit_date"),
  signedOffBy:        text("signed_off_by"),
  signedOffByRosterId: integer("signed_off_by_roster_id"),
  notes:              text("notes"),
  createdBy:          integer("created_by"),
  // Mobile outbox entry ID and payload fingerprint: a replay of an applied
  // submission is recognised instead of creating a duplicate. Not a credential.
  clientEntryId:      text("client_entry_id"),
  clientEntryHash:    text("client_entry_hash"),
  createdAt:          timestamp("created_at").notNull().defaultNow(),
  updatedAt:          timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_pest_visits_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
]);

export const pestActivityTable = pgTable("pest_activity", {
  id:           serial("id").primaryKey(),
  clientId:     integer("client_id").notNull(),
  siteId:       integer("site_id"),
  recordedDate: date("recorded_date").notNull(),
  pestType:     text("pest_type").notNull().default("rodent"),
  evidenceType: text("evidence_type").notNull().default("live_sighting"),
  location:     text("location"),
  severity:     text("severity").notNull().default("low"),
  actionTaken:  text("action_taken"),
  recordedBy:   text("recorded_by"),
  recordedByRosterId: integer("recorded_by_roster_id"),
  resolved:     boolean("resolved").notNull().default(false),
  resolvedAt:   timestamp("resolved_at"),
  notes:        text("notes"),
  createdBy:    integer("created_by"),
  // Mobile outbox entry ID and payload fingerprint (see pest_visits).
  clientEntryId:   text("client_entry_id"),
  clientEntryHash: text("client_entry_hash"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_pest_activity_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
]);
