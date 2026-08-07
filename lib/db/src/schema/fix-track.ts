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
  solutionNotes: text("solution_notes"),
  // Pending contractor-email approval request ("assign" | "quote")
  emailRequestMode: text("email_request_mode"),
  emailRequestedBy: integer("email_requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  emailRequestedAt: timestamp("email_requested_at"),
  mediaUrls: jsonb("media_urls").default([]).$type<string[]>(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type FixTrackIssue = typeof fixTrackIssuesTable.$inferSelect;
