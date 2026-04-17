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
    logger.info("Runtime migrations complete");
  } catch (err) {
    logger.error({ err }, "Runtime migrations failed");
  }
}
