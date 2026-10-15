import { createHash } from "node:crypto";
import type { Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Replay recognition for mobile outbox submissions (fire, legionella, hot tub,
 * PAT, incident and pool records, GreenTrack pre-use checks, defects, fuel logs,
 * service records and PUWER inspections, swim sessions, surveillance checks,
 * first-aid checks and incidents; KitchenTrack cleaning logs keep their receipts
 * in kitchen_cleaning_log_entries because every save updates the same log). The device sends a stable `clientEntryId` with
 * every attempt; the row stores it with a fingerprint of the validated
 * payload under a partial unique index on (client_id, client_entry_id).
 *
 * A retry after a lost response (same user, same payload) gets the stored row
 * back with 200 and creates nothing; any other reuse of the ID is a 409.
 * Web submissions carry no ID and are unaffected.
 */

/** Device entry ID: a deduplication key, not a credential. */
export const clientEntryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{12,100}$/);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key !== "clientEntryId" && item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** SHA-256 of the validated payload (key order and the entry ID ignored). */
export function clientEntryFingerprint(data: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical(data))).digest("hex");
}

export interface ClientEntry { id: string; hash: string }

export function clientEntryFrom(data: Record<string, unknown> & { clientEntryId?: string }): ClientEntry | null {
  return data.clientEntryId ? { id: data.clientEntryId, hash: clientEntryFingerprint(data) } : null;
}

interface ReplayableRow { createdBy: number | null; clientEntryHash: string | null }

/** Whether a stored row is this user's own submission of exactly this payload. */
export function isOwnReplay(row: ReplayableRow, userId: number, entry: ClientEntry): boolean {
  return row.createdBy === userId && row.clientEntryHash === entry.hash;
}

/** Answer a submission whose entry ID is already stored. */
export function respondToStoredEntry<T extends ReplayableRow>(
  res: Response, row: T, userId: number, entry: ClientEntry, present: (row: T) => unknown = (r) => r,
) {
  if (isOwnReplay(row, userId, entry)) return res.status(200).json(present(row));
  return res.status(409).json({
    error: "This device entry was already used for a different submission. Save the record again.",
    code: "CLIENT_ENTRY_CONFLICT",
  });
}

/** Unique violation, possibly wrapped by Drizzle (`cause`). */
export function isUniqueViolation(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.code === "23505") return true;
  }
  return false;
}

/** Runtime-only tables (raw SQL, snake_case rows) that store device entry IDs. */
export type RawClientEntryTable = "pool_checks" | "green_pre_use_checks" | "swim_sessions"
  | "swim_surveillance_checks" | "swim_first_aid_checks" | "swim_incidents" | "green_defects" | "green_fuel_logs" | "green_service_records" | "green_puwer_inspections" | "kitchen_weekly_records" | "kitchen_probe_checks";

/** The raw row already stored for this client's device entry, if any. */
export async function findRawStoredEntry(
  table: RawClientEntryTable, clientId: number, entry: ClientEntry | null,
): Promise<Record<string, any> | undefined> {
  if (!entry) return undefined;
  const result = await db.execute(sql`
    SELECT * FROM ${sql.identifier(table)}
    WHERE client_id = ${clientId} AND client_entry_id = ${entry.id}
    LIMIT 1
  `);
  return result.rows[0] as Record<string, any> | undefined;
}

/** respondToStoredEntry for a snake_case row from a runtime-only table. */
export function respondToRawStoredEntry(res: Response, row: Record<string, any>, userId: number, entry: ClientEntry) {
  return respondToStoredEntry(res, {
    createdBy: row.created_by == null ? null : Number(row.created_by),
    clientEntryHash: row.client_entry_hash ?? null,
  }, userId, entry, () => row);
}

/**
 * Device entry for a phone submission with staged photos. Photo receipts are
 * single-use and expire, so a resend may carry newly staged photos: they are
 * left out of the fingerprint and the stored record (with its original
 * photos) is returned. Null for web submissions; "invalid" for a malformed ID.
 */
export function stagedPhotoEntry(body: Record<string, unknown>): ClientEntry | null | "invalid" {
  if (body.clientEntryId === undefined) return null;
  if (!clientEntryIdSchema.safeParse(body.clientEntryId).success) return "invalid";
  const { photoUploadIds: _photos, ...payload } = body;
  return clientEntryFrom(payload as Record<string, unknown> & { clientEntryId: string });
}
