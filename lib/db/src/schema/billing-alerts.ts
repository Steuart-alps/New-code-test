import { index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

/**
 * A billing change ALPS has been told about (api-server
 * src/lib/billingAlerts.ts): a new subscription, a cancellation, a plan change
 * (modules, AI, storage or sites) or a sent weekly digest. Claimed by
 * (kind, alert_key) before any email, so a webhook Stripe delivers twice
 * sends once. monthly_pence is the monthly amount before VAT gained (new),
 * lost (cancellation) or the change (plan change); the Monday digest adds
 * them up. business_name is kept so the digest still reads after a business
 * is deleted.
 */
export const billingAlertsTable = pgTable("billing_alerts", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  alertKey: text("alert_key").notNull(),
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "set null" }),
  businessName: text("business_name"),
  summary: text("summary"),
  monthlyPence: integer("monthly_pence").notNull().default(0),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("uq_billing_alerts_kind_key").on(table.kind, table.alertKey),
  index("idx_billing_alerts_created").on(table.createdAt),
]);
