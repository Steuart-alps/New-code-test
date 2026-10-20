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

/**
 * Manager-requested reductions of paid extra storage. Stripe bills the lower
 * quantity from the next renewal; until effective_at (the end of the period
 * already paid for) the reduced GiB stay available. Kept as the record of who
 * changed capacity, when, from what and why it was allowed.
 * Maintained by api-server src/routes/billing.ts (POST /billing/storage/reduce).
 */
export const storageCapacityReductionsTable = pgTable("storage_capacity_reductions", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  subscriptionId: text("subscription_id").notNull(),
  subscriptionItemId: text("subscription_item_id").notNull(),
  fromGib: integer("from_gib").notNull(),
  toGib: integer("to_gib").notNull(),
  minimumGib: integer("minimum_gib").notNull(),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  requestedBy: integer("requested_by"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_storage_capacity_reductions_request").on(table.requestId),
  index("idx_storage_capacity_reductions_tenant").on(table.clientId, table.subscriptionId, table.effectiveAt),
  check("storage_capacity_reductions_lower", sql`${table.toGib} >= 0 AND ${table.toGib} < ${table.fromGib} AND ${table.toGib} >= ${table.minimumGib}`),
]);

/**
 * Each time a business's retained files passed its storage warning level and
 * its managers were emailed. At most one notice per business is open; it is
 * closed (cleared_at) once usage drops back below the level, so the next
 * crossing emails again. Rows are never deleted.
 * Maintained by api-server src/lib/storageWarningEmails.ts.
 */
export const storageWarningNoticesTable = pgTable("storage_warning_notices", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  thresholdBytes: bigint("threshold_bytes", { mode: "number" }).notNull(),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull(),
  recipientCount: integer("recipient_count").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("uq_storage_warning_notices_open").on(table.clientId).where(sql`${table.clearedAt} IS NULL`),
  index("idx_storage_warning_notices_tenant").on(table.clientId, table.sentAt),
]);

/**
 * What happened when a business's files reached its paid storage: uploads
 * stopped ("full", open until usage is back under capacity), 10 GB packs were
 * added automatically ("topped_up"), or that top-up could not be charged
 * ("top_up_failed"). Each row is emailed to the business's owners once.
 * Maintained by api-server src/lib/storageLimit.ts.
 */
export const storageLimitEventsTable = pgTable("storage_limit_events", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull(),
  capacityBytes: bigint("capacity_bytes", { mode: "number" }).notNull(),
  gibAdded: integer("gib_added"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
}, (table) => [
  check("ck_storage_limit_events_kind", sql`${table.kind} IN ('full', 'topped_up', 'top_up_failed')`),
  uniqueIndex("uq_storage_limit_events_open_full").on(table.clientId).where(sql`${table.kind} = 'full' AND ${table.clearedAt} IS NULL`),
  index("idx_storage_limit_events_tenant").on(table.clientId, table.createdAt),
]);
