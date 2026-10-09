import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Creates the small set of core tables that the additive runtime migrations
 * assume already exists. Keep this explicit: runtime startup must not turn into
 * an implicit Drizzle schema push.
 */
export async function ensureRuntimeBaseline(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "clients" (
      "id" serial PRIMARY KEY,
      "name" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "logo_url" text,
      "primary_color" text NOT NULL DEFAULT '#6366f1',
      "active" boolean NOT NULL DEFAULT true,
      "stripe_customer_id" text,
      "stripe_subscription_id" text,
      "stripe_price_id" text,
      "subscription_status" text DEFAULT 'trial',
      "trial_ends_at" timestamp,
      "selected_services" jsonb,
      "trial_reminder_sent_at" timestamp,
      "cancellation_warning_sent_at" timestamp,
      "safe_track_enabled" boolean NOT NULL DEFAULT false,
      "daily_track_enabled" boolean NOT NULL DEFAULT false,
      "cancelled_at" timestamp,
      "offboarding_email_sent_at" timestamp,
      "data_deletion_scheduled_at" timestamp,
      "data_deleted_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now(),
      "staff_kiosk_token_hash" text
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "departments" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "description" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "users" (
      "id" serial PRIMARY KEY,
      "email" text NOT NULL UNIQUE,
      "password_hash" text NOT NULL,
      "name" text NOT NULL,
      "role" text NOT NULL DEFAULT 'client_viewer',
      "client_id" integer REFERENCES "clients"("id") ON DELETE CASCADE,
      "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
      "active" boolean NOT NULL DEFAULT true,
      "stripe_customer_id" text,
      "subscription_status" text DEFAULT 'trial',
      "gc_mandate_id" text,
      "gc_subscription_id" text,
      "gc_customer_id" text,
      "totp_secret" text,
      "totp_enabled" boolean NOT NULL DEFAULT false,
      "totp_recovery_hash" text,
      "is_maintenance_manager" boolean NOT NULL DEFAULT false,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "consultant_clients" (
      "id" serial PRIMARY KEY,
      "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "consultant_clients_user_client_uq"
    ON "consultant_clients" ("user_id", "client_id")
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "categories" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "color" text NOT NULL DEFAULT '#6366f1',
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  // Sites must precede compliance and SafeTrack records even though the
  // historical runtime migration also declares it later.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "sites" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
      "name" text NOT NULL,
      "responsible_person" text,
      "address" text,
      "phone" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "contractors" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "name" text NOT NULL,
      "company" text,
      "email" text NOT NULL,
      "phone" text,
      "address" text,
      "notes" text,
      "trades" jsonb DEFAULT '[]'::jsonb,
      "gas_safe_number" text,
      "public_liability_expiry" timestamp,
      "dbs_check_date" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "compliance_items" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
      "title" text NOT NULL,
      "description" text,
      "status" text NOT NULL DEFAULT 'pending',
      "priority" text NOT NULL DEFAULT 'medium',
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "category_id" integer REFERENCES "categories"("id") ON DELETE SET NULL,
      "contractor_id" integer REFERENCES "contractors"("id") ON DELETE SET NULL,
      "assigned_to" text,
      "due_date" timestamp,
      "lead_time_days" integer,
      "notification_sent_at" timestamp,
      "completed_at" timestamp,
      "notes" text,
      "schedule_token" text,
      "visit_scheduled_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "safe_training_records" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
      "staff_name" text NOT NULL,
      "training_type" text NOT NULL,
      "completed_at" date NOT NULL,
      "expiry_date" date,
      "notes" text,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  // A later attribution migration alters this core table via a dynamic table
  // list, so it is not visible in the static ALTER/REFERENCES audit.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "daily_checklists" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "checklist_type" text NOT NULL,
      "check_date" date NOT NULL,
      "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "completed_by" text,
      "staff_roster_id" integer,
      "manager_note" text,
      "submitted_at" timestamp,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "app_settings" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "key" text NOT NULL,
      "value" text,
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_app_settings_client_key"
    ON "app_settings" ("client_id", "key")
  `);

  // Durable billing outbox used by site creation. It must exist before the API
  // accepts a site because the site and its charge intent share a transaction.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "billing_pending_charges" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE CASCADE,
      "sites_added" integer NOT NULL,
      "amount" integer NOT NULL DEFAULT 0,
      "currency" text NOT NULL DEFAULT '',
      "status" text NOT NULL DEFAULT 'pending',
      "stripe_invoice_id" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "charged_at" timestamp
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_pending_charges_site"
    ON "billing_pending_charges" ("site_id")
    WHERE "site_id" IS NOT NULL
  `);
}