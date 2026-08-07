import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { clientsTable } from "./clients";

/**
 * Expo push notification tokens registered by the mobile app.
 * One row per device token; the token is unique so re-registering a device
 * upserts rather than duplicating. Pruned when Expo reports the device is no
 * longer registered (see lib/pushNotifications.ts).
 */
export const pushTokensTable = pgTable("push_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  platform: text("platform"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PushToken = typeof pushTokensTable.$inferSelect;
export type NewPushToken = typeof pushTokensTable.$inferInsert;
