import { pgTable, serial, text, integer, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";

export const departmentsTable = pgTable("departments", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  // The site the department belongs to; null for one that spans every site
  // (all departments made before departments moved under sites).
  siteId: integer("site_id").references((): AnyPgColumn => sitesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  // Created by the api-server runtime migrations.
  index("IDX_departments_site").on(table.siteId),
]);

export const insertDepartmentSchema = createInsertSchema(departmentsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertDepartment = z.infer<typeof insertDepartmentSchema>;
export type Department = typeof departmentsTable.$inferSelect;
