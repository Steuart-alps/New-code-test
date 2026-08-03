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

    logger.info("Runtime migrations complete");
  } catch (err) {
    logger.error({ err }, "Runtime migrations failed");
    throw err;
  }
}

async function migrateLegacyCategories() {
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "parent_id" integer REFERENCES "categories"("id") ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "description" text`);
  await db.execute(sql`ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "responsible_person" text`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "custom_frequency_days" integer`);
  await db.execute(sql`ALTER TABLE "compliance_items" ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now()`);
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

  // Deduplication log for daily check-reminder emails (one digest per client per day)
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
