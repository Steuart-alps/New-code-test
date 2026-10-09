import { bigserial, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * First-party product analytics. Each row is one allowlisted, non-identifying
 * custom event: its name, its fixed enum dimensions and the hour it happened.
 * There is deliberately no user, client, session, IP or user-agent column.
 * Rows are purged after 13 months (api-server src/lib/analytics.ts).
 */
export const analyticsEventsTable = pgTable("analytics_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventName: text("event_name").notNull(),
  dimensions: jsonb("dimensions").$type<Record<string, string>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("IDX_analytics_events_occurred_at").on(table.occurredAt),
  index("IDX_analytics_events_name_occurred_at").on(table.eventName, table.occurredAt),
]);

export type AnalyticsEvent = typeof analyticsEventsTable.$inferSelect;
