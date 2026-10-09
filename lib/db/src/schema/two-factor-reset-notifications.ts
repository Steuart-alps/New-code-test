import { pgTable, serial, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

/**
 * Durable outbox for the security alert sent after an administrator resets a
 * user's two-factor authentication. Each row is queued in the same transaction
 * as the reset, so a provider outage or restart cannot lose the alert.
 *
 * Privacy: rows hold only the user id and the non-secret reset time. The
 * message is rendered at send time from the user's current record; no
 * authenticator secret, recovery code, hash, token or rendered message is
 * ever stored here.
 */
export const twoFactorResetNotificationsTable = pgTable("two_factor_reset_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** Random per-alert identity; the provider key also covers the rendered content. */
  deliveryKey: text("delivery_key").notNull(),
  resetAt: timestamp("reset_at").notNull(),
  status: text("status").notNull().default("pending"), // pending | sending | sent | expired
  claimToken: text("claim_token"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  sentAt: timestamp("sent_at"),
}, (table) => [
  uniqueIndex("UQ_two_factor_reset_notifications_delivery_key").on(table.deliveryKey),
  uniqueIndex("UQ_two_factor_reset_notifications_open")
    .on(table.userId)
    .where(sql`${table.status} IN ('pending', 'sending')`),
  index("IDX_two_factor_reset_notifications_due").on(table.status, table.nextAttemptAt),
]);

export type TwoFactorResetNotification = typeof twoFactorResetNotificationsTable.$inferSelect;
