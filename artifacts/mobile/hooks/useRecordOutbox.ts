import { useCallback } from 'react';
import { checkOutbox, newCheckEntryId, useCheckOutbox } from '@/lib/checkOutbox';
import { RECORD_PATHS, type CheckEntry, type CheckKind, type OfflineActionKind } from '@/lib/checkOutboxCore';
import type { UnsentSubmission } from '@/components/unsent-submission-logic';

type RecordKind = Exclude<CheckKind, 'daily-checklist' | OfflineActionKind>;
export type RecordSendResult =
  | { state: 'sent'; entry: CheckEntry; response: unknown }
  | { state: 'queued'; entry: CheckEntry }
  | { state: 'rejected'; entry: CheckEntry; error: string };

/**
 * Saves one entry on the device, then makes the first attempt. Sent: the
 * server's response. Queued: no connection, resent automatically. Rejected on
 * the first attempt (invalid data, no permission): the device copy is removed
 * and the error returned so the screen can keep the form for correcting.
 */
async function sendThroughOutbox(input: Pick<CheckEntry, 'entryId' | 'kind' | 'path' | 'scopeKey' | 'label' | 'body'>): Promise<RecordSendResult> {
  const entry = await checkOutbox.enqueue(input);
  await checkOutbox.replay();
  const current = checkOutbox.getSnapshot().entries.find((row) => row.entryId === entry.entryId) ?? entry;
  if (current.state === 'sent') return { state: 'sent', entry: current, response: checkOutbox.takeResponse(current.entryId) };
  if (current.state === 'failed') {
    await checkOutbox.removeFailed(current.entryId);
    return { state: 'rejected', entry: current, error: current.error ?? 'The server rejected this record.' };
  }
  return { state: 'queued', entry: current };
}

/**
 * Offline-capable actions on an existing server record (a FixTrack note,
 * "Mark done", an acknowledgement). One unsent entry per target (scopeKey),
 * so a second tap cannot queue the same action twice; `pending(scopeKey)`
 * lets the screen show the target as saved on this phone.
 */
export function useOutboxAction(kind: OfflineActionKind) {
  const snapshot = useCheckOutbox();
  const entries = snapshot.entries.filter((entry) => entry.kind === kind && entry.state !== 'sent');
  const send = useCallback(
    (target: { path: string; scopeKey: string; perEntry?: boolean }, body: Record<string, unknown>, label: string) => {
      const entryId = newCheckEntryId(kind);
      const scopeKey = target.perEntry ? `${target.scopeKey}:${entryId}` : target.scopeKey;
      return sendThroughOutbox({ entryId, kind, path: target.path, scopeKey, label, body });
    },
    [kind],
  );
  const pending = (scopeKey: string) => entries.find((entry) => entry.scopeKey === scopeKey);
  return { entries, readError: snapshot.error, send, pending };
}

/**
 * Sends a record form (fire, legionella, hot tub, PAT, incident, pool, tree) through the
 * persisted check outbox. The body and its entry ID are saved on the device
 * before the first attempt; a lost connection leaves the entry queued and it
 * is resent automatically with the same ID, which the server recognises, so
 * no retry can create a duplicate record.
 *
 * A rejection on the first attempt (invalid data) removes the device entry
 * and reports the error, so the form keeps the data for correcting.
 */
export function useRecordOutbox(kind: RecordKind) {
  const snapshot = useCheckOutbox();
  const entries = snapshot.entries.filter((entry) => entry.kind === kind && entry.state !== 'sent');

  const send = useCallback(async (body: Record<string, unknown>, label: string): Promise<RecordSendResult> => {
    const entryId = newCheckEntryId(kind);
    return sendThroughOutbox({ entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label, body });
  }, [kind]);

  /**
   * Device copies saved by the earlier manual-retry flow (no entry ID) are
   * moved into the outbox once, then delivered like any other entry.
   */
  const adoptLegacy = useCallback(async (draft: UnsentSubmission, discard: (id: string) => Promise<void>) => {
    const entryId = newCheckEntryId(kind);
    const { clientEntryId: _ignored, ...body } = draft.body;
    await checkOutbox.enqueue({ entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label: draft.label, body });
    await discard(draft.id);
    void checkOutbox.replay();
  }, [kind]);

  return { entries, readError: snapshot.error, send, adoptLegacy };
}
