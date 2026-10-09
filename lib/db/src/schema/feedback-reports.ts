import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const feedbackReportsTable = pgTable("feedback_reports", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  category: text("category").notNull(),
  summary: text("summary").notNull(),
  details: text("details").notNull(),
  pagePath: text("page_path"),
  emailStatus: text("email_status").notNull().default("pending"),
  status: text("status").notNull().default("new"),
  internalNote: text("internal_note").notNull().default(""),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at"),
  // Incremented by every accepted status/note change. Updates name the
  // revision they were drafted against, so a stale draft cannot silently
  // overwrite another manager's save.
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Append-only review history: one row per accepted status/note change,
 * written in the same transaction as the report update. Runtime-migration
 * triggers reject edits, direct deletes and cross-tenant rows; history leaves
 * only with its report or client, and the actor is nulled when a user is
 * removed, mirroring the report's own retention.
 */
export const feedbackReportReviewsTable = pgTable("feedback_report_reviews", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").notNull().references(() => feedbackReportsTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  actorId: integer("actor_id").references(() => usersTable.id, { onDelete: "set null" }),
  previousStatus: text("previous_status").notNull(),
  status: text("status").notNull(),
  previousInternalNote: text("previous_internal_note").notNull(),
  internalNote: text("internal_note").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [
  uniqueIndex("UQ_feedback_report_reviews_report_revision").on(table.reportId, table.revision),
  index("IDX_feedback_report_reviews_client_report").on(table.clientId, table.reportId),
]);
