import { useCallback } from 'react';
import { checkOutbox, newCheckEntryId, useCheckOutbox } from '@/lib/checkOutbox';
import { RECORD_PATHS, type CheckEntry, type CheckKind } from '@/lib/checkOutboxCore';
import type { UnsentSubmission } from '@/components/unsent-submission-logic';

type RecordKind = Exclude<CheckKind, 'daily-checklist'>;
export type RecordSendResult =
  | { state: 'sent'; entry: CheckEntry; response: unknown }
  | { state: 'queued'; entry: CheckEntry }
  | { state: 'rejected'; entry: CheckEntry; error: string };

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
    const entry = await checkOutbox.enqueue({
      entryId, kind, path: RECORD_PATHS[kind], scopeKey: `${kind}:${entryId}`, label, body,
    });
    await checkOutbox.replay();
    const current = checkOutbox.getSnapshot().entries.find((row) => row.entryId === entry.entryId) ?? entry;
    if (current.state === 'sent') return { state: 'sent', entry: current, response: checkOutbox.takeResponse(current.entryId) };
    if (current.state === 'failed') {
      await checkOutbox.removeFailed(current.entryId);
      return { state: 'rejected', entry: current, error: current.error ?? 'The server rejected this record.' };
    }
    return { state: 'queued', entry: current };
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
