import { pgTable, serial, integer, text, date, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
/** RIDDOR 2013 categories. over_3_day_record_only is recorded, not reported. */
export const RIDDOR_CATEGORIES = [
  "death",
  "specified_injury",
  "over_7_day_injury",
  "non_worker_hospital",
  "occupational_disease",
  "dangerous_occurrence",
  "over_3_day_record_only",
] as const;

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
  /** Optional RIDDOR category (RIDDOR_CATEGORIES); sets the reporting deadline. */
  riddorCategory: text("riddor_category"),
  reportedToHse: boolean("reported_to_hse").notNull().default(false),
  hseReference: text("hse_reference"),
  hseReportDate: date("hse_report_date"),
  immediateActions: text("immediate_actions"),
  investigationFindings: text("investigation_findings"),
  correctiveActions: text("corrective_actions"),
  reportedBy: text("reported_by").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Submitter's department when the row was created, set by a database
  // trigger and never changed (submitterDepartmentMigration.ts).
  submitterDepartmentId: integer("submitter_department_id"),
  submitterDepartmentSource: text("submitter_department_source").notNull().default("recorded"),
  // Mobile outbox entry ID and payload fingerprint: a replay of an applied
  // submission is recognised instead of creating a duplicate. Not a credential.
  clientEntryId: text("client_entry_id"),
  clientEntryHash: text("client_entry_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_incidents_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
]);

export type Incident = typeof incidentsTable.$inferSelect;
export type NewIncident = typeof incidentsTable.$inferInsert;

/** Append-only RIDDOR assessment and HSE submission record. */
export const incidentRiddorEventsTable = pgTable("incident_riddor_events", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  // Legal record: an incident cannot be removed while its RIDDOR history exists.
  incidentId: integer("incident_id").notNull().references(() => incidentsTable.id, { onDelete: "restrict" }),
  actorId: integer("actor_id").references(() => usersTable.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(), // decision | submission
  riddorReportable: boolean("riddor_reportable").notNull(),
  riddorCategory: text("riddor_category"),
  reportedToHse: boolean("reported_to_hse").notNull().default(false),
  // Snapshot the accountable person and the actual decision time. A user
  // account can subsequently be renamed or removed, so actorId alone is not a
  // sufficient compliance record.
  decisionMaker: text("decision_maker"),
  decisionAt: timestamp("decision_at").notNull().defaultNow(),
  rationale: text("rationale"),
  hseReference: text("hse_reference"),
  hseReportDate: date("hse_report_date"),
  submittedAt: timestamp("submitted_at"),
  submissionEvidence: text("submission_evidence"),
  // HSE receipt bound to this submission event. Written once with the event
  // (the table is append-only), so the file can't be swapped or detached.
  receiptObjectPath: text("receipt_object_path"),
  receiptFileName: text("receipt_file_name"),
  receiptContentType: text("receipt_content_type"),
  /** upload | incident_attachment (picked from the incident's photos). */
  receiptSource: text("receipt_source"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
