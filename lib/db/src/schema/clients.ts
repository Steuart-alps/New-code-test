import { pgTable, serial, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clientsTable = pgTable("clients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").notNull().default("#6366f1"),
  active: boolean("active").notNull().default(true),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  subscriptionStatus: text("subscription_status").default("trial"),
  trialEndsAt: timestamp("trial_ends_at"),
  // Module keys picked on the pricing page at signup — used to pre-tick the
  // post-trial checkout. `["bundle"]` marks a full-bundle selection.
  selectedServices: jsonb("selected_services").$type<string[]>(),
  trialReminderSentAt: timestamp("trial_reminder_sent_at"),
  // Offboarding / data retention
  cancelledAt: timestamp("cancelled_at"),
  offboardingEmailSentAt: timestamp("offboarding_email_sent_at"),
  dataDeletionScheduledAt: timestamp("data_deletion_scheduled_at"),
  dataDeletedAt: timestamp("data_deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertClientSchema = createInsertSchema(clientsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
