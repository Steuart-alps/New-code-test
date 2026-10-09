import { pgTable, serial, integer, text, timestamp, jsonb, unique } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const greenMachineReconciliationsTable = pgTable("green_machine_reconciliations", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  reconciliationMonth: text("reconciliation_month").notNull(),
  sourceName: text("source_name"),
  postedBy: integer("posted_by").references(() => usersTable.id, { onDelete: "set null" }),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
  totalRows: integer("total_rows").notNull().default(0),
  addedCount: integer("added_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  reactivatedCount: integer("reactivated_count").notNull().default(0),
  deactivatedCount: integer("deactivated_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  snapshot: jsonb("snapshot").notNull(),
}, (table) => ({
  clientMonthUnique: unique("UQ_green_machine_reconciliation_client_month")
    .on(table.clientId, table.reconciliationMonth),
}));

export type GreenMachineReconciliation = typeof greenMachineReconciliationsTable.$inferSelect;