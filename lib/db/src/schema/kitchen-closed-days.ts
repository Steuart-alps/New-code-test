import { pgTable, serial, text, timestamp, integer, date, index } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";

// Planned (or recorded) KitchenTrack non-operating days. A closed day is not a
// missing diary day. Scoped like the diary: site_id NULL is the
// whole-organisation diary, otherwise one site's diary; the scopes are
// independent. Rows are never deleted by the app: removing a closure sets
// removed_at/removed_by, and the audit log keeps every change.
export const kitchenClosedDaysTable = pgTable("kitchen_closed_days", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  // Cascade, not SET NULL: a deleted site's closures must never turn into
  // whole-organisation closures.
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  closedDate: date("closed_date").notNull(),
  reason: text("reason").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  removedBy: integer("removed_by").references(() => usersTable.id, { onDelete: "set null" }),
  removedAt: timestamp("removed_at"),
}, (table) => [
  index("IDX_kitchen_closed_days_client_date").on(table.clientId, table.closedDate),
  // One active closure per scope and day: partial unique indexes created by
  // the API's runtime migrations (migrateKitchenClosedDays), like the diary's.
]);

export type KitchenClosedDay = typeof kitchenClosedDaysTable.$inferSelect;
