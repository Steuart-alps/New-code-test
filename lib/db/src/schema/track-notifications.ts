import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

/**
 * Who looks after each track (module) for a business: one user per module,
 * optionally overridden per site. `siteId` null = every site. Reminders go to
 * the site's owner, else the module-wide owner, else the business's admins
 * (see api-server lib/trackOwners.ts). Also created by the api-server runtime
 * migrations (migrateTrackOwnersAndNotifications).
 */
export const trackOwnersTable = pgTable("track_owners", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  module: text("module").notNull(),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_track_owners_client_module_site")
    .on(table.clientId, table.module, table.siteId)
    .where(sql`${table.siteId} IS NOT NULL`),
  uniqueIndex("UQ_track_owners_client_module_all_sites")
    .on(table.clientId, table.module)
    .where(sql`${table.siteId} IS NULL`),
]);

/**
 * In-app notifications (the header bell; mirrored to the mobile app as an
 * Expo push). One row per recipient; `dedupeKey` makes scheduled reminders
 * idempotent per user, e.g. `daily_am:site:12:2026-10-13`.
 */
export const userNotificationsTable = pgTable("user_notifications", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  module: text("module"),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  linkPath: text("link_path"),
  dedupeKey: text("dedupe_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  readAt: timestamp("read_at"),
}, (table) => [
  uniqueIndex("UQ_user_notifications_user_dedupe").on(table.userId, table.dedupeKey),
  index("IDX_user_notifications_user_client_created").on(table.userId, table.clientId, table.createdAt),
]);

export type TrackOwner = typeof trackOwnersTable.$inferSelect;
export type UserNotification = typeof userNotificationsTable.$inferSelect;
