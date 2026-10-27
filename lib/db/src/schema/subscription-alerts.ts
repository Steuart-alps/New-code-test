import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { clientsTable } from "./clients";

/**
 * A Stripe subscription ALPS has been emailed about (api-server
 * src/lib/subscriptionAlert.ts). Claimed before the email is sent, so a
 * webhook Stripe delivers twice sends one alert.
 */
export const newSubscriptionAlertsTable = pgTable("new_subscription_alerts", {
  stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
