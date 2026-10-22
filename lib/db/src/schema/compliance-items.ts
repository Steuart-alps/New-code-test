import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sitesTable } from "./sites";
import { categoriesTable } from "./categories";
import { contractorsTable } from "./contractors";
import { clientsTable } from "./clients";
import { departmentsTable } from "./departments";
import { usersTable } from "./users";

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
  /** The person responsible, when picked from the business's users (see track_actions). */
  assigneeUserId: integer("assignee_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  dueDate: timestamp("due_date"),
  leadTimeDays: integer("lead_time_days"),
  /** Optional repeat interval. Completing a check that has one records the
   *  completion (completedAt + audit event) and reopens it as pending, due
   *  this many months after the completion date. Null = one-off check. */
  frequencyMonths: integer("frequency_months"),
  notificationSentAt: timestamp("notification_sent_at"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  /** Legacy raw scheduling token. Always NULL once runtime migrations have
   *  moved it to scheduleTokenHash; kept so older rows can be migrated. */
  scheduleToken: text("schedule_token"),
  /** SHA-256 digest of the contractor's single-use visit-scheduling token. */
  scheduleTokenHash: text("schedule_token_hash"),
  /** Equipment list item this check is for (a boiler's gas safety, a lift's
   *  LOLER). The foreign key to equipment_items comes from runtime migrations. */
  equipmentId: integer("equipment_id"),
  visitScheduledAt: timestamp("visit_scheduled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Created by the api-server runtime migrations (dashboard read paths).
  index("IDX_compliance_items_client").on(table.clientId),
]);

export const insertComplianceItemSchema = createInsertSchema(complianceItemsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
  notificationSentAt: true,
  // Set only through the equipment list, which checks the item's business.
  equipmentId: true,
});

export type InsertComplianceItem = z.infer<typeof insertComplianceItemSchema>;
export type ComplianceItem = typeof complianceItemsTable.$inferSelect;
