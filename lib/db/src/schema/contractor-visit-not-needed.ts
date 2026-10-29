import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { clientsTable } from "./clients";
import { sitesTable } from "./sites";
import { complianceItemsTable } from "./compliance-items";
import { usersTable } from "./users";

/**
 * Inspections a manager has marked "No contractor needed" on the Contractors
 * page (api-server src/lib/contractorVisits.ts): a track visit at a site
 * (visit_key such as "green:loler", with site_id), or a check from the
 * compliance check register (visit_key "check", with compliance_item_id).
 * Picking a contractor removes the row. Also created by the runtime
 * migrations.
 */
export const contractorVisitNotNeededTable = pgTable("contractor_visit_not_needed", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  visitKey: text("visit_key").notNull(),
  siteId: integer("site_id").references(() => sitesTable.id, { onDelete: "cascade" }),
  complianceItemId: integer("compliance_item_id").references(() => complianceItemsTable.id, { onDelete: "cascade" }),
  markedBy: integer("marked_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_contractor_visit_not_needed_visit").on(table.clientId, table.visitKey, table.siteId)
    .where(sql`${table.complianceItemId} IS NULL`),
  uniqueIndex("uq_contractor_visit_not_needed_check").on(table.complianceItemId)
    .where(sql`${table.complianceItemId} IS NOT NULL`),
]);
