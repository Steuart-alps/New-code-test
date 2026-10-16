import { createHmac } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import type { SharedRateLimitStore } from "./loginRateLimit";

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

/** Delete every counter whose window has ended; returns how many went. */
export async function deleteExpiredRateLimitCounters(): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM auth_rate_limit_counters
    WHERE expires_at <= clock_timestamp()
  `);
  return result.rowCount ?? 0;
}

function startExpiredCounterCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void deleteExpiredRateLimitCounters().catch((err) => {
      logger.warn({ err }, "Could not remove expired authentication rate-limit counters");
    });
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

function hashKey(key: string): string {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required for shared authentication rate limits");
  }
  return createHmac("sha256", sessionSecret).update(key).digest("hex");
}

/**
 * PostgreSQL's unique-key upsert serializes attempts for a key across API
 * processes. The fixed window begins with its first attempt and expired
 * windows reset atomically. Only an HMAC is stored; raw IPs never persist.
 */
export function createDatabaseLoginRateLimitStore(): SharedRateLimitStore {
  startExpiredCounterCleanup();
  return {
    async consume(key, windowMs, max) {
      const keyHash = hashKey(key);
      const result = await db.execute(sql`
        INSERT INTO auth_rate_limit_counters (key_hash, attempts, expires_at, updated_at)
        VALUES (
          ${keyHash},
          1,
          clock_timestamp() + (${windowMs}::double precision * INTERVAL '1 millisecond'),
          clock_timestamp()
        )
        ON CONFLICT (key_hash) DO UPDATE SET
          attempts = CASE
            WHEN auth_rate_limit_counters.expires_at <= clock_timestamp() THEN 1
            ELSE LEAST(auth_rate_limit_counters.attempts + 1, ${max + 1})
          END,
          expires_at = CASE
            WHEN auth_rate_limit_counters.expires_at <= clock_timestamp()
              THEN clock_timestamp() + (${windowMs}::double precision * INTERVAL '1 millisecond')
            ELSE auth_rate_limit_counters.expires_at
          END,
          updated_at = clock_timestamp()
        RETURNING attempts, expires_at::text AS window_id,
          GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))))::integer
            AS retry_after_seconds
      `);
      const row = result.rows?.[0] as
        | { attempts: number | string; retry_after_seconds: number | string; window_id: string }
        | undefined;
      if (!row) throw new Error("Shared authentication rate-limit counter was not returned");

      return {
        count: Number(row.attempts),
        retryAfterSeconds: Number(row.retry_after_seconds),
        windowId: row.window_id,
      };
    },

    /**
     * Consume one attempt from several counters in a single upsert, so a
     * request checked against more than one limit (public links: per IP and
     * per link) costs one database round trip. Rows are taken in key-hash
     * order so concurrent statements lock them in the same order and cannot
     * deadlock. Same fixed-window semantics as consume().
     */
    async consumeMany(entries) {
      if (entries.length === 0) return [];
      const hashed = entries.map((entry) => ({ ...entry, keyHash: hashKey(entry.key) }));
      if (new Set(hashed.map((entry) => entry.keyHash)).size !== hashed.length) {
        throw new Error("consumeMany needs distinct keys");
      }
      const values = sql.join(hashed.map((entry) => sql`(${entry.keyHash}::text, ${entry.windowMs}::double precision, ${entry.max + 1}::integer)`), sql`, `);
      const result = await db.execute(sql`
        WITH input (key_hash, window_ms, cap) AS (VALUES ${values})
        INSERT INTO auth_rate_limit_counters AS counter (key_hash, attempts, expires_at, updated_at)
        SELECT key_hash, 1, clock_timestamp() + (window_ms * INTERVAL '1 millisecond'), clock_timestamp()
        FROM input
        ORDER BY key_hash
        ON CONFLICT (key_hash) DO UPDATE SET
          attempts = CASE
            WHEN counter.expires_at <= clock_timestamp() THEN 1
            ELSE LEAST(counter.attempts + 1, (SELECT cap FROM input WHERE input.key_hash = EXCLUDED.key_hash))
          END,
          expires_at = CASE
            WHEN counter.expires_at <= clock_timestamp() THEN EXCLUDED.expires_at
            ELSE counter.expires_at
          END,
          updated_at = clock_timestamp()
        RETURNING key_hash, attempts, expires_at::text AS window_id,
          GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))))::integer
            AS retry_after_seconds
      `);
      const rows = new Map(((result.rows ?? []) as Array<{
        key_hash: string; attempts: number | string; retry_after_seconds: number | string; window_id: string;
      }>).map((row) => [row.key_hash, row]));
      return hashed.map((entry) => {
        const row = rows.get(entry.keyHash);
        if (!row) throw new Error("Shared rate-limit counter was not returned");
        return {
          count: Number(row.attempts),
          retryAfterSeconds: Number(row.retry_after_seconds),
          windowId: row.window_id,
        };
      });
    },

    /**
     * Return one attempt to the exact window it was taken from. A window that
     * has expired or been reset since is left alone. The last attempt removes
     * the row so the next failure opens a fresh window, as in development.
     * If a concurrent consume races the final release, the release is lost and
     * the counter stays one higher, which only ever makes the limit stricter.
     */
    async release(key, windowId) {
      const keyHash = hashKey(key);
      await db.execute(sql`
        WITH removed AS (
          DELETE FROM auth_rate_limit_counters
          WHERE key_hash = ${keyHash}
            AND expires_at = ${windowId}::timestamptz
            AND attempts <= 1
          RETURNING key_hash
        )
        UPDATE auth_rate_limit_counters
        SET attempts = attempts - 1, updated_at = clock_timestamp()
        WHERE key_hash = ${keyHash}
          AND expires_at = ${windowId}::timestamptz
          AND attempts > 1
      `);
    },
  };
}