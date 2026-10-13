import { createHash } from "node:crypto";
import type { Response } from "express";
import { z } from "zod";

/**
 * Replay recognition for mobile outbox submissions (fire, legionella, hot tub,
 * PAT and incident records). The device sends a stable `clientEntryId` with
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
