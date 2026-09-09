import { pgTable, serial, text, timestamp, integer, date, jsonb } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { contractorsTable } from "./contractors";

export const fixTrackIssuesTable = pgTable("fix_track_issues", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  issueType: text("issue_type").notNull().default("general"),
  location: text("location").notNull(),
  description: text("description"),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("reported"),
  reportedBy: text("reported_by").notNull(),
  reportedDate: date("reported_date").notNull(),
  assignedTo: text("assigned_to"),
  contractorId: integer("contractor_id").references(() => contractorsTable.id, { onDelete: "set null" }),
  targetDate: date("target_date"),
  resolvedDate: date("resolved_date"),
  resolvedByName: text("resolved_by_name"),
  resolverSignature: text("resolver_signature"),
  solutionNotes: text("solution_notes"),
  // Pending contractor-email approval request ("assign" | "quote")
  emailRequestMode: text("email_request_mode"),
  emailRequestedBy: integer("email_requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  emailRequestedAt: timestamp("email_requested_at"),
  // Email dispatch is a separate, auditable state machine. In particular,
  // "approved" is required before the outbound email route may send.
  emailRequestStatus: text("email_request_status"),
  emailApprovedBy: integer("email_approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  emailApprovedAt: timestamp("email_approved_at"),
  // Kept separately from the approver: a manager can approve a request and a
  // different authorised manager can perform the resulting dispatch.
  emailSentBy: integer("email_sent_by").references(() => usersTable.id, { onDelete: "set null" }),
  emailSentAt: timestamp("email_sent_at"),
  mediaUrls: jsonb("media_urls").default([]).$type<string[]>(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const fixTrackIssueActivityTable = pgTable("fix_track_issue_activity", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  issueId: integer("issue_id").notNull().references(() => fixTrackIssuesTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  status: text("status"),
  note: text("note"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type FixTrackIssue = typeof fixTrackIssuesTable.$inferSelect;
export type FixTrackIssueActivity = typeof fixTrackIssueActivityTable.$inferSelect;
