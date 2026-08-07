import { pgTable, serial, integer, text, boolean, timestamp, date } from "drizzle-orm/pg-core";

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
  notes:              text("notes"),
  createdBy:          integer("created_by"),
  createdAt:          timestamp("created_at").notNull().defaultNow(),
  updatedAt:          timestamp("updated_at").notNull().defaultNow(),
});

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
  resolved:     boolean("resolved").notNull().default(false),
  resolvedAt:   timestamp("resolved_at"),
  notes:        text("notes"),
  createdBy:    integer("created_by"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
});
