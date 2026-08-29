import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const staffTrainingRecordsTable = pgTable("staff_training_records", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  staffName: text("staff_name").notNull(), // denormalized so records survive user deletion
  courseName: text("course_name").notNull(),
  issuedAt: timestamp("issued_at"),
  expiresAt: timestamp("expires_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertStaffTrainingRecordSchema = createInsertSchema(staffTrainingRecordsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type StaffTrainingRecord = typeof staffTrainingRecordsTable.$inferSelect;
export type InsertStaffTrainingRecord = z.infer<typeof insertStaffTrainingRecordSchema>;
