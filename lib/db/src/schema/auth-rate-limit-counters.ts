import { createInsertSchema } from "drizzle-zod";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const authRateLimitCountersTable = pgTable("auth_rate_limit_counters", {
  keyHash: text("key_hash").primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("IDX_auth_rate_limit_counters_expires_at").on(table.expiresAt),
]);

export const insertAuthRateLimitCounterSchema = createInsertSchema(authRateLimitCountersTable)
  .omit({ updatedAt: true });
export type AuthRateLimitCounter = typeof authRateLimitCountersTable.$inferSelect;