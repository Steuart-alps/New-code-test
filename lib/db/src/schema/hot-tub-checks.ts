import { pgTable, serial, integer, text, date, timestamp, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { usersTable } from "./users";
import { hotTubsTable } from "./hot-tubs";
import { staffMembersTable } from "./staff-members";

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
  result: text("result").notNull().default("pass"), // new writes: pass | fail; legacy action_required remains readable
  phValue: numeric("ph_value", { precision: 4, scale: 2 }),          // target 7.2–7.8
  sanitiserLevel: numeric("sanitiser_level", { precision: 6, scale: 2 }), // ppm (Cl/Br)
  temperature: numeric("temperature", { precision: 5, scale: 2 }),    // °C (max 40)
  hotTubId: integer("hot_tub_id").references(() => hotTubsTable.id, { onDelete: "set null" }),
  session: text("session"),        // morning | midday | evening (3× daily checks)
  location: text("location"),      // specific area / supplementary name
  performedBy: text("performed_by"),
  staffRosterId: integer("staff_roster_id").references(() => staffMembersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Mobile outbox entry ID and payload fingerprint: a replay of an applied
  // submission is recognised instead of creating a duplicate. Not a credential.
  clientEntryId: text("client_entry_id"),
  clientEntryHash: text("client_entry_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Created by the api-server runtime migrations (dashboard read paths).
  index("IDX_hot_tub_checks_client_date").on(table.clientId, table.checkDate),
  uniqueIndex("UQ_hot_tub_checks_client_entry_id")
    .on(table.clientId, table.clientEntryId)
    .where(sql`${table.clientEntryId} IS NOT NULL`),
]);

export type HotTubCheck = typeof hotTubChecksTable.$inferSelect;
export type NewHotTubCheck = typeof hotTubChecksTable.$inferInsert;
