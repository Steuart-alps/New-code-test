/**
 * Device entry IDs for forms that send straight to the server instead of
 * through the check outbox (GreenTrack pre-use checks and swim sessions, whose
 * staged photos need a connection). Pressing save again after a lost response
 * reuses the entry ID while the answers are unchanged, so the server returns
 * the record it already stored instead of creating a duplicate. Changed
 * answers get a new ID (a new record). Photo receipts are single-use, so they
 * are not part of the comparison; the server ignores them for replays too.
 *
 * Import-free so tests can load it directly with Node.
 */
export interface EntryAttempt { key: string; id: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key !== 'clientEntryId' && key !== 'photoUploadIds' && item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** What identifies the answers (key order, entry ID and photos ignored). */
export function entryPayloadKey(payload: Record<string, unknown>): string {
  return JSON.stringify(canonical(payload));
}

/** The attempt to send: the previous one's ID when the answers match, else a new ID. */
export function nextEntryAttempt(
  previous: EntryAttempt | null, payload: Record<string, unknown>, newId: () => string,
): EntryAttempt {
  const key = entryPayloadKey(payload);
  return previous?.key === key ? previous : { key, id: newId() };
}

/** The attempt a saved device copy was sent under, if it carries an entry ID. */
export function attemptFromSavedBody(body: Record<string, unknown>): EntryAttempt | null {
  const id = body.clientEntryId;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{12,100}$/.test(id) ? { key: entryPayloadKey(body), id } : null;
}
