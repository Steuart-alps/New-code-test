import { pgTable, serial, integer, text, bigint, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

/** Immutable per-response ledger. The event id makes stream completion retry-safe. */
export const storageDownloadEventsTable = pgTable("storage_download_events", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  eventUnique: uniqueIndex("uq_storage_download_events_event").on(table.eventId),
  tenantMonth: index("idx_storage_download_events_tenant_month").on(table.clientId, table.month),
}));

/** Compact month aggregate used by the usage endpoint. */
export const storageDownloadMonthsTable = pgTable("storage_download_months", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  tenantMonthUnique: uniqueIndex("uq_storage_download_months_tenant_month").on(table.clientId, table.month),
  tenantMonth: index("idx_storage_download_months_tenant_month").on(table.clientId, table.month),
}));