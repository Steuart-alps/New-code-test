import { bigint, date, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

/** Who wrote the report. "alps_audit" is ALPS's own audit; CareTrack can add its own kinds. */
export const inspectionReportTypeEnum = [
  "alps_audit", "care_inspectorate", "eho", "fire_officer", "hse", "insurer", "other",
] as const;
export type InspectionReportType = (typeof inspectionReportTypeEnum)[number];

/** One action as a person is checking it, before it becomes a track_actions row. */
export interface InspectionReportDraftAction {
  title: string;
  instruction: string | null;
  module: string;
  severity: "monitor" | "action_required" | "urgent";
  siteId: number | null;
  dueDate: string | null;
  assignedUserId: number | null;
  reportReference: string | null;
  draftSource: "ai" | "manual";
}

/**
 * An outside or ALPS report (audit, Care Inspectorate, EHO, fire officer...)
 * uploaded so its required actions become track actions. The file stays in
 * the business's own storage; actions created from it point back here with
 * source_kind 'inspection_report:<uuid>' and source_record_id = id.
 */
export const inspectionReportsTable = pgTable("inspection_reports", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  reportType: text("report_type").$type<InspectionReportType>().notNull(),
  title: text("title").notNull(),
  reportDate: date("report_date"),
  objectPath: text("object_path").notNull(),
  fileName: text("file_name"),
  fileSize: bigint("file_size", { mode: "number" }),
  mimeType: text("mime_type"),
  /** The list being checked; cleared once its actions are created. */
  draftActions: jsonb("draft_actions").$type<InspectionReportDraftAction[]>().notNull().default([]),
  /** not_requested | reading | done | failed */
  aiStatus: text("ai_status").notNull().default("not_requested"),
  aiSummary: text("ai_summary"),
  aiModel: text("ai_model"),
  aiError: text("ai_error"),
  aiRequestedAt: timestamp("ai_requested_at"),
  /** Times this report has been sent to Claude (each one costs; capped per report). */
  aiReadCount: integer("ai_read_count").notNull().default(0),
  aiInputTokens: integer("ai_input_tokens"),
  aiOutputTokens: integer("ai_output_tokens"),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  uploadedByName: text("uploaded_by_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("IDX_inspection_reports_client").on(table.clientId, table.createdAt),
]);

export type InspectionReport = typeof inspectionReportsTable.$inferSelect;
