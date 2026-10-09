import { createHmac } from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import type { SharedRateLimitStore } from "./loginRateLimit";

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function startExpiredCounterCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void db.execute(sql`
      DELETE FROM auth_rate_limit_counters
      WHERE expires_at <= clock_timestamp()
    `).catch((err) => {
      logger.warn({ err }, "Could not remove expired authentication rate-limit counters");
    });
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
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
      const sessionSecret = process.env.SESSION_SECRET;
      if (!sessionSecret) {
        throw new Error("SESSION_SECRET is required for shared authentication rate limits");
      }
      const keyHash = createHmac("sha256", sessionSecret).update(key).digest("hex");
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
     * Return one attempt to the exact window it was taken from. A window that
     * has expired or been reset since is left alone. The last attempt removes
     * the row so the next failure opens a fresh window, as in development.
     * If a concurrent consume races the final release, the release is lost and
     * the counter stays one higher, which only ever makes the limit stricter.
     */
    async release(key, windowId) {
      const sessionSecret = process.env.SESSION_SECRET;
      if (!sessionSecret) {
        throw new Error("SESSION_SECRET is required for shared authentication rate limits");
      }
      const keyHash = createHmac("sha256", sessionSecret).update(key).digest("hex");
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