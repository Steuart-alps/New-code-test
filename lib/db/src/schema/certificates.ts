import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contractorsTable } from "./contractors";

export const certificatesTable = pgTable("certificates", {
  id: serial("id").primaryKey(),
  contractorId: integer("contractor_id").notNull().references(() => contractorsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  fileUrl: text("file_url"),
  issueDate: timestamp("issue_date"),
  expiryDate: timestamp("expiry_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCertificateSchema = createInsertSchema(certificatesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCertificate = z.infer<typeof insertCertificateSchema>;
export type Certificate = typeof certificatesTable.$inferSelect;
