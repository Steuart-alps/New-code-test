import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";

export const complianceStatusEnum = ["pending", "in_progress", "completed", "overdue"] as const;
export const compliancePriorityEnum = ["low", "medium", "high", "critical"] as const;

export const complianceItemsTable = pgTable("compliance_items", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").$type<(typeof complianceStatusEnum)[number]>().notNull().default("pending"),
  priority: text("priority").$type<(typeof compliancePriorityEnum)[number]>().notNull().default("medium"),
  categoryId: integer("category_id").references(() => categoriesTable.id, { onDelete: "set null" }),
  assignedTo: text("assigned_to"),
  dueDate: timestamp("due_date"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertComplianceItemSchema = createInsertSchema(complianceItemsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
});

export type InsertComplianceItem = z.infer<typeof insertComplianceItemSchema>;
export type ComplianceItem = typeof complianceItemsTable.$inferSelect;
