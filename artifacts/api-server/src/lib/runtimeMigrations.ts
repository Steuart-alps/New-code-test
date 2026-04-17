import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Idempotent runtime migrations for additive schema changes.
 * Safe to run on every boot — uses IF NOT EXISTS guards.
 */
export async function runRuntimeMigrations() {
  try {
    await db.execute(sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS responsible_person text`);
    await db.execute(sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS address text`);
    await db.execute(sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS phone text`);

    // Session store table (connect-pg-simple). We create it manually because
    // its bundled table.sql isn't available inside our esbuild output.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
      ) WITH (OIDS=FALSE)
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_sessions_expire" ON "sessions" ("expire")`);

    logger.info("Runtime migrations complete");
  } catch (err) {
    logger.error({ err }, "Runtime migrations failed");
  }
}
