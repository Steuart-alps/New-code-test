import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { trackActionsTable } from "./track-actions";

// Append-only inspection evidence shared by every operational track.
// The review columns are the only mutable part: the evidence content itself
// must remain the exact record that was entered by the recorder.
export const trackEvidenceTable = pgTable("track_evidence", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  module: text("module").notNull(),
  sourceKind: text("source_kind"),
  sourceRecordId: integer("source_record_id"),
  actionId: integer("action_id").references(() => trackActionsTable.id, { onDelete: "set null" }),
  requirementKey: text("requirement_key"),
  evidenceType: text("evidence_type").notNull(),
  title: text("title").notNull(),
  details: text("details").notNull(),
  reference: text("reference"),
  recordedBy: integer("recorded_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  recordedByName: text("recorded_by_name").notNull(),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  reviewStatus: text("review_status").notNull().default("recorded"),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  reviewedByName: text("reviewed_by_name"),
  reviewedAt: timestamp("reviewed_at"),
  reviewNotes: text("review_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});