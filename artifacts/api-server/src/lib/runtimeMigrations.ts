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
        "record_date" date NOT NULL,
        "deliveries" jsonb NOT NULL DEFAULT '[]',
        "cold_food" jsonb NOT NULL DEFAULT '[]',
        "hot_temperature" jsonb NOT NULL DEFAULT '[]',
        "hot_holding" jsonb NOT NULL DEFAULT '[]',
        "cooking_limit" text NOT NULL DEFAULT 'Above 75°C (10 seconds)',
        "cooling_limit" text NOT NULL DEFAULT '8°C within 90 minutes',
        "reheating_limit" text NOT NULL DEFAULT 'Above 82°C',
        "hot_holding_limit" text NOT NULL DEFAULT 'Above 63°C',
        "correctives" text,
        "manager_signature" text,
        "submitted_at" timestamp,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);

    // ---- Legionella water safety logbook table ----
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "legionella_checks" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL,
        "check_type" text NOT NULL,
        "check_date" date NOT NULL,
        "result" text NOT NULL DEFAULT 'pass',
        "temperature" numeric(5,2),
        "location" text,
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

    // ---- Add site_id column to compliance_items ----
    await db.execute(sql`
      ALTER TABLE "compliance_items"
      ADD COLUMN IF NOT EXISTS "site_id" integer REFERENCES "sites"("id") ON DELETE SET NULL
    `);

    // ---- Add category_id column to compliance_items (new model: checks belong to a category) ----
    await db.execute(sql`
      ALTER TABLE "compliance_items"
      ADD COLUMN IF NOT EXISTS "category_id" integer REFERENCES "categories"("id") ON DELETE SET NULL
    `);

    // ---- One-time legacy migration: convert old categories-as-sites into the sites table ----
    // Must run BEFORE we drop sites.category_id, because migrateLegacyCategories()
    // inserts rows into sites with a category_id linkage.
    const hasLegacyCategoryAddress = await columnExists("categories", "address");
    if (hasLegacyCategoryAddress) {
      logger.info("Running one-time category→site data migration...");
      await migrateLegacyCategories();
      // Drop unused address columns from categories
      await db.execute(sql`ALTER TABLE "categories" DROP COLUMN IF EXISTS "responsible_person"`);
      await db.execute(sql`ALTER TABLE "categories" DROP COLUMN IF EXISTS "address"`);
      await db.execute(sql`ALTER TABLE "categories" DROP COLUMN IF EXISTS "phone"`);
      logger.info("Category→site migration complete");
    }

    // ---- Backfill compliance_items.category_id from sites.category_id, then drop sites.category_id ----
    // Catches both: (a) the just-completed legacy migration and (b) the previous refactor
    // where sites carried the category. After this, sites are independent of categories.
    const sitesHasCategoryId = await columnExists("sites", "category_id");
    if (sitesHasCategoryId) {
      await db.execute(sql`
        UPDATE compliance_items ci
        SET category_id = s.category_id
        FROM sites s
        WHERE ci.site_id = s.id AND ci.category_id IS NULL AND s.category_id IS NOT NULL
      `);
      await db.execute(sql`ALTER TABLE "sites" DROP COLUMN IF EXISTS "category_id"`);
    }

    // ---- Per-reminder scheduling token + chosen visit date ----
    await db.execute(sql`
      ALTER TABLE "compliance_items"
      ADD COLUMN IF NOT EXISTS "schedule_token" text
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "compliance_items_schedule_token_idx"
      ON "compliance_items" ("schedule_token")
      WHERE "schedule_token" IS NOT NULL
    `);
    await db.execute(sql`
      ALTER TABLE "compliance_items"
      ADD COLUMN IF NOT EXISTS "visit_scheduled_at" timestamp
    `);

    // ---- Certificates can now belong to a compliance item directly ----
    await db.execute(sql`
      ALTER TABLE "certificates"
      ADD COLUMN IF NOT EXISTS "item_id" integer REFERENCES "compliance_items"("id") ON DELETE CASCADE
    `);
    await db.execute(sql`
      ALTER TABLE "certificates"
      ALTER COLUMN "contractor_id" DROP NOT NULL
    `);

    // Enforce that every certificate belongs to exactly one of: a contractor OR an item.
    // Clean up any rows that violate the rule before adding the constraint.
    await db.execute(sql`
      DELETE FROM "certificates"
      WHERE ("contractor_id" IS NULL AND "item_id" IS NULL)
         OR ("contractor_id" IS NOT NULL AND "item_id" IS NOT NULL)
    `);
    await db.execute(sql`
      ALTER TABLE "certificates"
      DROP CONSTRAINT IF EXISTS "certificates_owner_xor_chk"
    `);
    await db.execute(sql`
      ALTER TABLE "certificates"
      ADD CONSTRAINT "certificates_owner_xor_chk"
      CHECK ((contractor_id IS NOT NULL)::int + (item_id IS NOT NULL)::int = 1)
    `);

    // ---- Consultant <-> client tenant membership (cross-tenant IDOR fix) ----
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
    // Backfill: every consultant-role user is linked to their own client so
    // existing accounts keep access to their data. Idempotent via ON CONFLICT.
    await db.execute(sql`
      INSERT INTO "consultant_clients" ("user_id", "client_id")
      SELECT id, client_id FROM "users"
      WHERE role = 'consultant' AND client_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);

    // ---- Billing outbox: pending one-off charges for added sites ----
    // Recorded BEFORE touching Stripe so a crash between the subscription
    // quantity update and the invoice charge can never lose a billable event.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "billing_pending_charges" (
        "id" serial PRIMARY KEY,
        "client_id" integer NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
        "sites_added" integer NOT NULL,
        "amount" integer NOT NULL,
        "currency" text NOT NULL,
        "from_quantity" integer NOT NULL DEFAULT 0,
        "to_quantity" integer NOT NULL DEFAULT 0,
        "status" text NOT NULL DEFAULT 'pending',
        "stripe_invoice_id" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "charged_at" timestamp
      )
    `);
    await db.execute(sql`
      ALTER TABLE "billing_pending_charges"
      ADD COLUMN IF NOT EXISTS "from_quantity" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "to_quantity" integer NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS "billing_pending_charges_status_idx"
      ON "billing_pending_charges" ("status", "client_id")
    `);
    // Event-based charge intent: one outbox row per added site, created in the
    // same transaction as the site row itself. Exactly one charge row may ever
    // exist per site.
    await db.execute(sql`
      ALTER TABLE "billing_pending_charges"
      ADD COLUMN IF NOT EXISTS "site_id" integer
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "billing_pending_charges_site_uq"
      ON "billing_pending_charges" ("site_id")
      WHERE "site_id" IS NOT NULL
    `);
    // Superseded by per-site event rows (quantity-delta dedup no longer used).
    await db.execute(sql`
      DROP INDEX IF EXISTS "billing_pending_charges_transition_uq"
    `);

    // ---- Track when the "trial ending soon" reminder email was sent ----
    await db.execute(sql`
      ALTER TABLE "clients"
      ADD COLUMN IF NOT EXISTS "trial_reminder_sent_at" timestamp
    `);

    logger.info("Runtime migrations complete");
  } catch (err) {
    logger.error({ err }, "Runtime migrations failed");
  }
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
    LIMIT 1
  `);
  return (result.rows?.length ?? 0) > 0;
}

interface LegacyCategoryRow {
  id: number;
  client_id: number;
  name: string;
  color: string | null;
  responsible_person: string | null;
  address: string | null;
  phone: string | null;
}

async function migrateLegacyCategories() {
  // Read every existing category row across all clients (raw — schema no longer
  // has the address fields).
  const result = await db.execute(sql`
    SELECT id, client_id, name, color, responsible_person, address, phone
    FROM categories
  `);
  const rows = (result.rows ?? []) as unknown as LegacyCategoryRow[];
  if (rows.length === 0) return;

  // Group by client
  const byClient = new Map<number, LegacyCategoryRow[]>();
  for (const r of rows) {
    if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
    byClient.get(r.client_id)!.push(r);
  }

  for (const [clientId, clientRows] of byClient) {
    // Identify which old rows look like real geographical sites (Glasgow rule)
    // and which become Categories.
    const siteRows = clientRows.filter(r => /glasgow/i.test(r.name));
    const categoryRows = clientRows.filter(r => !/glasgow/i.test(r.name));

    // If nothing matched, treat the first row as the placeholder site and the
    // rest as categories.
    if (siteRows.length === 0 && clientRows.length > 0) {
      siteRows.push(clientRows[0]);
      categoryRows.splice(0, categoryRows.length, ...clientRows.slice(1));
    }

    // Pick a parent category for the sites. Use the first existing category
    // row (it stays in the categories table and keeps its id), or create
    // "General" if none exist.
    let parentCategoryId: number;
    if (categoryRows.length > 0) {
      parentCategoryId = categoryRows[0].id;
    } else {
      const inserted = await db.execute(sql`
        INSERT INTO categories (client_id, name, color)
        VALUES (${clientId}, 'General', '#6366f1')
        RETURNING id
      `);
      parentCategoryId = (inserted.rows![0] as any).id as number;
    }

    // Create the site(s). Use the first matched site row's data.
    const primarySiteRow = siteRows[0];
    const insertedSite = await db.execute(sql`
      INSERT INTO sites (client_id, category_id, name, responsible_person, address, phone)
      VALUES (
        ${clientId},
        ${parentCategoryId},
        ${primarySiteRow.name},
        ${primarySiteRow.responsible_person},
        ${primarySiteRow.address},
        ${primarySiteRow.phone}
      )
      RETURNING id
    `);
    const newSiteId = (insertedSite.rows![0] as any).id as number;

    // Reassign every compliance item belonging to this client to the new site.
    await db.execute(sql`
      UPDATE compliance_items SET site_id = ${newSiteId} WHERE client_id = ${clientId}
    `);

    // Delete the legacy "site-style" rows that have now been moved into the
    // sites table (so they don't clutter Categories). Skip the rows we kept
    // as categories.
    const idsToDelete = siteRows.map(r => r.id);
    if (idsToDelete.length > 0) {
      const idList = sql.join(idsToDelete.map(id => sql`${id}`), sql`, `);
      await db.execute(sql`DELETE FROM categories WHERE id IN (${idList})`);
    }
  }
}
