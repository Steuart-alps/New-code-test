import { integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { clientsTable } from "./clients";
import { usersTable } from "./users";

export const monthlyComplianceDeliveriesTable = pgTable("monthly_compliance_deliveries", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  monthKey: text("month_key").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  subject: text("subject").notNull(),
  html: text("html").notNull(),
  bodyText: text("body_text").notNull(),
  state: text("state").notNull().default("pending"),
  leaseToken: text("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [unique("monthly_compliance_delivery_unique").on(t.clientId, t.userId, t.monthKey)]);

export const insertMonthlyComplianceDeliverySchema = createInsertSchema(monthlyComplianceDeliveriesTable)
  .omit({ id: true, state: true, leaseToken: true, leaseExpiresAt: true, sentAt: true });
export type MonthlyComplianceDelivery = typeof monthlyComplianceDeliveriesTable.$inferSelect;