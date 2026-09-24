import { createInsertSchema } from "drizzle-zod";
import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const privacyProgramsTable = pgTable("privacy_programs", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }).unique(),
  customerRole: text("customer_role").notNull().default("controller"),
  controllerName: text("controller_name"),
  controllerContact: text("controller_contact"),
  dpoContact: text("dpo_contact"),
  noticeUrl: text("notice_url"),
  noticeVersion: text("notice_version"),
  noticeReviewedAt: timestamp("notice_reviewed_at", { withTimezone: true }),
  processorAgreementStatus: text("processor_agreement_status").notNull().default("not_assessed"),
  processorAgreementReviewedAt: timestamp("processor_agreement_reviewed_at", { withTimezone: true }),
  responsibilitiesNotes: text("responsibilities_notes"),
  privacyOwner: text("privacy_owner"),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const privacyProcessingActivitiesTable = pgTable("privacy_processing_activities", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  purpose: text("purpose").notNull(),
  dataSubjects: text("data_subjects").notNull(),
  dataCategories: text("data_categories").notNull(),
  article6Basis: text("article_6_basis").notNull(),
  article6Rationale: text("article_6_rationale"),
  specialCategoryData: boolean("special_category_data").notNull().default(false),
  article9Condition: text("article_9_condition"),
  article9Rationale: text("article_9_rationale"),
  recipients: text("recipients"),
  transferDetails: text("transfer_details"),
  retentionCriteria: text("retention_criteria").notNull(),
  securityMeasures: text("security_measures"),
  dpiaClassification: text("dpia_classification").notNull().default("not_screened"),
  dpiaRationale: text("dpia_rationale"),
  dpiaCompletedAt: timestamp("dpia_completed_at", { withTimezone: true }),
  owner: text("owner"),
  reviewDueAt: timestamp("review_due_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const privacyRightsRequestsTable = pgTable("privacy_rights_requests", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  requestType: text("request_type").notNull(),
  subjectName: text("subject_name").notNull(),
  subjectContact: text("subject_contact"),
  scopeDescription: text("scope_description").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  extendedDueAt: timestamp("extended_due_at", { withTimezone: true }),
  extensionReason: text("extension_reason"),
  identityStatus: text("identity_status").notNull().default("not_started"),
  identityMethod: text("identity_method"),
  identityEvidence: text("identity_evidence"),
  identityVerifiedAt: timestamp("identity_verified_at", { withTimezone: true }),
  identityVerifiedBy: integer("identity_verified_by").references(() => usersTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("received"),
  decision: text("decision"),
  decisionRationale: text("decision_rationale"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: integer("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
  responseSentAt: timestamp("response_sent_at", { withTimezone: true }),
  responseEvidence: text("response_evidence"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const privacyRetentionSchedulesTable = pgTable("privacy_retention_schedules", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  recordCategory: text("record_category").notNull(),
  scopeDescription: text("scope_description").notNull(),
  retentionPeriod: text("retention_period").notNull(),
  retentionTrigger: text("retention_trigger").notNull(),
  justification: text("justification").notNull(),
  legalHoldActive: boolean("legal_hold_active").notNull().default(false),
  legalHoldReason: text("legal_hold_reason"),
  deletionException: boolean("deletion_exception").notNull().default(false),
  deletionExceptionReason: text("deletion_exception_reason"),
  reviewDueAt: timestamp("review_due_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const privacyRetentionVerificationsTable = pgTable("privacy_retention_verifications", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  scheduleId: integer("schedule_id").notNull().references(() => privacyRetentionSchedulesTable.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  recordsReviewed: text("records_reviewed").notNull(),
  verificationMethod: text("verification_method").notNull(),
  evidence: text("evidence").notNull(),
  verifiedBy: integer("verified_by").references(() => usersTable.id, { onDelete: "set null" }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
});

export const privacyProcessorsTable = pgTable("privacy_processors", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  organizationName: text("organization_name").notNull(),
  role: text("role").notNull().default("processor"),
  parentProcessor: text("parent_processor"),
  serviceDescription: text("service_description").notNull(),
  dataCategories: text("data_categories").notNull(),
  processingCountries: text("processing_countries").notNull(),
  transferMechanism: text("transfer_mechanism").notNull().default("not_assessed"),
  transferSafeguards: text("transfer_safeguards"),
  transferAssessment: text("transfer_assessment"),
  agreementStatus: text("agreement_status").notNull().default("not_assessed"),
  agreementReviewedAt: timestamp("agreement_reviewed_at", { withTimezone: true }),
  transferReviewedAt: timestamp("transfer_reviewed_at", { withTimezone: true }),
  reviewDueAt: timestamp("review_due_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const privacyBreachesTable = pgTable("privacy_breaches", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  occurredFrom: timestamp("occurred_from", { withTimezone: true }),
  occurredTo: timestamp("occurred_to", { withTimezone: true }),
  description: text("description").notNull(),
  dataCategories: text("data_categories").notNull(),
  affectedSubjectsEstimate: integer("affected_subjects_estimate"),
  affectedRecordsEstimate: integer("affected_records_estimate"),
  riskLevel: text("risk_level").notNull().default("under_assessment"),
  assessmentStatus: text("assessment_status").notNull().default("assessing"),
  assessmentRationale: text("assessment_rationale"),
  containmentSteps: text("containment_steps"),
  authorityNotificationRequired: boolean("authority_notification_required"),
  authorityNotificationDueAt: timestamp("authority_notification_due_at", { withTimezone: true }).notNull(),
  authorityNotifiedAt: timestamp("authority_notified_at", { withTimezone: true }),
  authorityNotificationReference: text("authority_notification_reference"),
  individualNotificationRequired: boolean("individual_notification_required"),
  individualNotificationDueAt: timestamp("individual_notification_due_at", { withTimezone: true }),
  individualsNotifiedAt: timestamp("individuals_notified_at", { withTimezone: true }),
  evidence: text("evidence"),
  assessedAt: timestamp("assessed_at", { withTimezone: true }),
  assessedBy: integer("assessed_by").references(() => usersTable.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPrivacyProgramSchema = createInsertSchema(privacyProgramsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPrivacyProcessingActivitySchema = createInsertSchema(privacyProcessingActivitiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPrivacyRightsRequestSchema = createInsertSchema(privacyRightsRequestsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPrivacyRetentionScheduleSchema = createInsertSchema(privacyRetentionSchedulesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPrivacyRetentionVerificationSchema = createInsertSchema(privacyRetentionVerificationsTable).omit({ id: true, verifiedAt: true });
export const insertPrivacyProcessorSchema = createInsertSchema(privacyProcessorsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPrivacyBreachSchema = createInsertSchema(privacyBreachesTable).omit({ id: true, createdAt: true, updatedAt: true });

export type PrivacyProgram = typeof privacyProgramsTable.$inferSelect;
export type PrivacyProcessingActivity = typeof privacyProcessingActivitiesTable.$inferSelect;
export type PrivacyRightsRequest = typeof privacyRightsRequestsTable.$inferSelect;
export type PrivacyRetentionSchedule = typeof privacyRetentionSchedulesTable.$inferSelect;
export type PrivacyRetentionVerification = typeof privacyRetentionVerificationsTable.$inferSelect;
export type PrivacyProcessor = typeof privacyProcessorsTable.$inferSelect;
export type PrivacyBreach = typeof privacyBreachesTable.$inferSelect;

export type InsertPrivacyProgram = z.infer<typeof insertPrivacyProgramSchema>;
export type InsertPrivacyProcessingActivity = z.infer<typeof insertPrivacyProcessingActivitySchema>;
export type InsertPrivacyRightsRequest = z.infer<typeof insertPrivacyRightsRequestSchema>;
export type InsertPrivacyRetentionSchedule = z.infer<typeof insertPrivacyRetentionScheduleSchema>;
export type InsertPrivacyRetentionVerification = z.infer<typeof insertPrivacyRetentionVerificationSchema>;
export type InsertPrivacyProcessor = z.infer<typeof insertPrivacyProcessorSchema>;
export type InsertPrivacyBreach = z.infer<typeof insertPrivacyBreachSchema>;