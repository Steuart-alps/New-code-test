import { useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { newCheckEntryId } from '@/lib/checkOutbox';
import { RECORD_PATHS } from '@/lib/checkOutboxCore';
import { useRecordOutbox } from '@/hooks/useRecordOutbox';
import { useStagedPhotoEvidence, type StagedPhotoEntityType } from '@/hooks/useStagedPhotoEvidence';
import { nextEntryAttempt, type EntryAttempt } from '@/components/client-entry-logic';
import { aquaRecordRoute } from '@/components/aqua-extras-logic';

type AquaRecordKind = 'swim-surveillance' | 'swim-first-aid' | 'swim-incident';

export type AquaSendOutcome =
  | { state: 'sent'; response: unknown }
  | { state: 'queued' }
  | { state: 'rejected'; error: string }
  /** Photos expired before sending; the hook has already told the user. */
  | { state: 'kept' };

/**
 * Sends an AquaTrack surveillance, first-aid or incident record (see
 * aquaRecordRoute): through the check outbox when no photos are required, so
 * it is saved on the device without signal; directly with its staged photos
 * when the account requires them, reusing the entry ID on a resend so a lost
 * response never creates a second record.
 */
export function useAquaRecordSender(kind: AquaRecordKind, entityType: StagedPhotoEntityType, formOpen: boolean) {
  const outbox = useRecordOutbox(kind);
  const photoEvidence = useStagedPhotoEvidence(entityType, formOpen);
  const entryAttempt = useRef<EntryAttempt | null>(null);
  const route = aquaRecordRoute(photoEvidence);

  async function send(payload: Record<string, unknown>, label: string): Promise<AquaSendOutcome> {
    if (route === 'outbox') {
      const outcome = await outbox.send(payload, label);
      if (outcome.state === 'rejected') {
        // Perhaps photos became required: recheck so the form can ask for them.
        photoEvidence.retryRequirements();
        return { state: 'rejected', error: outcome.error };
      }
      return outcome.state === 'sent' ? { state: 'sent', response: outcome.response } : { state: 'queued' };
    }
    const prepared = photoEvidence.preparePayload(payload);
    if (!prepared) return { state: 'kept' };
    const attempt = nextEntryAttempt(entryAttempt.current, prepared, () => newCheckEntryId(kind));
    entryAttempt.current = attempt;
    try {
      const response = await apiFetch(RECORD_PATHS[kind], {
        method: 'POST',
        body: JSON.stringify({ ...prepared, clientEntryId: attempt.id }),
      });
      return { state: 'sent', response };
    } catch (error) {
      // Keeps the draft and valid photos; only unusable receipts are dropped.
      return { state: 'rejected', error: photoEvidence.handleCreateError(error, error instanceof Error && error.message ? error.message : 'Please try again.') };
    }
  }

  /** After a save ('consume': photos were claimed) or a cancel ('cancel'). */
  function reset(photos: 'consume' | 'cancel') {
    entryAttempt.current = null;
    if (photos === 'consume') photoEvidence.consume();
    else photoEvidence.reset();
  }

  return {
    route,
    photoEvidence,
    entries: outbox.entries,
    readError: outbox.readError,
    /** Whether the form may be saved now (photo requirement checked, photos verified). */
    ready: route === 'outbox' ? !photoEvidence.loading && !photoEvidence.uploading : photoEvidence.ready,
    send,
    reset,
  };
}
