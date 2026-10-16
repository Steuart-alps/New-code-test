import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contractorsTable } from "./contractors";
import { complianceItemsTable } from "./compliance-items";
import { clientsTable } from "./clients";
import { fixTrackIssuesTable } from "./fix-track";

/** Overall result stated on a certificate or report (e.g. an EICR). Rows from
 *  before outcomes were recorded are "not_stated" and behave as satisfactory. */
export const certificateOutcomeEnum = ["satisfactory", "unsatisfactory", "not_stated"] as const;
export type CertificateOutcome = (typeof certificateOutcomeEnum)[number];

export const certificatesTable = pgTable("certificates", {
  id: serial("id").primaryKey(),
  contractorId: integer("contractor_id").references(() => contractorsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").references(() => complianceItemsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fileUrl: text("file_url"),
  issueDate: timestamp("issue_date"),
  expiryDate: timestamp("expiry_date"),
  notes: text("notes"),
  /** Only a satisfactory (or legacy not-stated) certificate's expiry may move
   *  its compliance check's due date. Also created by the runtime migrations. */
  outcome: text("outcome").$type<CertificateOutcome>().notNull().default("not_stated"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCertificateSchema = createInsertSchema(certificatesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCertificate = z.infer<typeof insertCertificateSchema>;
export type Certificate = typeof certificatesTable.$inferSelect;

/** Defect / observation codes recorded against a certificate: EICR C1
 *  (danger present), C2 (potentially dangerous), C3 (improvement recommended)
 *  and FI (further investigation); gas ID (immediately dangerous) and AR (at
 *  risk); "other" for anything else. */
export const certificateDefectCodeEnum = ["C1", "C2", "C3", "FI", "ID", "AR", "other"] as const;
export type CertificateDefectCode = (typeof certificateDefectCodeEnum)[number];

/**
 * Defects listed on an item certificate. Each one opens a FixTrack job
 * (fix_track_issue_id) when the business has FixTrack; a C1/C2/FI/ID/AR defect
 * keeps the compliance check needing action until that job is resolved or
 * closed (or, without a job, until resolved_at is recorded), or a newer
 * satisfactory certificate is added. Also created by the runtime migrations.
 */
export const certificateDefectsTable = pgTable("certificate_defects", {
  id: serial("id").primaryKey(),
  certificateId: integer("certificate_id").notNull().references(() => certificatesTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  code: text("code").$type<CertificateDefectCode>().notNull(),
  description: text("description").notNull(),
  location: text("location"),
  fixTrackIssueId: integer("fix_track_issue_id").references(() => fixTrackIssuesTable.id, { onDelete: "set null" }),
  /** Remedied without a FixTrack job (no FixTrack, or the job was deleted). */
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("IDX_certificate_defects_certificate").on(table.clientId, table.certificateId),
  index("IDX_certificate_defects_fix_track_issue").on(table.fixTrackIssueId),
]);

export type CertificateDefect = typeof certificateDefectsTable.$inferSelect;
