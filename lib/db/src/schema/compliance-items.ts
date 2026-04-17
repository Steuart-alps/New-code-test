import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sitesTable } from "./sites";
import { categoriesTable } from "./categories";
import { contractorsTable } from "./contractors";
import { clientsTable } from "./clients";
import { departmentsTable } from "./departments";

export const complianceStatusEnum = ["pending", "in_progress", "completed", "overdue"] as const;
export const compliancePriorityEnum = ["low", "medium", "high", "critical"] as const;

export const complianceItemsTable = pgTable("compliance_items", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  departmentId: integer("department_id").references(() => departmentsTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").$type<(typeof complianceStatusEnum)[number]>().notNull().default("pending"),
  priority: text("priority").$type<(typeof compliancePriorityEnum)[number]>().notNull().default("medium"),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  categoryId: integer("category_id").references(() => categoriesTable.id, { onDelete: "set null" }),
  contractorId: integer("contractor_id").references(() => contractorsTable.id, { onDelete: "set null" }),
  assignedTo: text("assigned_to"),
  dueDate: timestamp("due_date"),
  leadTimeDays: integer("lead_time_days"),
  notificationSentAt: timestamp("notification_sent_at"),
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
  notificationSentAt: true,
});

export type InsertComplianceItem = z.infer<typeof insertComplianceItemSchema>;
export type ComplianceItem = typeof complianceItemsTable.$inferSelect;
