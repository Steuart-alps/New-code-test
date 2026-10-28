import { bigint, boolean, check, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

/** What a row is for. Each AI feature that sends work to Claude has its own name. */
export const aiUsageFeatureEnum = ["report_reading", "register_reading", "certificate_reading"] as const;
export type AiUsageFeature = (typeof aiUsageFeatureEnum)[number];

/**
 * One request to Claude for a business, priced so the AI add-on's monthly
 * allowance can be enforced (api-server src/lib/aiAllowance.ts). A row is
 * written "pending" at the estimated cost before the request, under a
 * per-business lock, then settled with the real tokens and cost. Costs are in
 * millionths of a US dollar because Anthropic bills in dollars.
 */
export const aiUsageTable = pgTable("ai_usage", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  feature: text("feature").notNull(),
  status: text("status").notNull().default("pending"),
  model: text("model"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  webSearches: integer("web_searches").notNull().default(0),
  costUsdMicros: bigint("cost_usd_micros", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  index("idx_ai_usage_client_created").on(table.clientId, table.createdAt),
  check("ck_ai_usage_status", sql`${table.status} IN ('pending', 'done', 'failed')`),
  check("ck_ai_usage_cost_nonnegative", sql`${table.costUsdMicros} >= 0`),
]);

/**
 * An AI top-up bought for a business once its monthly allowance runs low:
 * charged at once as a one-off invoice, it adds allowance_pence of AI use
 * until the add-on renews (api-server src/lib/aiTopUp.ts). request_id makes a
 * repeated request (a double click, a retry) charge only once. Automatic
 * top-ups use "auto-<period start>-<n>", so requests running together share one.
 */
export const aiTopUpsTable = pgTable("ai_top_ups", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  requestId: text("request_id").notNull(),
  automatic: boolean("automatic").notNull().default(false),
  amountPence: integer("amount_pence").notNull(),
  allowancePence: integer("allowance_pence").notNull(),
  currency: text("currency").notNull().default("gbp"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("uq_ai_top_ups_client_request").on(table.clientId, table.requestId),
  index("idx_ai_top_ups_client_created").on(table.clientId, table.createdAt),
  check("ck_ai_top_ups_status", sql`${table.status} IN ('pending', 'paid', 'failed', 'unknown')`),
  check("ck_ai_top_ups_amounts", sql`${table.amountPence} > 0 AND ${table.allowancePence} >= 0`),
]);
