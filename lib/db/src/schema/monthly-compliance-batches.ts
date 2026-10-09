import { integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

export const monthlyComplianceBatchesTable = pgTable("monthly_compliance_batches", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  monthKey: text("month_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("monthly_compliance_batch_unique").on(t.clientId, t.monthKey)]);