import { pgTable, serial, integer, text, date, timestamp, boolean } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const INCIDENT_TYPES = [
  "accident",
  "near_miss",
  "dangerous_occurrence",
  "occupational_disease",
] as const;

export const INCIDENT_SEVERITIES = ["minor", "moderate", "serious", "fatal"] as const;
export const INCIDENT_STATUSES = ["open", "under_investigation", "closed"] as const;
export const EMPLOYMENT_TYPES = ["employee", "contractor", "visitor", "member_of_public"] as const;

export const incidentsTable = pgTable("incidents", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  incidentType: text("incident_type").notNull().default("accident"),
  severity: text("severity").notNull().default("minor"),
  status: text("status").notNull().default("open"),
  incidentDate: date("incident_date").notNull(),
  incidentTime: text("incident_time"),
  location: text("location").notNull(),
  description: text("description").notNull(),
  involvedName: text("involved_name").notNull(),
  involvedJobTitle: text("involved_job_title"),
  involvedEmploymentType: text("involved_employment_type").default("employee"),
  injuriesSustained: text("injuries_sustained"),
  firstAidGiven: boolean("first_aid_given").notNull().default(false),
  firstAiderName: text("first_aider_name"),
  witnesses: text("witnesses"),
  riddorReportable: boolean("riddor_reportable").notNull().default(false),
  reportedToHse: boolean("reported_to_hse").notNull().default(false),
  hseReference: text("hse_reference"),
  hseReportDate: date("hse_report_date"),
  immediateActions: text("immediate_actions"),
  correctiveActions: text("corrective_actions"),
  reportedBy: text("reported_by").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Incident = typeof incidentsTable.$inferSelect;
export type NewIncident = typeof incidentsTable.$inferInsert;
