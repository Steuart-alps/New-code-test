import { pgTable, serial, integer, date, real, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";

// The overnight forecast checked for a site each afternoon (api-server
// lib/frostWarnings.ts). One row per site and night, so the forecast is
// fetched once; `warn` is true when the overnight low is below the frost
// warning threshold, and the dashboard shows tonight's warnings from it.
export const frostForecastsTable = pgTable("frost_forecasts", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id")
    .notNull()
    .references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id")
    .notNull()
    .references(() => sitesTable.id, { onDelete: "cascade" }),
  // The evening the night starts.
  nightOf: date("night_of").notNull(),
  lowestC: real("lowest_c").notNull(),
  coldestAt: timestamp("coldest_at", { withTimezone: true }),
  warn: boolean("warn").notNull().default(false),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("UQ_frost_forecasts_site_night").on(table.siteId, table.nightOf),
  index("IDX_frost_forecasts_client_night").on(table.clientId, table.nightOf),
]);

export type FrostForecast = typeof frostForecastsTable.$inferSelect;
