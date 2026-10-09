import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { clientsTable } from "./clients";

export const auditLogTable = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "restrict" }),
  tableName: text("table_name").notNull(),
  rowId: integer("row_id").notNull(),
  action: text("action", { enum: ["create", "update", "delete"] }).notNull(),
  // Deliberately no FK: anonymising/deleting an account must not mutate evidence.
  changedBy: integer("changed_by"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  diff: jsonb("diff").$type<Record<string, { before: unknown; after: unknown }>>().notNull(),
}, (table) => [index("audit_log_tenant_module_time").on(table.clientId, table.tableName, table.changedAt, table.id)]);
export const insertAuditLogSchema = createInsertSchema(auditLogTable).omit({ id: true, changedAt: true });
export type AuditLog = typeof auditLogTable.$inferSelect;