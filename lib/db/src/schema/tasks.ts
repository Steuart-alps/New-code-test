import { boolean, date, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

export const taskRecurrenceEnum = ["once", "daily", "weekly", "monthly"] as const;
export type TaskRecurrence = (typeof taskRecurrenceEnum)[number];
/** Role groups a task can be assigned to instead of one person. */
export const taskAssigneeRoleEnum = ["client_staff", "managers"] as const;
export type TaskAssigneeRole = (typeof taskAssigneeRoleEnum)[number];

/**
 * Routine staff tasks ("Kitchen opening checklist", "Weekly fire alarm test").
 * A task is assigned to one user or to a role group, optionally for one site
 * and linked to a module. Occurrences are derived on read from `startsOn` and
 * `recurrence` (no scheduler); only completions are stored.
 */
export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  instruction: text("instruction"),
  /** Optional module key (e.g. "firetrack") the task links to. */
  module: text("module"),
  assigneeUserId: integer("assignee_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  assigneeRole: text("assignee_role").$type<TaskAssigneeRole>(),
  recurrence: text("recurrence").$type<TaskRecurrence>().notNull().default("once"),
  /** Due date of a one-off task; first occurrence of a recurring one. Weekly
   *  tasks repeat on this weekday, monthly on this day of the month. */
  startsOn: date("starts_on").notNull(),
  /** Archived tasks stop producing occurrences; history is kept. */
  active: boolean("active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("IDX_tasks_client").on(table.clientId),
  index("IDX_tasks_assignee").on(table.assigneeUserId),
]);

/** Who ticked one occurrence of a task done, and when. */
export const taskCompletionsTable = pgTable("task_completions", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  taskId: integer("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),
  occurrenceDate: date("occurrence_date").notNull(),
  completedBy: integer("completed_by").references(() => usersTable.id, { onDelete: "set null" }),
  completedByName: text("completed_by_name").notNull(),
  note: text("note"),
  completedAt: timestamp("completed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_task_completions_task_date").on(table.taskId, table.occurrenceDate),
  index("IDX_task_completions_client").on(table.clientId),
]);

export type Task = typeof tasksTable.$inferSelect;
export type TaskCompletion = typeof taskCompletionsTable.$inferSelect;
