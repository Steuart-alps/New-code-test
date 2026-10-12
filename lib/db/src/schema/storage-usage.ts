import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, bigint, boolean, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
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

export const storageDownloadTokensTable = pgTable("storage_download_tokens", {
  id: serial("id").primaryKey(),
  tokenDigest: text("token_digest").notNull(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  objectPath: text("object_path").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  digestUnique: uniqueIndex("uq_storage_download_tokens_digest").on(table.tokenDigest),
  expiry: index("idx_storage_download_tokens_expiry").on(table.expiresAt),
}));

/**
 * Retained-storage ledger: one row per private object path, owned by one
 * tenant. Finalisation upserts present=true and deletion leaves a tombstone,
 * so totals are SUM(size_bytes) over present rows and replays are idempotent.
 * Maintained by api-server src/lib/storageUsageSnapshot.ts.
 */
export const storageUsageObjectsTable = pgTable("storage_usage_objects", {
  objectPath: text("object_path").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  present: boolean("present").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_storage_usage_objects_tenant").on(table.clientId, table.present),
  check("storage_usage_objects_size_nonnegative", sql`${table.sizeBytes} >= 0`),
]);

/** Lifecycle changes in flight; a marker left behind by a crash forces reconciliation. */
export const storageUsagePendingTable = pgTable("storage_usage_pending", {
  id: text("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_storage_usage_pending_tenant").on(table.clientId, table.startedAt),
]);

/** Last reconciliation of each tenant's ledger against provider metadata. */
export const storageUsageSnapshotsTable = pgTable("storage_usage_snapshots", {
  clientId: integer("client_id").primaryKey().references(() => clientsTable.id, { onDelete: "cascade" }),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  objectCount: integer("object_count").notNull().default(0),
  driftBytes: bigint("drift_bytes", { mode: "number" }).notNull().default(0),
  driftObjects: integer("drift_objects").notNull().default(0),
  lastDriftAt: timestamp("last_drift_at", { withTimezone: true }),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
  refreshLeaseToken: text("refresh_lease_token"),
  refreshLeaseUntil: timestamp("refresh_lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
