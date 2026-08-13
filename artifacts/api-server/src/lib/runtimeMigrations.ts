import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Idempotent runtime migrations for additive schema changes.
 * Safe to run on every boot — uses IF NOT EXISTS guards.
 */
export async function runRuntimeMigrations() {
  try {
    // ---- Session store table (connect-pg-simple) ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
      ) WITH (OIDS=FALSE)
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_sessions_expire" ON "sessions" ("expire")`);

    // ---- Sites table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "sites" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "category_id" integer REFERENCES "categories"("id") ON DELETE SET NULL,
        "name" text NOT NULL,
        "responsible_person" text,
        "address" text,
        "phone" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- Fire safety logbook table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "fire_safety_checks" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "check_type" text NOT NULL,
        "check_date" date NOT NULL,
        "result" text NOT NULL DEFAULT 'pass',
        "location" text,
        "notes" text,
        "performed_by" text,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_fire_safety_client_type_date" ON "fire_safety_checks" ("client_id", "check_type", "check_date")`
    );

    // ---- Food safety (kitchen diary) table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "food_safety_records" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "record_date" date NOT NULL,
        "fridge1_temp" numeric(4, 1),
        "fridge2_temp" numeric(4, 1),
        "fridge3_temp" numeric(4, 1),
        "freezer1_temp" numeric(4, 1),
        "freezer2_temp" numeric(4, 1),
        "hot_holding_temp" numeric(4, 1),
        "probe_cleaned" boolean,
        "notes" text,
        "performed_by" text,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_food_safety_client_date" ON "food_safety_records" ("client_id", "record_date")`
    );
    // NOTE: uniqueness for the diary is now scoped per-site and created by
    // migrateFoodSafetySiteScoping() at the very end of runRuntimeMigrations
    // (two partial unique indexes). The legacy whole-table unique index
    // "UQ_food_safety_client_date" is deliberately no longer created here — that
    // migration drops it — otherwise two sites could not share a record date.

    // ---- Legionella water safety table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "legionella_checks" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
        "check_type" text NOT NULL,
        "check_date" date NOT NULL,
        "result" text NOT NULL DEFAULT 'pass',
        "location" text,
        "temperature_c" numeric(4, 1),
        "notes" text,
        "performed_by" text,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_legionella_client_type_date" ON "legionella_checks" ("client_id", "check_type", "check_date")`
    );

    // ---- SafeTrack tables ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_risk_assessments" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "hazard" text,
        "likelihood" integer,
        "severity" integer,
        "control_measures" text,
        "reviewed_by" text,
        "review_date" date,
        "next_review_date" date,
        "status" text NOT NULL DEFAULT 'active',
        "notes" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_sops" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "category" text,
        "version" text,
        "content" text,
        "reviewed_by" text,
        "review_date" date,
        "next_review_date" date,
        "status" text NOT NULL DEFAULT 'active',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_incidents" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "incident_date" date NOT NULL,
        "incident_type" text,
        "description" text,
        "persons_involved" text,
        "immediate_actions" text,
        "follow_up_actions" text,
        "reported_by" text,
        "status" text NOT NULL DEFAULT 'open',
        "riddor_reportable" boolean DEFAULT false,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "safe_handbook" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "title" text NOT NULL,
        "content" text,
        "version" text,
        "published_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- FixTrack issues table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "fix_track_issues" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "department_id" integer REFERENCES "departments"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "description" text,
        "status" text NOT NULL DEFAULT 'open',
        "priority" text NOT NULL DEFAULT 'medium',
        "category" text,
        "reported_by" text,
        "assigned_to" text,
        "due_date" date,
        "resolved_at" timestamp,
        "resolution_notes" text,
        "media_urls" text[] DEFAULT '{}',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- DocTrack tables ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "doc_track_documents" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "title" text NOT NULL,
        "category" text,
        "version" text,
        "file_path" text,
        "file_name" text,
        "file_size" integer,
        "mime_type" text,
        "description" text,
        "expiry_date" date,
        "reviewed_by" text,
        "review_date" date,
        "next_review_date" date,
        "status" text NOT NULL DEFAULT 'active',
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- Hot tub checks ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "hot_tub_checks" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "check_type" text NOT NULL,
        "check_date" date NOT NULL,
        "result" text NOT NULL DEFAULT 'pass',
        "temperature_c" numeric(4,1),
        "ph_level" numeric(4,2),
        "chlorine_level" numeric(4,2),
        "bromine_level" numeric(4,2),
        "location" text,
        "notes" text,
        "performed_by" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    await migrateLegacyCategories();

    // ---- TrainTrack ----
    await migrateTrainTrack();
    await migrateSafeHandbook();
    await migrateHotTub();
    await migrateHotTubRegistry();
    await migrateTreeTrack();
    await migrateBikeTrack();
    await migrateBikeServices();
    await migrateTwoFactor();
    await migrateStaffRoster();
    await migrateDocAcknowledgements();
    await migrateSignatures();
    await migrateDocDepartment();
    await migratePoolTrack();
    await migrateCheckPhotos();
    await migrateGreenTrack();
    await migrateSwimTrack();
    await migrateSiteDocuments();
    await migrateFixTrackV2();
    await migrateMobileSessions();
    await migrateIncidents();
    await migrateSousVide();
    await migratePATtrack();
    await migratePestTrack();
    await migratePremisesTrack();
    await migrateKitchenCleaning();
    await migrateMaintenanceManager();

    // ---- Push notification tokens (keep this LAST) ----
    // Placed at the very end of the migration function so other agents can add
    // their own migrations above without conflicting with this region.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "push_tokens" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "client_id" integer REFERENCES "clients"("id") ON DELETE CASCADE,
        "token" text NOT NULL,
        "platform" text,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_tokens_token" ON "push_tokens" ("token")`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "IDX_push_tokens_user" ON "push_tokens" ("user_id")`
    );

    // ---- Contractor compliance fields (keep at VERY END) ----
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "gas_safe_number" text`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "public_liability_expiry" timestamp`);
    await db.execute(sql`ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "dbs_check_date" timestamp`);

    // Deduplication log for contractor compliance-expiry reminders. One row per
    // (client, contractor, milestone), where milestone encodes the reminder
    // target it was sent for (e.g. "insurance:2025-03-01" or "dbs:2022-01-01"),
    // so a fresh expiry/renewal date produces a new milestone and re-alerts,
    // while the same milestone is never re-sent.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "contractor_compliance_reminder_log" (
        "id"            serial PRIMARY KEY,
        "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "contractor_id" integer NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "milestone"     text NOT NULL,
        "sent_at"       timestamp NOT NULL DEFAULT now(),
        UNIQUE ("client_id", "contractor_id", "milestone")
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_contractor_compliance_reminder_client"
      ON "contractor_compliance_reminder_log" ("client_id")
    `);

    // Deduplication log for TrainTrack staff-training-expiry reminders. One row
    // per (client, record, milestone), where milestone encodes the expiry date
    // it was sent for (e.g. "expiry:2025-03-01"), so a renewed certificate
    // (new expiry date) produces a new milestone and re-alerts, while the same
    // milestone is never re-sent. Self-contained / IF NOT EXISTS.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "training_expiry_reminder_log" (
        "id"        serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "record_id" integer NOT NULL REFERENCES "train_track_records"("id") ON DELETE CASCADE,
        "milestone" text NOT NULL,
        "sent_at"   timestamp NOT NULL DEFAULT now(),
        UNIQUE ("client_id", "record_id", "milestone")
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_training_expiry_reminder_client"
      ON "training_expiry_reminder_log" ("client_id")
    `);

    await migrateAuditFixes2026_08();
    await migrateOffboardingColumns();
    await migrateDoctrackSafetrackMerge();

    logger.info("Runtime migrations complete");
  } catch (err) {
    logger.error({ err }, "Runtime migrations failed");
    throw err;
  }
}

// ---- 2026-08 audit fixes: schema drift between routes and migrations ----
async function migrateAuditFixes2026_08() {
  // StaffRoster: route reads/writes a single "name" field.
  await db.execute(sql`ALTER TABLE "staff_roster" ADD COLUMN IF NOT EXISTS "name" text NOT NULL DEFAULT ''`);
  // Some databases predate first_name/last_name (or never had them) — guard everything.
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'staff_roster' AND column_name = 'first_name'
      ) THEN
        UPDATE "staff_roster"
        SET "name" = trim(concat_ws(' ', "first_name", "last_name"))
        WHERE "name" = '' AND (coalesce("first_name", '') <> '' OR coalesce("last_name", '') <> '');
        ALTER TABLE "staff_roster" ALTER COLUMN "first_name" DROP NOT NULL;
        ALTER TABLE "staff_roster" ALTER COLUMN "last_name" DROP NOT NULL;
      END IF;
    END $$;
  `);

  // DocTrack: route stores files in object storage under "object_path".
  await db.execute(sql`ALTER TABLE "doc_track_documents" ADD COLUMN IF NOT EXISTS "object_path" text`);

  // TrainTrack: record_type (certificate/signoff/internal) is distinct from training_type,
  // plus every other column the current route reads/writes that older installs may lack.
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "record_type" text NOT NULL DEFAULT 'internal'`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "document_title" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "document_type" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "provider" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "trainer" text`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "completed_date" date`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "expiry_date" date`);
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "notes" text`);

  // KitchenTrack weekly review + probe checks tables (referenced by kitchen-weekly.ts and food-safety.ts).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_weekly_records" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "week_commencing" date NOT NULL,
      "checks" jsonb NOT NULL DEFAULT '[]',
      "deviations" jsonb NOT NULL DEFAULT '[]',
      "additional" jsonb NOT NULL DEFAULT '[]',
      "manager_signature" text,
      "submitted_at" timestamp,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_weekly_client" ON "kitchen_weekly_records" ("client_id")`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_probe_checks" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date" date NOT NULL,
      "probes" jsonb NOT NULL DEFAULT '[]',
      "overall_result" text,
      "checked_by" text,
      "signature" text,
      "notes" text,
      "submitted_at" timestamp,
      "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_probe_client" ON "kitchen_probe_checks" ("client_id")`);
}

async function migrateLegacyCategories() {
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "parent_id" integer REFERENCES "categories"("id") ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "description" text`);
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "responsible_person" text`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "custom_frequency_days" integer`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()`);
  // Module keys selected on the pricing page at signup — pre-ticks post-trial checkout
  await db.execute(sql`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "selected_services" jsonb`);
  // check_records only exists in older installs — skip gracefully if absent
  await db.execute(sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'check_records' AND table_schema = 'public') THEN
        ALTER TABLE "check_records" ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL;
      END IF;
    END $$
  `);
}

// ---- TrainTrack ----
async function migrateTrainTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "train_track_records" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "staff_name" text NOT NULL,
      "training_title" text NOT NULL,
      "training_type" text NOT NULL DEFAULT 'internal',
      "training_date" date NOT NULL,
      "expiry_date" date,
      "provider" text,
      "certificate_ref" text,
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_train_track_client" ON "train_track_records" ("client_id")`);
}

// ---- SafeTrack handbook ----
async function migrateSafeHandbook() {
  await db.execute(sql`ALTER TABLE "safe_handbook" ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL`);
}

// ---- Hot tub registry ----
async function migrateHotTub() {
  await db.execute(sql`ALTER TABLE "hot_tub_checks" ADD COLUMN IF NOT EXISTS "hot_tub_id" integer`);
  await db.execute(sql`ALTER TABLE "hot_tub_checks" ADD COLUMN IF NOT EXISTS "session" text CHECK ("session" IN ('morning', 'midday', 'evening'))`);
}

async function migrateHotTubRegistry() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "hot_tubs" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name" text NOT NULL,
      "model" text,
      "serial_number" text,
      "location" text,
      "capacity_litres" integer,
      "commissioned_date" date,
      "next_service_date" date,
      "notes" text,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_hot_tubs_client" ON "hot_tubs" ("client_id")`);
}

// ---- TreeTrack ----
async function migrateTreeTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "tree_inspections" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "tree_ref" text NOT NULL,
      "species" text,
      "location" text,
      "check_type" text NOT NULL,
      "inspection_date" date NOT NULL,
      "inspector_name" text,
      "condition" text,
      "height_m" numeric(5,1),
      "canopy_spread_m" numeric(5,1),
      "defects_found" boolean DEFAULT false,
      "defect_description" text,
      "recommended_works" text,
      "urgency" text,
      "next_inspection_date" date,
      "result" text NOT NULL DEFAULT 'pass',
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_tree_inspections_client" ON "tree_inspections" ("client_id")`);
}

// ---- BikeTrack ----
async function migrateBikeTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bikes" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name" text NOT NULL,
      "bike_type" text NOT NULL DEFAULT 'standard',
      "serial_number" text,
      "colour" text,
      "size" text,
      "status" text NOT NULL DEFAULT 'available',
      "notes" text,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bikes_client" ON "bikes" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bike_hire_records" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE CASCADE,
      "hirer_name" text NOT NULL,
      "hirer_contact" text,
      "hire_start" timestamp NOT NULL DEFAULT now(),
      "expected_return" timestamp,
      "actual_return" timestamp,
      "pre_check_passed" boolean NOT NULL DEFAULT true,
      "post_check_passed" boolean,
      "hire_fee" numeric(8,2),
      "deposit_taken" numeric(8,2),
      "notes" text,
      "status" text NOT NULL DEFAULT 'active',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bike_hire_client" ON "bike_hire_records" ("client_id")`);
  await db.execute(sql`ALTER TABLE "bike_hire_records" ADD COLUMN IF NOT EXISTS "overdue_notified_at" timestamp`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bike_checks" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE CASCADE,
      "hire_record_id" integer REFERENCES "bike_hire_records"("id") ON DELETE SET NULL,
      "check_type" text NOT NULL DEFAULT 'pre_hire',
      "check_date" timestamp NOT NULL DEFAULT now(),
      "performed_by" text,
      "items_checked" jsonb,
      "result" text NOT NULL DEFAULT 'pass',
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bike_checks_bike" ON "bike_checks" ("bike_id")`);
}

async function migrateBikeServices() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "bike_services" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE CASCADE,
      "service_date" date NOT NULL,
      "service_type" text NOT NULL DEFAULT 'annual',
      "performed_by" text,
      "work_carried_out" text,
      "parts_replaced" text,
      "next_service_date" date,
      "cost" numeric(8,2),
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_bike_services_bike" ON "bike_services" ("bike_id")`);
}

// ---- Two-factor authentication ----
async function migrateTwoFactor() {
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" text`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean NOT NULL DEFAULT false`);
  await db.execute(sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_recovery_hash" text`);
}

// ---- Staff roster ----
async function migrateStaffRoster() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "staff_roster" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "first_name" text NOT NULL,
      "last_name" text NOT NULL,
      "job_title" text,
      "department" text,
      "email" text,
      "phone" text,
      "start_date" date,
      "notes" text,
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_staff_roster_client"
    ON "staff_roster" ("client_id")
  `);
  // requires_acknowledgement flag on documents
  await db.execute(sql`
    ALTER TABLE "doc_track_documents"
    ADD COLUMN IF NOT EXISTS "requires_acknowledgement" boolean NOT NULL DEFAULT false
  `);
}

// ---- Document acknowledgements ----
async function migrateDocAcknowledgements() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "doc_acknowledgements" (
      "id"                   serial PRIMARY KEY,
      "document_id"          integer NOT NULL REFERENCES "doc_track_documents"("id") ON DELETE CASCADE,
      "client_id"            integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "staff_roster_id"      integer REFERENCES "staff_roster"("id") ON DELETE SET NULL,
      "staff_name"           text NOT NULL,
      "signature"            text,
      "acknowledged_at"      timestamp NOT NULL DEFAULT now(),
      "acknowledged_by"      integer REFERENCES "users"("id") ON DELETE SET NULL,
      "train_track_record_id" integer,
      "created_at"           timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_doc_ack_document"
    ON "doc_acknowledgements" ("document_id")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_doc_ack_client"
    ON "doc_acknowledgements" ("client_id")
  `);
}

// ---- Signature columns across SafeTrack + TrainTrack ----
async function migrateSignatures() {
  // TrainTrack records
  await db.execute(sql`ALTER TABLE "train_track_records" ADD COLUMN IF NOT EXISTS "signature" text`);
  // SafeTrack: risk assessments, SOPs, handbook
  await db.execute(sql`ALTER TABLE "safe_risk_assessments" ADD COLUMN IF NOT EXISTS "signature" text`);
  await db.execute(sql`ALTER TABLE "safe_sops" ADD COLUMN IF NOT EXISTS "signature" text`);
  await db.execute(sql`ALTER TABLE "safe_handbook" ADD COLUMN IF NOT EXISTS "signature" text`);
  // File attachments and acknowledgements for SafeTrack documents
  for (const tbl of ["safe_risk_assessments", "safe_sops", "safe_handbook"]) {
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "object_path" text`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "file_name" text`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "file_size" bigint`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "mime_type" text`));
    await db.execute(sql.raw(`ALTER TABLE "${tbl}" ADD COLUMN IF NOT EXISTS "requires_acknowledgement" boolean NOT NULL DEFAULT false`));
  }
  // SafeTrack acknowledgements table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "safe_track_acknowledgements" (
      "id"               serial PRIMARY KEY,
      "client_id"        integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "document_type"    text NOT NULL,
      "document_id"      integer NOT NULL,
      "staff_roster_id"  integer REFERENCES "staff_roster"("id") ON DELETE SET NULL,
      "staff_name"       text NOT NULL,
      "signature"        text,
      "acknowledged_at"  timestamp NOT NULL DEFAULT now(),
      "acknowledged_by"  integer REFERENCES "users"("id") ON DELETE SET NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_safe_track_acks_doc" ON "safe_track_acknowledgements" ("document_type", "document_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_safe_track_acks_client" ON "safe_track_acknowledgements" ("client_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_safe_track_acks_unique" ON "safe_track_acknowledgements" ("document_type", "document_id", "staff_roster_id") WHERE "staff_roster_id" IS NOT NULL`);
}

// ---- Department field on documents + sign-off token on clients ----
async function migrateDocDepartment() {
  // Add department tag to doc_track_documents
  await db.execute(sql`
    ALTER TABLE "doc_track_documents"
    ADD COLUMN IF NOT EXISTS "department" text
  `);

  // Add sign_off_token to clients table
  await db.execute(sql`
    ALTER TABLE "clients"
    ADD COLUMN IF NOT EXISTS "sign_off_token" text
  `);

  // Generate tokens for any clients that don't have one yet
  // Uses md5 of id+random to avoid needing pgcrypto extension
  await db.execute(sql`
    UPDATE "clients"
    SET "sign_off_token" = md5(concat(id::text, '-', random()::text, '-', now()::text))
    WHERE "sign_off_token" IS NULL
  `);

  // Add unique constraint (safe to run multiple times via DO block)
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_clients_sign_off_token'
      ) THEN
        ALTER TABLE "clients" ADD CONSTRAINT "uq_clients_sign_off_token" UNIQUE ("sign_off_token");
      END IF;
    END $$
  `);
}

// ---- Pool Track ----
async function migratePoolTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pool_checks" (
      "id"                 serial PRIMARY KEY,
      "client_id"          integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"            integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date"         date NOT NULL,
      "check_time"         text,
      "check_type"         text NOT NULL DEFAULT 'routine',
      "ph_level"           numeric(4,2),
      "free_chlorine"      numeric(4,2),
      "combined_chlorine"  numeric(4,2),
      "water_temp_c"       numeric(4,1),
      "air_temp_c"         numeric(4,1),
      "turbidity"          text,
      "pool_open"          boolean NOT NULL DEFAULT true,
      "performed_by"       text,
      "actions_taken"      text,
      "result"             text NOT NULL DEFAULT 'pass',
      "notes"              text,
      "created_at"         timestamp NOT NULL DEFAULT now(),
      "updated_at"         timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_pool_checks_client_date"
    ON "pool_checks" ("client_id", "check_date")
  `);
}

// ---- Green Track ----
async function migrateGreenTrack() {
  // Machine fleet register
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_machines" (
      "id"         serial PRIMARY KEY,
      "client_id"  integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"    integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name"       text NOT NULL,
      "type"       text NOT NULL DEFAULT 'other',
      "make"       text,
      "model"      text,
      "serial_no"  text,
      "year"       integer,
      "reg_no"     text,
      "active"     boolean NOT NULL DEFAULT true,
      "notes"      text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_machines_client"
    ON "green_machines" ("client_id")
  `);

  // Daily pre-use operator checks (PUWER Reg 5)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_pre_use_checks" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"      integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "check_date"      date NOT NULL,
      "operator"        text,
      "fluid_levels_ok" boolean,
      "tyres_ok"        boolean,
      "blades_ok"       boolean,
      "guards_ok"       boolean,
      "controls_ok"     boolean,
      "lights_ok"       boolean,
      "cleanliness_ok"  boolean,
      "defect_noted"    boolean NOT NULL DEFAULT false,
      "result"          text NOT NULL DEFAULT 'pass',
      "notes"           text,
      "created_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_pre_use_client_date"
    ON "green_pre_use_checks" ("client_id", "check_date")
  `);

  // Scheduled service records
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_service_records" (
      "id"                 serial PRIMARY KEY,
      "client_id"          integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"         integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "service_date"       date NOT NULL,
      "service_type"       text NOT NULL DEFAULT 'scheduled',
      "hours_at_service"   integer,
      "next_service_hours" integer,
      "next_service_date"  date,
      "work_performed"     text,
      "serviced_by"        text,
      "cost_pence"         integer,
      "notes"              text,
      "created_at"         timestamp NOT NULL DEFAULT now(),
      "updated_at"         timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_service_client_machine"
    ON "green_service_records" ("client_id", "machine_id")
  `);

  // Defect / breakdown reports
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_defects" (
      "id"            serial PRIMARY KEY,
      "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"    integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "report_date"   date NOT NULL,
      "reported_by"   text,
      "description"   text NOT NULL,
      "severity"      text NOT NULL DEFAULT 'minor',
      "out_of_service" boolean NOT NULL DEFAULT false,
      "status"        text NOT NULL DEFAULT 'open',
      "resolution"    text,
      "resolved_date" date,
      "notes"         text,
      "created_at"    timestamp NOT NULL DEFAULT now(),
      "updated_at"    timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_defects_client_status"
    ON "green_defects" ("client_id", "status")
  `);

  // PUWER statutory thorough examinations
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_puwer_inspections" (
      "id"                  serial PRIMARY KEY,
      "client_id"           integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"          integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "inspection_date"     date NOT NULL,
      "next_inspection_date" date,
      "inspection_type"     text NOT NULL DEFAULT 'thorough_examination',
      "inspector_name"      text,
      "inspector_company"   text,
      "cert_ref"            text,
      "safe_to_operate"     boolean NOT NULL DEFAULT true,
      "defects_found"       text,
      "result"              text NOT NULL DEFAULT 'pass',
      "notes"               text,
      "created_at"          timestamp NOT NULL DEFAULT now(),
      "updated_at"          timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_puwer_client_machine"
    ON "green_puwer_inspections" ("client_id", "machine_id")
  `);

  // Fuel & oil usage logs
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "green_fuel_logs" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "machine_id"      integer NOT NULL REFERENCES "green_machines"("id") ON DELETE CASCADE,
      "log_date"        date NOT NULL,
      "fuel_type"       text NOT NULL DEFAULT 'diesel',
      "quantity_litres" numeric(6,2),
      "engine_hours"    integer,
      "cost_pence"      integer,
      "filled_by"       text,
      "notes"           text,
      "created_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_green_fuel_client_machine"
    ON "green_fuel_logs" ("client_id", "machine_id")
  `);
}

// ---- SwimTrack ----
async function migrateSwimTrack() {
  // Pool session log
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_sessions" (
      "id"                  serial PRIMARY KEY,
      "client_id"           integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"             integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "session_date"        date NOT NULL,
      "session_type"        text NOT NULL DEFAULT 'public_swim',
      "lifeguard_name"      text,
      "open_time"           time,
      "close_time"          time,
      "max_bathers"         integer,
      "bather_count_peak"   integer,
      "pre_session_result"  text NOT NULL DEFAULT 'pass',
      "pre_session_notes"   text,
      "pool_closed"         boolean NOT NULL DEFAULT false,
      "closure_reason"      text,
      "notes"               text,
      "result"              text NOT NULL DEFAULT 'pass',
      "created_at"          timestamp NOT NULL DEFAULT now(),
      "updated_at"          timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_sessions_client_date"
    ON "swim_sessions" ("client_id", "session_date")
  `);

  // Periodic lifeguard surveillance checks (every 15-20 min during session)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_surveillance_checks" (
      "id"            serial PRIMARY KEY,
      "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "session_id"    integer REFERENCES "swim_sessions"("id") ON DELETE SET NULL,
      "site_id"       integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date"    date NOT NULL,
      "check_time"    time,
      "bather_count"  integer,
      "scan_completed" boolean NOT NULL DEFAULT true,
      "observations"  text,
      "checked_by"    text,
      "result"        text NOT NULL DEFAULT 'pass',
      "created_at"    timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_surveillance_client_date"
    ON "swim_surveillance_checks" ("client_id", "check_date")
  `);

  // First-aid and rescue equipment readiness checks
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_first_aid_checks" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"         integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "check_date"      date NOT NULL,
      "aed_ok"          boolean NOT NULL DEFAULT true,
      "first_aid_kit_ok" boolean NOT NULL DEFAULT true,
      "rescue_pole_ok"  boolean NOT NULL DEFAULT true,
      "throw_bag_ok"    boolean NOT NULL DEFAULT true,
      "spine_board_ok"  boolean NOT NULL DEFAULT true,
      "ring_buoy_ok"    boolean NOT NULL DEFAULT true,
      "oxygen_kit_ok"   boolean NOT NULL DEFAULT true,
      "checked_by"      text,
      "defects_found"   text,
      "notes"           text,
      "result"          text NOT NULL DEFAULT 'pass',
      "created_at"      timestamp NOT NULL DEFAULT now(),
      "updated_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_first_aid_client_date"
    ON "swim_first_aid_checks" ("client_id", "check_date")
  `);

  // Incident and near-miss log
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swim_incidents" (
      "id"                serial PRIMARY KEY,
      "client_id"         integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"           integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "incident_date"     date NOT NULL,
      "incident_time"     time,
      "incident_type"     text NOT NULL DEFAULT 'near_miss',
      "severity"          text NOT NULL DEFAULT 'low',
      "persons_involved"  text,
      "description"       text NOT NULL,
      "action_taken"      text,
      "reported_to"       text,
      "reported_date"     date,
      "outcome"           text,
      "notes"             text,
      "created_at"        timestamp NOT NULL DEFAULT now(),
      "updated_at"        timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_swim_incidents_client_date"
    ON "swim_incidents" ("client_id", "incident_date")
  `);
}

// ---- Check photos & photo requirements ----
async function migrateCheckPhotos() {
  // Generic photo attachments for any check/record type
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "check_photos" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "entity_type" text NOT NULL,
      "entity_id"   integer NOT NULL,
      "object_path" text NOT NULL,
      "caption"     text,
      "created_by"  integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"  timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_check_photos_entity"
    ON "check_photos" ("client_id", "entity_type", "entity_id")
  `);

  // Manager-configurable photo requirements per entity type
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "photo_requirements" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "entity_type" text NOT NULL,
      "required"    boolean NOT NULL DEFAULT false,
      "min_photos"  integer NOT NULL DEFAULT 1,
      "created_at"  timestamp NOT NULL DEFAULT now(),
      "updated_at"  timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "entity_type")
    )
  `);

  // Manager-customisable checklist templates (per client + optional site + checklist type)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "checklist_templates" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"         integer REFERENCES "sites"("id") ON DELETE CASCADE,
      "checklist_type"  text NOT NULL,
      "items"           jsonb NOT NULL DEFAULT '[]',
      "updated_by"      integer REFERENCES "users"("id") ON DELETE SET NULL,
      "updated_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  // Partial unique indexes to handle nullable site_id correctly
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_checklist_templates_client_type"
    ON "checklist_templates" ("client_id", "checklist_type")
    WHERE "site_id" IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_checklist_templates_client_site_type"
    ON "checklist_templates" ("client_id", "site_id", "checklist_type")
    WHERE "site_id" IS NOT NULL
  `);

  // Business type on clients (for segmentation and onboarding personalisation)
  await db.execute(sql`
    ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "business_type" text
  `);

  // Deduplication log for daily check-reminder emails (one digest per client per day)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "doc_ack_reminder_log" (
      "id" serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "sent_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_doc_ack_reminder_client" ON "doc_ack_reminder_log" ("client_id")
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "check_reminder_log" (
      "id"         serial PRIMARY KEY,
      "client_id"  integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "log_date"   date NOT NULL DEFAULT CURRENT_DATE,
      "sent_at"    timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "log_date")
    )
  `);
}

// ---- FixTrack v2: contractor trades, contractorId on issues, action tokens ----
async function migrateFixTrackV2() {
  // Contractor trade specialisms (JSONB array matching fix-track issue types)
  await db.execute(sql`
    ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "trades" jsonb NOT NULL DEFAULT '[]'
  `);

  // Link a contractor directly to a maintenance issue
  await db.execute(sql`
    ALTER TABLE "fix_track_issues"
      ADD COLUMN IF NOT EXISTS "contractor_id" integer
        REFERENCES "contractors"("id") ON DELETE SET NULL
  `);

  // Pending contractor-email approval requests (manager approval workflow)
  await db.execute(sql`
    ALTER TABLE "fix_track_issues"
      ADD COLUMN IF NOT EXISTS "email_request_mode" text,
      ADD COLUMN IF NOT EXISTS "email_requested_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS "email_requested_at" timestamp
  `);

  // One-time action tokens for contractor email buttons (Booked / Completed)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fix_track_action_tokens" (
      "id"                     serial PRIMARY KEY,
      "token"                  text NOT NULL UNIQUE,
      "issue_id"               integer NOT NULL REFERENCES "fix_track_issues"("id") ON DELETE CASCADE,
      "client_id"              integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "contractor_id"          integer REFERENCES "contractors"("id") ON DELETE SET NULL,
      "action"                 text NOT NULL,
      "expires_at"             timestamp NOT NULL,
      "used_at"                timestamp,
      "completion_notes"       text,
      "completion_object_path" text,
      "created_at"             timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_fix_track_action_tokens_token"
    ON "fix_track_action_tokens" ("token")
  `);

  // Completion document path stored on the issue so managers can download it
  await db.execute(sql`
    ALTER TABLE "fix_track_issues"
      ADD COLUMN IF NOT EXISTS "completion_document_path" text
  `);

  // Deduplication log for the daily overdue-issue alert digest
  // (one email per client per day).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fix_track_alert_log" (
      "id"        serial PRIMARY KEY,
      "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "log_date"  date NOT NULL DEFAULT CURRENT_DATE,
      "sent_at"   timestamp NOT NULL DEFAULT now(),
      UNIQUE ("client_id", "log_date")
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_fix_track_alert_log_client" ON "fix_track_alert_log" ("client_id")
  `);
}

// ---- Site documents ----
async function migrateSiteDocuments() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "site_documents" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"     integer NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE,
      "name"        text NOT NULL,
      "object_path" text NOT NULL,
      "uploaded_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"  timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_site_documents_site"
    ON "site_documents" ("client_id", "site_id")
  `);
}

async function migrateIncidents() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "incidents" (
      "id"                       serial PRIMARY KEY,
      "client_id"                integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"                  integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "incident_type"            text NOT NULL DEFAULT 'accident',
      "severity"                 text NOT NULL DEFAULT 'minor',
      "status"                   text NOT NULL DEFAULT 'open',
      "incident_date"            date NOT NULL,
      "incident_time"            text,
      "location"                 text NOT NULL,
      "description"              text NOT NULL,
      "involved_name"            text NOT NULL,
      "involved_job_title"       text,
      "involved_employment_type" text DEFAULT 'employee',
      "injuries_sustained"       text,
      "first_aid_given"          boolean NOT NULL DEFAULT false,
      "first_aider_name"         text,
      "witnesses"                text,
      "riddor_reportable"        boolean NOT NULL DEFAULT false,
      "reported_to_hse"          boolean NOT NULL DEFAULT false,
      "hse_reference"            text,
      "hse_report_date"          date,
      "immediate_actions"        text,
      "corrective_actions"       text,
      "reported_by"              text NOT NULL,
      "created_by"               integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"               timestamp NOT NULL DEFAULT now(),
      "updated_at"               timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_incidents_client" ON "incidents" ("client_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_incidents_date" ON "incidents" ("client_id", "incident_date" DESC)`);
}

async function migrateSousVide() {
  await db.execute(sql`
    ALTER TABLE food_safety_records ADD COLUMN IF NOT EXISTS sous_vide jsonb NOT NULL DEFAULT '[]'
  `);
  await db.execute(sql`ALTER TABLE food_safety_records ADD COLUMN IF NOT EXISTS cooling jsonb NOT NULL DEFAULT '[]'`);
  await db.execute(sql`ALTER TABLE food_safety_records ADD COLUMN IF NOT EXISTS reheating jsonb NOT NULL DEFAULT '[]'
  `);
}

async function migratePATtrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_appliances" (
      "id"              serial PRIMARY KEY,
      "client_id"       integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"         integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "name"            text NOT NULL,
      "appliance_type"  text NOT NULL DEFAULT 'Other',
      "location"        text,
      "asset_tag"       text,
      "description"     text,
      "active"          boolean NOT NULL DEFAULT true,
      "created_at"      timestamp NOT NULL DEFAULT now(),
      "updated_at"      timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_appliances_client" ON "pat_appliances" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pat_tests" (
      "id"                    serial PRIMARY KEY,
      "client_id"             integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "appliance_id"          integer NOT NULL REFERENCES "pat_appliances"("id") ON DELETE CASCADE,
      "test_date"             date NOT NULL,
      "result"                text NOT NULL DEFAULT 'pass',
      "next_test_date"        date,
      "tested_by"             text,
      "visual_inspection"     text DEFAULT 'pass',
      "earth_continuity_ohms" text,
      "insulation_mohms"      text,
      "operating_current"     text,
      "notes"                 text,
      "created_by"            integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"            timestamp NOT NULL DEFAULT now(),
      "updated_at"            timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_tests_client" ON "pat_tests" ("client_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pat_tests_appliance" ON "pat_tests" ("appliance_id")`);
}

async function migratePestTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pest_visits" (
      "id"                  serial PRIMARY KEY,
      "client_id"           integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"             integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "visit_date"          date NOT NULL,
      "contractor_name"     text,
      "contractor_company"  text,
      "areas_inspected"     text,
      "findings"            text,
      "treatments_applied"  text,
      "recommendations"     text,
      "next_visit_date"     date,
      "signed_off_by"       text,
      "notes"               text,
      "created_by"          integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"          timestamp NOT NULL DEFAULT now(),
      "updated_at"          timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pest_visits_client" ON "pest_visits" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "pest_activity" (
      "id"            serial PRIMARY KEY,
      "client_id"     integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"       integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "recorded_date" date NOT NULL,
      "pest_type"     text NOT NULL DEFAULT 'rodent',
      "evidence_type" text NOT NULL DEFAULT 'live_sighting',
      "location"      text,
      "severity"      text NOT NULL DEFAULT 'low',
      "action_taken"  text,
      "recorded_by"   text,
      "resolved"      boolean NOT NULL DEFAULT false,
      "resolved_at"   timestamp,
      "notes"         text,
      "created_by"    integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"    timestamp NOT NULL DEFAULT now(),
      "updated_at"    timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_pest_activity_client" ON "pest_activity" ("client_id")`);
}

async function migratePremisesTrack() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "premises_inspections" (
      "id"               serial PRIMARY KEY,
      "client_id"        integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"          integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "inspection_date"  date NOT NULL,
      "inspection_type"  text NOT NULL DEFAULT 'routine',
      "area"             text,
      "findings"         text,
      "hazard_details"   text,
      "action_required"  text,
      "action_taken"     text,
      "status"           text NOT NULL DEFAULT 'open',
      "inspected_by"     text,
      "created_by"       integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"       timestamp NOT NULL DEFAULT now(),
      "updated_at"       timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_premises_inspections_client" ON "premises_inspections" ("client_id", "inspection_date")`);
}

async function migrateKitchenCleaning() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_cleaning_tasks" (
      "id"          serial PRIMARY KEY,
      "client_id"   integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"     integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "area"        text NOT NULL DEFAULT '',
      "task"        text NOT NULL DEFAULT '',
      "frequency"   text NOT NULL DEFAULT 'daily',
      "method"      text,
      "product"     text,
      "responsible" text,
      "sort_order"  integer NOT NULL DEFAULT 0,
      "active"      boolean NOT NULL DEFAULT true,
      "created_at"  timestamp NOT NULL DEFAULT now(),
      "updated_at"  timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_cleaning_tasks_client" ON "kitchen_cleaning_tasks" ("client_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "kitchen_cleaning_logs" (
      "id"           serial PRIMARY KEY,
      "client_id"    integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
      "site_id"      integer REFERENCES "sites"("id") ON DELETE SET NULL,
      "log_date"     date NOT NULL,
      "frequency"    text NOT NULL DEFAULT 'daily',
      "completions"  jsonb NOT NULL DEFAULT '[]',
      "signed_by"    text,
      "submitted_at" timestamp,
      "created_by"   integer REFERENCES "users"("id") ON DELETE SET NULL,
      "created_at"   timestamp NOT NULL DEFAULT now(),
      "updated_at"   timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_kitchen_cleaning_logs_client" ON "kitchen_cleaning_logs" ("client_id")`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_kitchen_cleaning_logs_unique"
    ON "kitchen_cleaning_logs" ("client_id", "log_date", "frequency")
  `);
}

async function migrateMaintenanceManager() {
  await db.execute(sql`
    ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "is_maintenance_manager" boolean NOT NULL DEFAULT false
  `);
}

async function migrateMobileSessions() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "mobile_sessions" (
      "id"         serial PRIMARY KEY,
      "user_id"    integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "token"      text    NOT NULL,
      "expires_at" timestamp NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_mobile_sessions_token"
    ON "mobile_sessions" ("token")
  `);
}

// Adds optional per-site scoping to the kitchen diary and reworks the
// uniqueness so that the same (client, date) can exist once per site plus once
// for the whole organisation (site_id IS NULL). Because Postgres treats NULLs
// as distinct, a single unique index over (client_id, record_date, site_id)
// would NOT prevent two whole-org rows for the same day; so we use two partial
// unique indexes instead.
async function migrateFoodSafetySiteScoping() {
  // 1. Nullable site_id column (whole-org diary keeps site_id NULL).
  await db.execute(sql`
    ALTER TABLE "food_safety_records"
      ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_food_safety_client_site_date"
    ON "food_safety_records" ("client_id", "site_id", "record_date")
  `);

  // 2. Retire the old (client_id, record_date) uniqueness. The live DB may hold
  //    it as either a unique CONSTRAINT or a bare unique INDEX (migration text
  //    has historically drifted), and the name may vary — resolve the real
  //    names from the catalog before dropping.
  const constraintRows = await db.execute(sql`
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'food_safety_records'::regclass
      AND c.contype = 'u'
      AND c.conkey = (
        SELECT array_agg(a.attnum ORDER BY a.attnum)
        FROM pg_attribute a
        WHERE a.attrelid = 'food_safety_records'::regclass
          AND a.attname IN ('client_id', 'record_date')
      )
  `);
  for (const row of (constraintRows.rows ?? []) as Array<{ conname: string }>) {
    await db.execute(sql`ALTER TABLE "food_safety_records" DROP CONSTRAINT IF EXISTS ${sql.raw(`"${row.conname}"`)}`);
  }
  // Any remaining plain unique index over exactly (client_id, record_date)
  // that is NOT partial (no WHERE clause) is the legacy whole-table unique.
  // Match at the catalog level: exactly two key columns, no expression keys,
  // and the key attnums are precisely {client_id, record_date} — so wider
  // indexes like (client_id, record_date, created_by) are never touched.
  const indexRows = await db.execute(sql`
    SELECT i.relname AS indexname
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = 'food_safety_records'::regclass
      AND x.indisunique
      AND x.indpred IS NULL
      AND x.indexprs IS NULL
      AND x.indnkeyatts = 2
      AND 0 <> ALL (x.indkey::int2[])
      AND (
        SELECT array_agg(k ORDER BY k)
        FROM unnest(x.indkey::int2[]) AS k
      ) = (
        SELECT array_agg(a.attnum ORDER BY a.attnum)
        FROM pg_attribute a
        WHERE a.attrelid = 'food_safety_records'::regclass
          AND a.attname IN ('client_id', 'record_date')
      )
  `);
  for (const row of (indexRows.rows ?? []) as Array<{ indexname: string }>) {
    await db.execute(sql`DROP INDEX IF EXISTS ${sql.raw(`"${row.indexname}"`)}`);
  }
  // Belt-and-braces: drop the known historical name too.
  await db.execute(sql`DROP INDEX IF EXISTS "UQ_food_safety_client_date"`);

  // 3. Two partial unique indexes replacing the old single one.
  //    - whole-org diary: one row per (client, date) when site_id IS NULL
  //    - per-site diary:  one row per (client, site, date) when site_id NOT NULL
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_food_safety_client_date_nosite"
    ON "food_safety_records" ("client_id", "record_date")
    WHERE "site_id" IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "UQ_food_safety_client_site_date"
    ON "food_safety_records" ("client_id", "site_id", "record_date")
    WHERE "site_id" IS NOT NULL
  `);
}

async function migrateOffboardingColumns() {
  await db.execute(sql`
    ALTER TABLE "clients"
      ADD COLUMN IF NOT EXISTS "cancelled_at"               timestamptz,
      ADD COLUMN IF NOT EXISTS "offboarding_email_sent_at"  timestamptz,
      ADD COLUMN IF NOT EXISTS "data_deletion_scheduled_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "data_deleted_at"            timestamptz
  `);
}

// ---- SafeTrack → DocTrack data migration ----
// Copies existing safe_risk_assessments, safe_sops, and safe_handbook rows into
// doc_track_documents (which already has the matching categories).  Uses a
// migrated_doc_id tracking column on each source table so the migration is
// fully idempotent and can be re-run safely.
async function migrateDoctrackSafetrackMerge() {
  // 1. Add tracking columns to source tables.
  await db.execute(sql`ALTER TABLE safe_risk_assessments ADD COLUMN IF NOT EXISTS migrated_doc_id integer`);
  await db.execute(sql`ALTER TABLE safe_sops            ADD COLUMN IF NOT EXISTS migrated_doc_id integer`);
  await db.execute(sql`ALTER TABLE safe_handbook        ADD COLUMN IF NOT EXISTS migrated_doc_id integer`);

  // 2. Migrate risk assessments.
  {
    const rows = await db.execute(sql`SELECT * FROM safe_risk_assessments WHERE migrated_doc_id IS NULL`);
    for (const ra of (rows.rows ?? []) as any[]) {
      const desc = [
        ra.hazard           ? `Hazard: ${ra.hazard}` : null,
        ra.likelihood       ? `Likelihood: ${ra.likelihood}` : null,
        ra.severity         ? `Severity: ${ra.severity}` : null,
        ra.control_measures ? `Control measures: ${ra.control_measures}` : null,
        ra.notes            || null,
      ].filter(Boolean).join("\n") || null;

      const ins = await db.execute(sql`
        INSERT INTO doc_track_documents
          (client_id, site_id, title, category, description,
           object_path, file_name, file_size, mime_type,
           requires_acknowledgement, reviewed_by, review_date,
           next_review_date, status, created_at, updated_at)
        VALUES
          (${ra.client_id}, ${ra.site_id}, ${ra.title ?? "Untitled"}, 'risk_assessment', ${desc},
           ${ra.object_path ?? null}, ${ra.file_name ?? null}, ${ra.file_size ?? null}, ${ra.mime_type ?? null},
           ${ra.requires_acknowledgement ?? false}, ${ra.reviewed_by ?? null}, ${ra.review_date ?? null},
           ${ra.next_review_date ?? null}, ${ra.status ?? "active"}, ${ra.created_at ?? sql`now()`}, ${ra.updated_at ?? sql`now()`})
        RETURNING id
      `);
      const newId = ((ins.rows ?? [])[0] as any)?.id;
      if (newId) {
        await db.execute(sql`UPDATE safe_risk_assessments SET migrated_doc_id = ${newId} WHERE id = ${ra.id}`);
      }
    }
  }

  // 3. Migrate SOPs.
  {
    const rows = await db.execute(sql`SELECT * FROM safe_sops WHERE migrated_doc_id IS NULL`);
    for (const sop of (rows.rows ?? []) as any[]) {
      const desc = [sop.content || null, sop.notes || null].filter(Boolean).join("\n") || null;
      const ins = await db.execute(sql`
        INSERT INTO doc_track_documents
          (client_id, site_id, title, category, description,
           object_path, file_name, file_size, mime_type,
           requires_acknowledgement, reviewed_by, review_date,
           next_review_date, status, created_at, updated_at)
        VALUES
          (${sop.client_id}, ${sop.site_id ?? null}, ${sop.title ?? "Untitled"}, 'sop', ${desc},
           ${sop.object_path ?? null}, ${sop.file_name ?? null}, ${sop.file_size ?? null}, ${sop.mime_type ?? null},
           ${sop.requires_acknowledgement ?? false}, ${sop.reviewed_by ?? null}, ${sop.review_date ?? null},
           ${sop.next_review_date ?? null}, ${sop.status ?? "active"}, ${sop.created_at ?? sql`now()`}, ${sop.updated_at ?? sql`now()`})
        RETURNING id
      `);
      const newId = ((ins.rows ?? [])[0] as any)?.id;
      if (newId) {
        await db.execute(sql`UPDATE safe_sops SET migrated_doc_id = ${newId} WHERE id = ${sop.id}`);
      }
    }
  }

  // 4. Migrate handbook entries.
  {
    const rows = await db.execute(sql`SELECT * FROM safe_handbook WHERE migrated_doc_id IS NULL`);
    for (const hb of (rows.rows ?? []) as any[]) {
      const desc = [hb.content || null, hb.notes || null].filter(Boolean).join("\n") || null;
      const ins = await db.execute(sql`
        INSERT INTO doc_track_documents
          (client_id, site_id, title, category, description,
           object_path, file_name, file_size, mime_type,
           requires_acknowledgement, reviewed_by, review_date,
           next_review_date, status, created_at, updated_at)
        VALUES
          (${hb.client_id}, ${hb.site_id ?? null}, ${hb.title ?? "Untitled"}, 'handbook', ${desc},
           ${hb.object_path ?? null}, ${hb.file_name ?? null}, ${hb.file_size ?? null}, ${hb.mime_type ?? null},
           ${hb.requires_acknowledgement ?? false}, ${hb.reviewed_by ?? null}, ${hb.review_date ?? null},
           ${hb.next_review_date ?? null}, ${hb.status ?? "active"}, ${hb.created_at ?? sql`now()`}, ${hb.updated_at ?? sql`now()`})
        RETURNING id
      `);
      const newId = ((ins.rows ?? [])[0] as any)?.id;
      if (newId) {
        await db.execute(sql`UPDATE safe_handbook SET migrated_doc_id = ${newId} WHERE id = ${hb.id}`);
      }
    }
  }

  // 5. Migrate acknowledgements — only for rows whose source doc was already migrated.
  {
    const acks = await db.execute(sql`
      SELECT a.*,
        COALESCE(r.migrated_doc_id, s.migrated_doc_id, h.migrated_doc_id) AS new_doc_id
      FROM safe_track_acknowledgements a
      LEFT JOIN safe_risk_assessments r ON a.document_type = 'risk_assessment' AND a.document_id = r.id
      LEFT JOIN safe_sops             s ON a.document_type = 'sop'             AND a.document_id = s.id
      LEFT JOIN safe_handbook         h ON a.document_type = 'handbook'        AND a.document_id = h.id
      WHERE COALESCE(r.migrated_doc_id, s.migrated_doc_id, h.migrated_doc_id) IS NOT NULL
    `);
    for (const ack of (acks.rows ?? []) as any[]) {
      if (!ack.new_doc_id) continue;
      await db.execute(sql`
        INSERT INTO doc_acknowledgements
          (document_id, client_id, staff_roster_id, staff_name, signature, acknowledged_at, acknowledged_by)
        VALUES
          (${ack.new_doc_id}, ${ack.client_id}, ${ack.staff_roster_id ?? null},
           ${ack.staff_name}, ${ack.signature ?? null}, ${ack.acknowledged_at}, ${ack.acknowledged_by ?? null})
        ON CONFLICT DO NOTHING
      `);
    }
  }
}
