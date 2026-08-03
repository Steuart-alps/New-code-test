import { pgTable, serial, integer, text, date, timestamp, numeric } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { hotTubsTable } from "./hot-tubs";

export const HOT_TUB_CHECK_TYPES = [
  "water_chemistry",
  "temperature",
  "filter_clean",
  "cover_inspection",
  "drain_refill",
  "microbiological_test",
  "risk_assessment",
] as const;

export type HotTubCheckType = (typeof HOT_TUB_CHECK_TYPES)[number];

export const hotTubChecksTable = pgTable("hot_tub_checks", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "set null" }),
  checkType: text("check_type").notNull(),
  checkDate: date("check_date").notNull(),
  result: text("result").notNull().default("pass"), // pass | fail | action_required
  phValue: numeric("ph_value", { precision: 4, scale: 2 }),          // target 7.2–7.8
  sanitiserLevel: numeric("sanitiser_level", { precision: 6, scale: 2 }), // ppm (Cl/Br)
  temperature: numeric("temperature", { precision: 5, scale: 2 }),    // °C (max 40)
  hotTubId: integer("hot_tub_id").references(() => hotTubsTable.id, { onDelete: "set null" }),
  location: text("location"),      // specific area / supplementary name
  performedBy: text("performed_by"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type HotTubCheck = typeof hotTubChecksTable.$inferSelect;
export type NewHotTubCheck = typeof hotTubChecksTable.$inferInsert;
