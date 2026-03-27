import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AppSetting = typeof appSettingsTable.$inferSelect;
