// Older database shapes for the upgrade-path suite (tests/upgrade-fixtures.mjs).
// Runs only inside the disposable fresh-schema database, before the runtime
// migrations, so the migrations meet these tables the way an older install had
// them. Never point this at a live or development database.
//
// The table text is copied from the September 2026 code (commit d0b0b8d, the
// first import of the Replit project), not generated from the current schema:
//
// - "replit-runtime": module tables created by that era's runtime CREATE TABLE
//   text, before Drizzle managed them. BikeTrack's first column names, the
//   Legionella and hot tub temperature_c readings, the original fixed-column
//   kitchen diary (no site_id) with its whole-table (client, date) unique
//   constraint, and bike_services with performed_by and cost in pounds.
// - "replit-push": the same tables as drizzle-kit push built them from that
//   commit's lib/db schema (bike_services has no Drizzle table, so it keeps the
//   runtime text). The diary already has site_id and JSON sections but still
//   has the old whole-table unique index "UQ_food_safety_client_date".
//
// Core tables (clients, users, sites...) come from the current runtime
// baseline: their drift is covered by test:schema:parity, not here.
import { pool } from "@workspace/db";
import { ensureRuntimeBaseline } from "../../src/lib/runtimeBaseline";

export const UPGRADE_SHAPES = ["replit-runtime", "replit-push"] as const;
export type UpgradeShape = (typeof UPGRADE_SHAPES)[number];

export function upgradeShapeFromEnv(): UpgradeShape | null {
  const value = process.env.FRESH_SCHEMA_UPGRADE_FIXTURE;
  if (!value) return null;
  if (!(UPGRADE_SHAPES as readonly string[]).includes(value)) {
    throw new Error(`Unknown FRESH_SCHEMA_UPGRADE_FIXTURE: ${value}`);
  }
  return value as UpgradeShape;
}

// Two businesses: 101 is the one the suite signs in to; 202 must never see or
// change 101's records (and vice versa).
const TENANTS = `
  INSERT INTO clients (id, name, slug) VALUES
    (101, 'Legacy Lodge', 'legacy-lodge-upgrade-fixture'),
    (202, 'Other Business', 'other-business-upgrade-fixture');
  INSERT INTO sites (id, client_id, name) VALUES
    (1101, 101, 'Main house'), (1102, 101, 'Boathouse'), (2201, 202, 'Elsewhere');
  SELECT setval(pg_get_serial_sequence('clients', 'id'), 1000);
  SELECT setval(pg_get_serial_sequence('sites', 'id'), 5000);
`;

// bike_services has never had a Drizzle table: both shapes got this text.
function BIKE_SERVICES_RUNTIME() {
  return `
  CREATE TABLE "bike_services" (
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
  );`;
}
const BIKE_SERVICE_ROWS = `
  INSERT INTO bike_services (id, client_id, bike_id, service_date, service_type, performed_by, work_carried_out, parts_replaced, next_service_date, cost, notes) VALUES
    (1, 101, 1, '2026-08-01', 'annual', 'Cycle Fix Ltd', 'Full service', 'Chain', '2027-08-01', 45.50, 'Invoice 17'),
    (2, 101, 2, '2026-08-15', 'interim', NULL, NULL, NULL, NULL, NULL, NULL),
    (3, 202, 3, '2026-08-01', 'annual', 'Other mechanic', NULL, NULL, NULL, 12.00, NULL);
`;

const REPLIT_RUNTIME = `
  CREATE TABLE "legionella_checks" (
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
  );
  CREATE TABLE "hot_tub_checks" (
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
  );
  -- The first diary: one fixed reading per appliance per day, no site_id, and
  -- one diary per business per date enforced by a table constraint.
  CREATE TABLE "food_safety_records" (
    "id" serial PRIMARY KEY,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
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
    "updated_at" timestamp NOT NULL DEFAULT now(),
    UNIQUE ("client_id", "record_date")
  );
  CREATE TABLE "bikes" (
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
  );
  CREATE TABLE "bike_hire_records" (
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
  );
  CREATE TABLE "bike_checks" (
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
  );
  ${BIKE_SERVICES_RUNTIME()}

  INSERT INTO legionella_checks (id, client_id, site_id, check_type, check_date, result, location, temperature_c, notes, performed_by) VALUES
    (1, 101, 1101, 'hot_sentinel_temp', '2026-09-01', 'pass', 'Kitchen sink', 55.5, 'Old reading', 'Alex'),
    (2, 101, 1102, 'cold_tank_temp', '2026-09-02', 'fail', 'Boathouse tap', 21.4, NULL, 'Sam'),
    (3, 101, NULL, 'shower_clean', '2026-09-03', 'pass', NULL, NULL, 'No reading taken', NULL),
    (4, 202, 2201, 'hot_sentinel_temp', '2026-09-01', 'pass', 'Other sink', 60.0, NULL, NULL);
  INSERT INTO hot_tub_checks (id, client_id, site_id, check_type, check_date, result, temperature_c, ph_level, chlorine_level, bromine_level, location, notes, performed_by) VALUES
    (1, 101, 1101, 'water_chemistry', '2026-09-01', 'pass', 38.5, 7.40, 3.20, NULL, 'Garden tub', NULL, 'Alex'),
    (2, 101, 1101, 'water_chemistry', '2026-09-02', 'pass', 37.0, 7.60, NULL, 4.50, 'Garden tub', 'Bromine tub', 'Sam'),
    (3, 202, 2201, 'water_chemistry', '2026-09-01', 'pass', 39.0, 7.20, 2.00, NULL, NULL, NULL, NULL);
  INSERT INTO food_safety_records (id, client_id, record_date, fridge1_temp, fridge2_temp, fridge3_temp, freezer1_temp, freezer2_temp, hot_holding_temp, probe_cleaned, notes, performed_by) VALUES
    (1, 101, '2026-09-01', 3.5, 4.0, NULL, -18.0, NULL, 65.0, true, 'Delivery late', 'Chef Jo'),
    (2, 101, '2026-09-02', 2.5, NULL, NULL, NULL, NULL, NULL, false, NULL, 'Chef Jo'),
    (3, 202, '2026-09-01', 5.0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO bikes (id, client_id, site_id, name, bike_type, serial_number, colour, size, status, notes) VALUES
    (1, 101, 1101, 'Blue Raleigh', 'standard', 'SN-001', 'Blue', 'M', 'hired', 'Basket fitted'),
    (2, 101, 1102, 'Kids bike', 'kids', NULL, 'Red', 'S', 'available', NULL),
    (3, 202, 2201, 'Other bike', 'standard', NULL, NULL, NULL, 'available', NULL);
  INSERT INTO bike_hire_records (id, client_id, bike_id, hirer_name, hirer_contact, hire_start, expected_return, actual_return, pre_check_passed, post_check_passed, hire_fee, deposit_taken, notes, status) VALUES
    (1, 101, 1, 'Pat Guest', '07700 900001', '2026-09-01 09:15', '2026-09-03 17:00', NULL, true, NULL, 25.00, 50.00, 'Room 4', 'active'),
    (2, 101, 2, 'Lee Visitor', NULL, '2026-08-20 10:00', '2026-08-20 16:00', '2026-08-20 15:30', true, true, 10.00, NULL, NULL, 'returned'),
    (3, 202, 3, 'Other hirer', NULL, '2026-09-01 08:00', NULL, NULL, true, NULL, NULL, NULL, NULL, 'active');
  INSERT INTO bike_checks (id, client_id, bike_id, hire_record_id, check_type, check_date, performed_by, items_checked, result, notes) VALUES
    (1, 101, 1, 1, 'pre_hire', '2026-09-01 09:00', 'Alex', '{"brakes": "pass", "tyres": "pass"}', 'pass', NULL),
    (2, 101, 2, 2, 'post_return', '2026-08-20 15:35', 'Sam', '{"brakes": "fail"}', 'fail', 'Rear brake worn'),
    (3, 202, 3, NULL, 'routine', '2026-09-01 08:00', NULL, NULL, 'pass', NULL);
  ${BIKE_SERVICE_ROWS}
  SELECT setval(pg_get_serial_sequence(t, 'id'), 1000) FROM unnest(ARRAY[
    'legionella_checks', 'hot_tub_checks', 'food_safety_records', 'bikes',
    'bike_hire_records', 'bike_checks', 'bike_services']) AS t;
`;

const REPLIT_PUSH = `
  CREATE TABLE "legionella_checks" (
    "id" serial PRIMARY KEY NOT NULL,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
    "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
    "check_type" text NOT NULL,
    "check_date" date NOT NULL,
    "result" text DEFAULT 'pass' NOT NULL,
    "temperature" numeric(5, 2),
    "location" text,
    "notes" text,
    "performed_by" text,
    "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE "hot_tubs" (
    "id" serial PRIMARY KEY NOT NULL,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
    "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
    "name" text NOT NULL,
    "description" text,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE "hot_tub_checks" (
    "id" serial PRIMARY KEY NOT NULL,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
    "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
    "check_type" text NOT NULL,
    "check_date" date NOT NULL,
    "result" text DEFAULT 'pass' NOT NULL,
    "ph_value" numeric(4, 2),
    "sanitiser_level" numeric(6, 2),
    "temperature" numeric(5, 2),
    "hot_tub_id" integer REFERENCES "hot_tubs"("id") ON DELETE SET NULL,
    "session" text,
    "location" text,
    "performed_by" text,
    "notes" text,
    "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE "food_safety_records" (
    "id" serial PRIMARY KEY NOT NULL,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
    "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
    "record_date" date NOT NULL,
    "deliveries" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "cold_food" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "hot_temperature" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "cooling" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "reheating" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "hot_holding" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "sous_vide" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "cooking_limit" text DEFAULT 'Above 75°C (10 seconds)' NOT NULL,
    "cooling_limit" text DEFAULT '8°C within 90 minutes' NOT NULL,
    "reheating_limit" text DEFAULT 'Above 82°C' NOT NULL,
    "hot_holding_limit" text DEFAULT 'Above 63°C' NOT NULL,
    "correctives" text,
    "manager_signature" text,
    "submitted_at" timestamp,
    "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  -- Created by the older runtime text, which the site-scoping migration retires.
  CREATE UNIQUE INDEX "UQ_food_safety_client_date" ON "food_safety_records" ("client_id", "record_date");
  CREATE TABLE "bikes" (
    "id" serial PRIMARY KEY NOT NULL,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
    "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
    "ref" text NOT NULL,
    "name" text,
    "type" text DEFAULT 'hybrid' NOT NULL,
    "status" text DEFAULT 'available' NOT NULL,
    "notes" text,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE "bike_hire_records" (
    "id" serial PRIMARY KEY NOT NULL,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
    "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
    "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE RESTRICT,
    "guest_name" text NOT NULL,
    "guest_contact" text,
    "hire_date" date NOT NULL,
    "return_date_expected" date,
    "return_date_actual" date,
    "deposit_pence" integer,
    "deposit_returned" boolean DEFAULT false NOT NULL,
    "status" text DEFAULT 'active' NOT NULL,
    "overdue_notified_at" timestamp,
    "overdue_notification_claim_token" text,
    "overdue_notification_claimed_at" timestamp,
    "notes" text,
    "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  CREATE TABLE "bike_checks" (
    "id" serial PRIMARY KEY NOT NULL,
    "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
    "hire_record_id" integer REFERENCES "bike_hire_records"("id") ON DELETE SET NULL,
    "bike_id" integer NOT NULL REFERENCES "bikes"("id") ON DELETE RESTRICT,
    "check_type" text NOT NULL,
    "check_date" date NOT NULL,
    "performed_by" text,
    "overall_result" text DEFAULT 'pass' NOT NULL,
    "brakes_front" text, "brakes_rear" text, "tyre_front" text, "tyre_rear" text,
    "chain_gears" text, "lights_front" text, "lights_rear" text, "frame" text,
    "saddle_seatpost" text, "handlebars" text, "pedals" text, "helmet_provided" text,
    "notes" text,
    "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
  ${BIKE_SERVICES_RUNTIME()}

  INSERT INTO legionella_checks (id, client_id, site_id, check_type, check_date, result, location, temperature, notes, performed_by) VALUES
    (1, 101, 1101, 'hot_sentinel_temp', '2026-09-01', 'pass', 'Kitchen sink', 55.5, 'Old reading', 'Alex'),
    (2, 101, 1102, 'cold_tank_temp', '2026-09-02', 'fail', 'Boathouse tap', 21.4, NULL, 'Sam'),
    (3, 101, NULL, 'shower_clean', '2026-09-03', 'pass', NULL, NULL, 'No reading taken', NULL),
    (4, 202, 2201, 'hot_sentinel_temp', '2026-09-01', 'pass', 'Other sink', 60.0, NULL, NULL);
  INSERT INTO hot_tubs (id, client_id, site_id, name) VALUES (1, 101, 1101, 'Garden tub');
  INSERT INTO hot_tub_checks (id, client_id, site_id, check_type, check_date, result, temperature, ph_value, sanitiser_level, hot_tub_id, session, location, notes, performed_by) VALUES
    (1, 101, 1101, 'water_chemistry', '2026-09-01', 'pass', 38.5, 7.40, 3.20, 1, 'morning', 'Garden tub', NULL, 'Alex'),
    (2, 101, 1101, 'water_chemistry', '2026-09-02', 'pass', 37.0, 7.60, 4.50, 1, 'evening', 'Garden tub', 'Bromine tub', 'Sam'),
    (3, 202, 2201, 'water_chemistry', '2026-09-01', 'pass', 39.0, 7.20, 2.00, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO food_safety_records (id, client_id, site_id, record_date, cold_food, hot_holding, correctives, cooking_limit) VALUES
    (1, 101, NULL, '2026-09-01', '[{"unit": "Fridge 1", "tempAm": "3.5", "tempPm": "4.0", "correctiveAction": ""}]',
       '[{"item": "Soup", "coreTemp": "65", "timeOfCheck": "12:00"}]', 'Delivery late', 'Above 75°C (10 seconds)'),
    (2, 101, 1101, '2026-09-02', '[{"unit": "Walk-in", "tempAm": "2.5", "tempPm": "3.0", "correctiveAction": ""}]',
       '[]', NULL, 'Above 75°C (10 seconds)'),
    (3, 202, NULL, '2026-09-01', '[{"unit": "Other fridge", "tempAm": "5.0", "tempPm": "", "correctiveAction": ""}]',
       '[]', NULL, 'Above 75°C (10 seconds)');
  INSERT INTO bikes (id, client_id, site_id, ref, name, type, status, notes) VALUES
    (1, 101, 1101, 'BIKE-01', 'Blue Raleigh', 'hybrid', 'hired', 'Basket fitted'),
    (2, 101, 1102, 'BIKE-02', 'Kids bike', 'kids', 'available', NULL),
    (3, 202, 2201, 'OTHER-01', NULL, 'hybrid', 'available', NULL);
  INSERT INTO bike_hire_records (id, client_id, site_id, bike_id, guest_name, guest_contact, hire_date, return_date_expected, return_date_actual, deposit_pence, deposit_returned, status, notes) VALUES
    (1, 101, 1101, 1, 'Pat Guest', '07700 900001', '2026-09-01', '2026-09-03', NULL, 5000, false, 'active', 'Room 4'),
    (2, 101, 1102, 2, 'Lee Visitor', NULL, '2026-08-20', '2026-08-20', '2026-08-20', NULL, false, 'returned', NULL),
    (3, 202, 2201, 3, 'Other hirer', NULL, '2026-09-01', NULL, NULL, NULL, false, 'active', NULL);
  INSERT INTO bike_checks (id, client_id, hire_record_id, bike_id, check_type, check_date, performed_by, overall_result, brakes_front, notes) VALUES
    (1, 101, 1, 1, 'pre_hire', '2026-09-01', 'Alex', 'pass', 'pass', NULL),
    (2, 101, 2, 2, 'post_return', '2026-08-20', 'Sam', 'fail', 'fail', 'Rear brake worn'),
    (3, 202, NULL, 3, 'routine', '2026-09-01', NULL, 'pass', NULL, NULL);
  ${BIKE_SERVICE_ROWS}
  SELECT setval(pg_get_serial_sequence(t, 'id'), 1000) FROM unnest(ARRAY[
    'legionella_checks', 'hot_tubs', 'hot_tub_checks', 'food_safety_records', 'bikes',
    'bike_hire_records', 'bike_checks', 'bike_services']) AS t;
`;

/** Builds the older shape and its rows, before any runtime migration runs. */
export async function seedUpgradeShape(shape: UpgradeShape): Promise<void> {
  await ensureRuntimeBaseline();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(TENANTS);
    await client.query(shape === "replit-runtime" ? REPLIT_RUNTIME : REPLIT_PUSH);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Between the two boots, a manager clears a reading that the first boot copied
 * from an old column. The second boot must not copy it back.
 */
export async function clearCopiedReadingBetweenBoots(): Promise<void> {
  await pool.query("UPDATE legionella_checks SET temperature = NULL, updated_at = now() WHERE id = 2 AND client_id = 101");
}
