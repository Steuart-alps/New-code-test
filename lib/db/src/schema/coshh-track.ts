import { pgTable, serial, integer, text, date, timestamp, boolean, bigint, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { coshhSubstancesTable } from "./registers";
import { staffMembersTable } from "./staff-members";
import { trainTrackRecordsTable } from "./train-track";

// COSHHTrack: COSHH assessments per substance or task, and the dated checks
// that follow from them (LEV thorough examinations, health surveillance,
// exposure monitoring and staff briefings). The substance list itself is the
// COSHH register (coshh_substances). Rows are soft-deleted via
// deleted_at so a removed record and its file stay available for audit and
// data export.

export const COSHH_EXPOSURE_ROUTES = ["inhalation", "skin", "eyes", "ingestion", "injection"] as const;
export const COSHH_PPE = [
  "gloves", "eye_protection", "face_shield", "respirator", "apron_overalls", "footwear",
] as const;
export const COSHH_RISK_LEVELS = ["low", "medium", "high"] as const;
export const COSHH_SIGNAL_WORDS = ["danger", "warning", "none"] as const;
export const COSHH_ASSESSMENT_STATUSES = ["current", "archived"] as const;
export const COSHH_CHECK_TYPES = [
  "lev_examination",
  "health_surveillance",
  "exposure_monitoring",
  "staff_briefing",
] as const;

export type CoshhCheckType = (typeof COSHH_CHECK_TYPES)[number];

export const coshhAssessmentsTable = pgTable("coshh_assessments", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  substanceId: integer("substance_id").references(() => coshhSubstancesTable.id, { onDelete: "set null" }),
  task: text("task").notNull(),                       // the work or activity assessed
  whoAtRisk: text("who_at_risk"),
  exposureRoutes: jsonb("exposure_routes").$type<string[]>().notNull().default([]),
  howOften: text("how_often"),                        // frequency and duration of use
  // From the safety data sheet: H-statements, signal word, health effects
  // and workplace exposure limits.
  hazardStatements: text("hazard_statements"),
  signalWord: text("signal_word"),                    // danger | warning | none
  healthEffects: text("health_effects"),
  exposureLimits: text("exposure_limits"),
  controls: text("controls"),
  ppe: jsonb("ppe").$type<string[]>().notNull().default([]),
  ppeDetails: text("ppe_details"),
  riskLevel: text("risk_level").notNull().default("medium"),
  healthSurveillanceRequired: boolean("health_surveillance_required").notNull().default(false),
  monitoringRequired: boolean("monitoring_required").notNull().default(false),
  levRequired: boolean("lev_required").notNull().default(false),
  storage: text("storage"),
  spillProcedure: text("spill_procedure"),
  firstAid: text("first_aid"),
  disposal: text("disposal"),
  assessor: text("assessor"),
  assessmentDate: date("assessment_date").notNull(),
  reviewDue: date("review_due"),
  status: text("status").notNull().default("current"),
  documentObjectPath: text("document_object_path"),
  documentFileName: text("document_file_name"),
  documentFileSize: bigint("document_file_size", { mode: "number" }),
  documentMimeType: text("document_mime_type"),
  notes: text("notes"),
  // Where the first draft came from: null when written by hand, "ai" when
  // pre-filled from the substance's safety data sheet. An AI draft is saved
  // only by a person who ticks that they checked it against the sheet;
  // checked_* record who and when.
  draftSource: text("draft_source"),
  draftedAt: timestamp("drafted_at"),
  checkedBy: integer("checked_by").references(() => usersTable.id, { onDelete: "set null" }),
  checkedByName: text("checked_by_name"),
  checkedAt: timestamp("checked_at"),
  // Bumped when a saved change alters what staff were asked to read, so
  // everyone signs the revised assessment again (coshh_acknowledgements).
  revision: integer("revision").notNull().default(1),
  // Staff who must read and sign it: everyone on the staff list at the site,
  // or only these departments (department names, as on staff_roster).
  signOffDepartments: jsonb("sign_off_departments").$type<string[]>().notNull().default([]),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export const coshhChecksTable = pgTable("coshh_checks", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  assessmentId: integer("assessment_id").references(() => coshhAssessmentsTable.id, { onDelete: "set null" }),
  checkType: text("check_type").notNull(),
  checkDate: date("check_date").notNull(),
  // The extraction system, the person checked or briefed, or the area/task monitored.
  subject: text("subject"),
  carriedOutBy: text("carried_out_by"),
  result: text("result").notNull().default("pass"),   // pass | fail
  actionRequired: text("action_required"),
  nextDueDate: date("next_due_date"),
  reportObjectPath: text("report_object_path"),
  reportFileName: text("report_file_name"),
  reportFileSize: bigint("report_file_size", { mode: "number" }),
  reportMimeType: text("report_mime_type"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Submitter's department when the row was created, set by a database
  // trigger and never changed (submitterDepartmentMigration.ts).
  submitterDepartmentId: integer("submitter_department_id"),
  submitterDepartmentSource: text("submitter_department_source").notNull().default("recorded"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

// One person's signature that they have read one revision of an assessment.
// Each sign-off also writes a TrainTrack "signoff" record, which is what the
// staff member's training history shows.
export const coshhAcknowledgementsTable = pgTable("coshh_acknowledgements", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  assessmentId: integer("assessment_id").notNull().references(() => coshhAssessmentsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  staffRosterId: integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  staffName: text("staff_name").notNull(),
  signature: text("signature"),
  acknowledgedBy: integer("acknowledged_by").references(() => usersTable.id, { onDelete: "set null" }),
  trainTrackRecordId: integer("train_track_record_id").references(() => trainTrackRecordsTable.id, { onDelete: "set null" }),
  acknowledgedAt: timestamp("acknowledged_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("coshh_acknowledgements_person_revision_idx").on(table.assessmentId, table.revision, table.staffRosterId),
]);

export type CoshhAssessment = typeof coshhAssessmentsTable.$inferSelect;
export type CoshhCheck = typeof coshhChecksTable.$inferSelect;
export type CoshhAcknowledgement = typeof coshhAcknowledgementsTable.$inferSelect;
