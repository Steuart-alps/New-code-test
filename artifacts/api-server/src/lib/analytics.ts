import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { SERVICES } from "./services";
import { logger } from "./logger";

/**
 * First-party analytics: an allowlist of the custom events the web app emits,
 * each with its permitted dimension keys and enum values. Anything outside
 * this registry is rejected. Every dimension is a fixed vocabulary, so no
 * free text, ids, names, dates or record content can be stored.
 *
 * Adding an event: register it here AND add the typed helper in
 * compliance-tracker/src/lib/analytics.ts. Never add a client, site, user or
 * record dimension.
 */
const SERVICE_KEYS = Object.keys(SERVICES);
const SITE_SCOPES = ["all_sites", "selected_site"] as const;

export const ANALYTICS_EVENT_REGISTRY: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // Settings add/remove of a paid service (confirmed by the billing API).
  service_action_succeeded: { service_key: SERVICE_KEYS, action: ["add", "remove"] },
  // TrainTrack training-matrix download.
  training_matrix_download_started: { site_scope: SITE_SCOPES },
  // Activation -> first use -> first completed work adoption journey.
  module_activation_succeeded: { module: SERVICE_KEYS },
  module_first_used: { module: SERVICE_KEYS },
  module_first_work_completed: {
    module: SERVICE_KEYS,
    activity: ["check_completed", "record_saved", "acknowledgement_recorded"],
  },
  // Generated inspection-log PDF download (HotTubTrack first).
  inspection_pdf_download_started: {
    module: ["hottubtrack"],
    site_scope: SITE_SCOPES,
    record_scope: ["empty", "has_records"],
  },
};

export interface ValidAnalyticsEvent {
  event: string;
  dimensions: Record<string, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Returns the event only when its name is registered and its dimensions are
 * exactly the registered keys with allowlisted values; otherwise null.
 */
export function validateAnalyticsEvent(body: unknown): ValidAnalyticsEvent | null {
  if (!isPlainObject(body)) return null;
  if (Object.keys(body).some((key) => key !== "event" && key !== "dimensions")) return null;
  const { event } = body;
  if (typeof event !== "string" || !Object.hasOwn(ANALYTICS_EVENT_REGISTRY, event)) return null;
  const allowed = ANALYTICS_EVENT_REGISTRY[event]!;
  const supplied = body.dimensions ?? {};
  if (!isPlainObject(supplied)) return null;
  const expectedKeys = Object.keys(allowed);
  const suppliedKeys = Object.keys(supplied);
  if (suppliedKeys.length !== expectedKeys.length) return null;
  const dimensions: Record<string, string> = {};
  for (const key of expectedKeys) {
    const value = supplied[key];
    if (typeof value !== "string" || !allowed[key]!.includes(value)) return null;
    dimensions[key] = value;
  }
  return { event, dimensions };
}

/**
 * Stores one validated event. The timestamp is truncated to the hour so a
 * row cannot be lined up with an individual request in server logs.
 */
export async function recordAnalyticsEvent({ event, dimensions }: ValidAnalyticsEvent): Promise<void> {
  await db.execute(sql`
    INSERT INTO "analytics_events" ("event_name", "dimensions", "occurred_at")
    VALUES (${event}, ${JSON.stringify(dimensions)}::jsonb, date_trunc('hour', now()))
  `);
}

export const ANALYTICS_RETENTION_INTERVAL = "13 months";

/**
 * Deletes events older than 13 months in bounded batches. Returns the number
 * of rows removed. Safe to run concurrently and repeatedly.
 */
export async function purgeExpiredAnalyticsEvents(
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 5000;
  const maxBatches = options.maxBatches ?? 200;
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await db.execute(sql`
      DELETE FROM "analytics_events"
      WHERE "id" IN (
        SELECT "id" FROM "analytics_events"
        WHERE "occurred_at" < now() - ${ANALYTICS_RETENTION_INTERVAL}::interval
        LIMIT ${batchSize}
      )
    `);
    const count = result.rowCount ?? 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

// ---- Read token for the internal summary route ----------------------------

const MIN_READ_TOKEN_LENGTH = 32;
let cachedToken: { value: string; digest: Buffer | null } | null = null;
let warnedShortToken = false;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** SHA-256 of ANALYTICS_READ_TOKEN, or null when unset or too short to be safe. */
function configuredReadTokenDigest(): Buffer | null {
  const value = process.env.ANALYTICS_READ_TOKEN ?? "";
  if (cachedToken?.value === value) return cachedToken.digest;
  let digest: Buffer | null = null;
  if (value.length >= MIN_READ_TOKEN_LENGTH) {
    digest = sha256(value);
  } else if (value.length > 0 && !warnedShortToken) {
    warnedShortToken = true;
    // Never log the value itself.
    logger.warn(`ANALYTICS_READ_TOKEN is shorter than ${MIN_READ_TOKEN_LENGTH} characters; the analytics summary route stays disabled`);
  }
  cachedToken = { value, digest };
  return digest;
}

/**
 * "disabled" when no usable token is configured (the route then 404s),
 * "unauthorized" for a missing or wrong bearer token, "ok" otherwise.
 * The comparison is constant-time over SHA-256 digests.
 */
export function checkAnalyticsReadToken(authorization: string | undefined): "disabled" | "unauthorized" | "ok" {
  const expected = configuredReadTokenDigest();
  if (!expected) return "disabled";
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const supplied = sha256(match?.[1] ?? "");
  return match && timingSafeEqual(supplied, expected) ? "ok" : "unauthorized";
}
