import { pgTable, serial, integer, text, timestamp, date, index } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { staffMembersTable } from "./staff-members";

/**
 * TrainTrack certificates, sign-offs and internal training. Mirrors the
 * runtime migrations (migrateTrainTrack / migrateStaffRosterAttribution),
 * which own the production table. staff_name is an immutable snapshot;
 * staff_roster_id is the stable identity used by the training matrix and is
 * NULL on legacy, name-only rows.
 */
export const trainTrackRecordsTable = pgTable("train_track_records", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  recordType: text("record_type").notNull().default("internal"),
  staffName: text("staff_name").notNull(),
  staffRosterId: integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  trainingType: text("training_type"),
  documentTitle: text("document_title"),
  documentType: text("document_type"),
  provider: text("provider"),
  trainer: text("trainer"),
  completedDate: date("completed_date").notNull(),
  expiryDate: date("expiry_date"),
  notes: text("notes"),
  signature: text("signature"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("IDX_train_track_client").on(table.clientId),
  index("IDX_train_track_records_staff_roster").on(table.staffRosterId),
]);

export type TrainTrackRecord = typeof trainTrackRecordsTable.$inferSelect;
