import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_app_settings_client_key").on(table.clientId, table.key),
]);

export type AppSetting = typeof appSettingsTable.$inferSelect;
