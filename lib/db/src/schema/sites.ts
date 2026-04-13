import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const sitesTable = pgTable("sites", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Site = typeof sitesTable.$inferSelect;
export type InsertSite = typeof sitesTable.$inferInsert;
