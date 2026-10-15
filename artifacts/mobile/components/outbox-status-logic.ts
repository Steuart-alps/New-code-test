/**
 * How records saved on this device are described to staff, the same way on
 * every screen: saved on this phone (queued), syncing (sending), synced
 * (sent) and conflict / not accepted (failed). Also the "needs a connection"
 * message for actions that only work online.
 *
 * Import-free (type imports only) so tests can load it directly with Node.
 */
import type { CheckEntry } from '../lib/checkOutboxCore';

export type OutboxTone = 'queued' | 'sending' | 'synced' | 'conflict' | 'rejected';

export interface OutboxStatus {
  tone: OutboxTone;
  title: string;
  detail: string | null;
}

export function entryStatus(entry: Pick<CheckEntry, 'state' | 'error' | 'rejection'>): OutboxStatus {
  switch (entry.state) {
    case 'sent':
      return { tone: 'synced', title: 'Synced', detail: null };
    case 'sending':
      return { tone: 'sending', title: 'Syncing…', detail: null };
    case 'queued':
      return {
        tone: 'queued',
        title: 'Saved on this phone',
        detail: entry.error ? `Waiting to send · ${entry.error}` : 'Waiting to send',
      };
    case 'failed':
      return entry.rejection === 'conflict'
        ? {
          tone: 'conflict',
          title: 'Conflict — not saved on the server',
          detail: entry.error ?? 'The server already holds a different record for this entry.',
        }
        : { tone: 'rejected', title: 'Not accepted', detail: entry.error ?? 'The server rejected this record.' };
  }
}

export interface OutboxSummary {
  /** Saved on this phone and waiting to send (queued or sending). */
  waiting: number;
  /** Rejected entries (conflicts included) that need the user. */
  attention: number;
  /** Text for a tab badge, or undefined when nothing is unsent. */
  badge: string | undefined;
  /** One line for the app-wide indicator, or null when everything is synced. */
  headline: string | null;
}

/**
 * Unsent work across the device outboxes. `otherWaiting` / `otherAttention`
 * count KitchenTrack diary saves, which use their own queue.
 */
export function outboxSummary(
  entries: readonly Pick<CheckEntry, 'state'>[],
  otherWaiting = 0,
  otherAttention = 0,
): OutboxSummary {
  const waiting = entries.filter((entry) => entry.state === 'queued' || entry.state === 'sending').length + otherWaiting;
  const attention = entries.filter((entry) => entry.state === 'failed').length + otherAttention;
  const total = waiting + attention;
  const parts: string[] = [];
  if (waiting) parts.push(`${waiting} saved on this phone, waiting to send`);
  if (attention) parts.push(`${attention} need${attention === 1 ? 's' : ''} attention`);
  return {
    waiting,
    attention,
    badge: total ? (total > 99 ? '99+' : String(total)) : undefined,
    headline: parts.length ? parts.join(' · ') : null,
  };
}

/**
 * Entries this screen saw waiting (an attempt already failed, a rejection, or
 * present when the screen opened) are remembered so the screen can show them
 * as synced once delivered, rather than letting them silently disappear. An
 * entry sent on its first attempt is never marked, so online saves add no row.
 */
export function rememberWaiting(
  seen: Set<string>,
  entries: readonly Pick<CheckEntry, 'entryId' | 'state' | 'error'>[],
  firstRender: boolean,
): void {
  for (const entry of entries) {
    if (entry.state === 'sent') continue;
    if (firstRender || entry.state === 'failed' || (entry.state === 'queued' && entry.error)) seen.add(entry.entryId);
  }
}

/** Delivered entries this screen saw waiting, newest first. */
export function syncedEntries<T extends Pick<CheckEntry, 'entryId' | 'state'>>(
  seen: ReadonlySet<string>,
  all: readonly T[],
): T[] {
  return all.filter((entry) => entry.state === 'sent' && seen.has(entry.entryId)).reverse();
}

export const NEEDS_CONNECTION =
  'This needs an internet connection. Nothing was changed — try again when you have signal.';

/**
 * Whether an error is a failed request (no signal, DNS, timeout) rather than
 * an answer from the server. apiFetch errors with an HTTP status are answers.
 */
export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number((error as { status?: unknown }).status) : NaN;
  if (Number.isFinite(status) && status > 0) return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name) : '';
  const message = error instanceof Error ? error.message : '';
  return name === 'TypeError' || name === 'AbortError'
    || /network|failed to fetch|internet|offline|timed? ?out/i.test(message);
}

/** The error to show for an internet-only action. */
export function onlineActionMessage(
  error: unknown,
  fallback = 'Please try again.',
  connectionMessage = NEEDS_CONNECTION,
): string {
  if (isConnectionError(error)) return connectionMessage;
  return error instanceof Error && error.message ? error.message : fallback;
}
