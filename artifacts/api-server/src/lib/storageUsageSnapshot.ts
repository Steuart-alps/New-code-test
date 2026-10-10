import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import type { StorageUsageChange, StorageUsageEntry, StorageUsageRecorder } from "./objectStorage";

/**
 * Per-tenant storage usage, kept current without reading provider metadata on
 * every Settings load.
 *
 * - storage_usage_objects is a ledger with one row per private object path.
 *   Upload finalisation upserts a row and deletion marks it absent, so retries
 *   and replays are idempotent: totals are SUM(size) over present rows, never
 *   a counter adjusted by deltas, and cannot go negative or double count.
 * - storage_usage_pending records a lifecycle change before the provider is
 *   touched and is cleared in the same transaction as its ledger write. A
 *   crash in between leaves a durable marker that forces reconciliation.
 * - storage_usage_snapshots records when the ledger was last reconciled with
 *   authoritative provider metadata and ACL ownership, the drift found, and a
 *   refresh lease so only one reconciliation per tenant runs at a time.
 *
 * Lifecycle writes always win. Reconciliation only changes ledger rows that
 * were last written before it started listing, so a stale listing can never
 * undo a finalisation or resurrect a deletion that happened meanwhile.
 */

const STORAGE_USAGE_LOCK_NS = 0x53545247; // "STRG"
const DEFAULT_SNAPSHOT_MAX_AGE_SECONDS = 60 * 60;
const REFRESH_LEASE_SECONDS = 5 * 60;
/** Lifecycle changes normally finish within seconds; older markers mean a crash. */
const PENDING_STALE_SECONDS = 10 * 60;
/** Tombstones only need to outlive any reconciliation that could still be running. */
const TOMBSTONE_RETENTION = "1 day";

type Executor = Pick<typeof db, "execute">;

function lockTenant(tx: Executor, clientId: number) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock(${STORAGE_USAGE_LOCK_NS}, ${clientId})`);
}

function assertTenantId(clientId: number): void {
  if (!Number.isSafeInteger(clientId) || clientId <= 0) {
    throw new Error("Storage usage requires a positive tenant id");
  }
}

function toSafeCount(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Stored ${label} is outside the supported range`);
  }
  return parsed;
}

export function storageUsageSnapshotMaxAgeSeconds(): number {
  const raw = Number(process.env.STORAGE_USAGE_SNAPSHOT_MAX_AGE_SECONDS?.trim());
  return Number.isSafeInteger(raw) && raw >= 60 ? raw : DEFAULT_SNAPSHOT_MAX_AGE_SECONDS;
}

/** Note an upcoming lifecycle change; returns the marker id to clear afterwards. */
export async function beginStorageUsageChange(clientId: number): Promise<string> {
  assertTenantId(clientId);
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO storage_usage_pending (id, client_id, started_at)
    VALUES (${id}, ${clientId}, now())
  `);
  return id;
}

/** Clear a marker for a change that did not touch the provider. */
export async function abandonStorageUsageChange(pendingId: string): Promise<void> {
  await db.execute(sql`DELETE FROM storage_usage_pending WHERE id = ${pendingId}`);
}

/**
 * Apply one finalisation or deletion to the ledger. Safe to repeat: the row is
 * keyed by object path, and a row owned by another tenant is never changed.
 */
export async function recordStorageUsageChange(
  clientId: number,
  change: StorageUsageChange,
  pendingId?: string | null,
): Promise<void> {
  assertTenantId(clientId);
  if (!change.objectPath.startsWith("/objects/")) {
    throw new Error("Storage usage only tracks private object paths");
  }
  const reservedFor = /^\/objects\/(?:uploads|finalized)\/tenant-(\d+)\//.exec(change.objectPath)?.[1];
  if (reservedFor !== undefined && reservedFor !== String(clientId)) {
    throw new Error("Object path is reserved for another tenant");
  }
  if (change.kind === "present" && (!Number.isSafeInteger(change.sizeBytes) || change.sizeBytes < 0)) {
    throw new Error("Object size must be a non-negative safe integer");
  }
  await db.transaction(async (tx) => {
    await lockTenant(tx, clientId);
    if (change.kind === "present") {
      await tx.execute(sql`
        INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present, changed_at)
        VALUES (${change.objectPath}, ${clientId}, ${change.sizeBytes}, true, now())
        ON CONFLICT (object_path) DO UPDATE
          SET size_bytes = EXCLUDED.size_bytes, present = true, changed_at = EXCLUDED.changed_at
          WHERE storage_usage_objects.client_id = EXCLUDED.client_id
      `);
    } else {
      // A tombstone, not a delete: it stops a reconciliation that listed the
      // object before it was removed from putting it back.
      await tx.execute(sql`
        INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present, changed_at)
        VALUES (${change.objectPath}, ${clientId}, 0, false, now())
        ON CONFLICT (object_path) DO UPDATE
          SET present = false, changed_at = EXCLUDED.changed_at
          WHERE storage_usage_objects.client_id = EXCLUDED.client_id
      `);
    }
    if (pendingId) {
      await tx.execute(sql`DELETE FROM storage_usage_pending WHERE id = ${pendingId} AND client_id = ${clientId}`);
    }
  });
}

function logRecorderFailure(error: unknown, operation: string, clientId?: number) {
  logger.warn({ err: error, operation, clientId }, "Storage usage ledger update failed; the next reconciliation will correct it");
}

/**
 * Ledger hooks for ObjectStorageService. Failures are logged rather than
 * thrown: the provider change has already happened (or is about to), and a
 * missed ledger write is corrected by reconciliation, while failing the user's
 * upload or deletion would not undo it.
 */
export const storageUsageLedger: StorageUsageRecorder = {
  async begin(clientId) {
    try {
      return await beginStorageUsageChange(clientId);
    } catch (error) {
      logRecorderFailure(error, "begin", clientId);
      return null;
    }
  },
  async record(clientId, change, pendingId) {
    try {
      await recordStorageUsageChange(clientId, change, pendingId);
    } catch (error) {
      logRecorderFailure(error, "record", clientId);
    }
  },
  async abandon(pendingId) {
    try {
      await abandonStorageUsageChange(pendingId);
    } catch (error) {
      logRecorderFailure(error, "abandon");
    }
  },
};

export type StorageUsageSnapshot = {
  usedBytes: number;
  objectCount: number;
  /** When the ledger was last reconciled with the provider; null if never. */
  reconciledAt: Date | null;
  ageSeconds: number | null;
  refreshing: boolean;
  /** A lifecycle change was interrupted, so the ledger may be missing it. */
  interruptedChanges: boolean;
  driftBytes: number;
  driftObjects: number;
};

/** One indexed query: current ledger totals plus snapshot freshness. */
export async function readStorageUsageSnapshot(clientId: number): Promise<StorageUsageSnapshot> {
  assertTenantId(clientId);
  const result = await db.execute(sql`
    SELECT
      totals.used_bytes::text AS used_bytes,
      totals.object_count::text AS object_count,
      s.reconciled_at,
      GREATEST(0, EXTRACT(EPOCH FROM (now() - s.reconciled_at)))::float8 AS age_seconds,
      COALESCE(s.refresh_lease_until > now(), false) AS refreshing,
      COALESCE(s.drift_bytes, 0)::text AS drift_bytes,
      COALESCE(s.drift_objects, 0) AS drift_objects,
      EXISTS (
        SELECT 1 FROM storage_usage_pending p
        WHERE p.client_id = ${clientId}
          AND p.started_at < now() - make_interval(secs => ${PENDING_STALE_SECONDS})
      ) AS interrupted_changes
    FROM (
      SELECT COALESCE(SUM(size_bytes), 0) AS used_bytes, COUNT(*) AS object_count
      FROM storage_usage_objects
      WHERE client_id = ${clientId} AND present
    ) totals
    LEFT JOIN storage_usage_snapshots s ON s.client_id = ${clientId}
  `);
  const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
  const reconciledAt = row.reconciled_at ? new Date(row.reconciled_at as string) : null;
  return {
    usedBytes: toSafeCount(row.used_bytes, "usage"),
    objectCount: toSafeCount(row.object_count, "object count"),
    reconciledAt,
    ageSeconds: reconciledAt ? Math.floor(Number(row.age_seconds ?? 0)) : null,
    refreshing: Boolean(row.refreshing),
    interruptedChanges: Boolean(row.interrupted_changes),
    driftBytes: Number(row.drift_bytes ?? 0),
    driftObjects: Number(row.drift_objects ?? 0),
  };
}

/** Whether a read should trigger a reconciliation. */
export function storageUsageSnapshotIsStale(snapshot: StorageUsageSnapshot, maxAgeSeconds = storageUsageSnapshotMaxAgeSeconds()): boolean {
  return snapshot.reconciledAt === null
    || snapshot.interruptedChanges
    || (snapshot.ageSeconds ?? Infinity) >= maxAgeSeconds;
}

export type StorageUsageReconciliation = {
  usedBytes: number;
  objectCount: number;
  driftBytes: number;
  driftObjects: number;
  reconciledAt: Date;
};

/**
 * Rebuild one tenant's ledger from authoritative provider listings.
 *
 * `listObjects` must read the provider (and the tenant's legacy references)
 * after it is called, and return only objects whose ACL names this tenant as
 * private owner. Returns null when another reconciliation holds the lease.
 */
export async function reconcileStorageUsage(
  clientId: number,
  listObjects: () => Promise<StorageUsageEntry[]>,
): Promise<StorageUsageReconciliation | null> {
  assertTenantId(clientId);
  const leaseToken = randomUUID();
  const lease = await db.execute(sql`
    INSERT INTO storage_usage_snapshots (client_id, refresh_lease_token, refresh_lease_until, updated_at)
    VALUES (${clientId}, ${leaseToken}, now() + make_interval(secs => ${REFRESH_LEASE_SECONDS}), now())
    ON CONFLICT (client_id) DO UPDATE
      SET refresh_lease_token = EXCLUDED.refresh_lease_token,
          refresh_lease_until = EXCLUDED.refresh_lease_until,
          updated_at = now()
      WHERE storage_usage_snapshots.refresh_lease_until IS NULL
         OR storage_usage_snapshots.refresh_lease_until <= now()
    RETURNING now()::text AS started_at
  `);
  const leaseRow = lease.rows?.[0] as { started_at?: string } | undefined;
  if (!leaseRow?.started_at) return null;
  // Database time at full precision, so ordering against lifecycle writes
  // ignores app clock skew and millisecond rounding.
  const startedAt = sql`${leaseRow.started_at}::timestamptz`;

  let entries: StorageUsageEntry[];
  try {
    entries = await listObjects();
  } catch (error) {
    await db.execute(sql`
      UPDATE storage_usage_snapshots
      SET refresh_lease_token = NULL, refresh_lease_until = NULL, last_failed_at = now(), updated_at = now()
      WHERE client_id = ${clientId} AND refresh_lease_token = ${leaseToken}
    `).catch(() => {});
    throw error;
  }

  const unique = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.objectPath.startsWith("/objects/") || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new Error("Provider listing returned an invalid storage entry");
    }
    unique.set(entry.objectPath, entry.sizeBytes);
  }
  const observed = JSON.stringify([...unique].map(([object_path, size_bytes]) => ({ object_path, size_bytes })));

  const result = await db.transaction(async (tx) => {
    await lockTenant(tx, clientId);
    const totals = async () => {
      const r = await tx.execute(sql`
        SELECT COALESCE(SUM(size_bytes), 0)::text AS used_bytes, COUNT(*)::text AS object_count
        FROM storage_usage_objects WHERE client_id = ${clientId} AND present
      `);
      const row = (r.rows?.[0] ?? {}) as Record<string, unknown>;
      return { usedBytes: toSafeCount(row.used_bytes, "usage"), objectCount: toSafeCount(row.object_count, "object count") };
    };
    const before = await totals();

    // Objects the provider reports. Rows written after the listing began are
    // newer truth and are left alone. The listing is filtered by ACL owner, so
    // it may also correct a row the ledger had attributed to another tenant.
    await tx.execute(sql`
      INSERT INTO storage_usage_objects (object_path, client_id, size_bytes, present, changed_at)
      SELECT e.object_path, ${clientId}, e.size_bytes, true, now()
      FROM jsonb_to_recordset(${observed}::jsonb) AS e(object_path text, size_bytes bigint)
      ON CONFLICT (object_path) DO UPDATE
        SET client_id = EXCLUDED.client_id, size_bytes = EXCLUDED.size_bytes, present = true, changed_at = EXCLUDED.changed_at
        WHERE storage_usage_objects.changed_at < ${startedAt}
          AND (storage_usage_objects.client_id <> EXCLUDED.client_id
            OR NOT storage_usage_objects.present
            OR storage_usage_objects.size_bytes <> EXCLUDED.size_bytes)
    `);
    // Objects the ledger counts but the provider no longer reports for this tenant.
    await tx.execute(sql`
      UPDATE storage_usage_objects o
      SET present = false, changed_at = now()
      WHERE o.client_id = ${clientId}
        AND o.present
        AND o.changed_at < ${startedAt}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${observed}::jsonb) AS e(object_path text, size_bytes bigint)
          WHERE e.object_path = o.object_path
        )
    `);
    await tx.execute(sql`
      DELETE FROM storage_usage_objects
      WHERE client_id = ${clientId} AND NOT present
        AND changed_at < ${startedAt} - ${TOMBSTONE_RETENTION}::interval
    `);
    // Markers older than any in-flight change are now covered by this listing.
    await tx.execute(sql`
      DELETE FROM storage_usage_pending
      WHERE client_id = ${clientId}
        AND started_at < ${startedAt} - make_interval(secs => ${PENDING_STALE_SECONDS})
    `);

    const after = await totals();
    const driftBytes = after.usedBytes - before.usedBytes;
    const driftObjects = after.objectCount - before.objectCount;
    await tx.execute(sql`
      UPDATE storage_usage_snapshots
      SET reconciled_at = GREATEST(COALESCE(reconciled_at, ${startedAt}), ${startedAt}),
          used_bytes = ${after.usedBytes},
          object_count = ${after.objectCount},
          drift_bytes = ${driftBytes},
          drift_objects = ${driftObjects},
          last_drift_at = CASE WHEN ${driftBytes} <> 0 OR ${driftObjects} <> 0 THEN now() ELSE last_drift_at END,
          last_failed_at = NULL,
          refresh_lease_token = CASE WHEN refresh_lease_token = ${leaseToken} THEN NULL ELSE refresh_lease_token END,
          refresh_lease_until = CASE WHEN refresh_lease_token = ${leaseToken} THEN NULL ELSE refresh_lease_until END,
          updated_at = now()
      WHERE client_id = ${clientId}
    `);
    return { ...after, driftBytes, driftObjects, reconciledAt: new Date(leaseRow.started_at!) };
  });

  if (result.driftBytes !== 0 || result.driftObjects !== 0) {
    logger.warn(
      { clientId, driftBytes: result.driftBytes, driftObjects: result.driftObjects },
      "Storage usage ledger drifted from provider metadata; reconciled",
    );
  }
  return result;
}

const backgroundRefreshes = new Map<number, Promise<void>>();

/**
 * Reconcile without making the caller wait. One refresh per tenant per process;
 * the database lease also stops other instances from duplicating it.
 */
export function refreshStorageUsageInBackground(
  clientId: number,
  listObjects: () => Promise<StorageUsageEntry[]>,
): void {
  if (backgroundRefreshes.has(clientId)) return;
  const run = reconcileStorageUsage(clientId, listObjects)
    .then(() => undefined)
    .catch((error) => {
      logger.error({ err: error, clientId, operation: "storage usage reconciliation" }, "Storage usage reconciliation failed");
    })
    .finally(() => backgroundRefreshes.delete(clientId));
  backgroundRefreshes.set(clientId, run);
}
