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
  // Business type chosen at signup (e.g. "care_home_healthcare"); drives
  // business-specific starter checks and healthcare water temperature defaults.
  businessType: text("business_type"),
  // Set when the first-run setup wizard is finished (or for businesses that
  // already had records when the wizard was introduced). Null = show it.
  setupCompletedAt: timestamp("setup_completed_at"),
  trialReminderSentAt: timestamp("trial_reminder_sent_at"),
  trialEndedEmailSentAt: timestamp("trial_ended_email_sent_at"),
  // Claimed before cancellation cutoff warnings are delivered. Kept separate
  // from trial reminders because paid access can end independently of a trial.
  cancellationWarningSentAt: timestamp("cancellation_warning_sent_at"),
  safeTrackEnabled: boolean("safe_track_enabled").notNull().default(false),
  dailyTrackEnabled: boolean("daily_track_enabled").notNull().default(false),
  // Offboarding / data retention
  cancelledAt: timestamp("cancelled_at"),
  offboardingEmailSentAt: timestamp("offboarding_email_sent_at"),
  deletionReminderSentAt: timestamp("deletion_reminder_sent_at", { withTimezone: true }),
  dataDeletionScheduledAt: timestamp("data_deletion_scheduled_at"),
  dataDeletedAt: timestamp("data_deleted_at"),
  // When a cancelled business's stored files were moved to cheaper storage
  // (cleared when they are moved back after reactivation).
  filesArchivedAt: timestamp("files_archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  staffKioskTokenHash: text("staff_kiosk_token_hash"),
});

export const insertClientSchema = createInsertSchema(clientsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;
