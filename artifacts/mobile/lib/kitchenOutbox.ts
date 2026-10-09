import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useSyncExternalStore } from 'react';
import { apiFetch } from './api';
import { KitchenOutbox } from './kitchenOutboxCore';
import { kitchenDiaryScope } from '@/components/kitchen-diary-scope';
import {
  formValuesFromEntryBody,
  kitchenFormDraftKey,
  loadKitchenDraft,
  notifyKitchenDraftChanged,
  saveKitchenDraft,
  type DraftStorage,
} from '@/components/kitchen-form-drafts';
import { deviceLocalCalendarDate } from '@/components/kitchen-temperature-form-logic';

export const kitchenDraftStorage: DraftStorage = AsyncStorage;

let invalidate: (() => Promise<void>) | null = null;
export const kitchenOutbox = new KitchenOutbox({
  storage: AsyncStorage,
  async send(entry, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      await apiFetch(kitchenDiaryScope(entry.siteId, entry.recordDate).saveUrl(entry.recordId), {
        method: entry.recordId === null ? 'POST' : 'PUT',
        body: JSON.stringify(entry.body),
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  },
  async onSent() { await invalidate?.(); },
});
// This is a deduplication identifier, not a credential or an access capability.
export const newKitchenEntryId = () =>
  `kitchen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
export const useKitchenOutbox = () =>
  useSyncExternalStore(kitchenOutbox.subscribe, kitchenOutbox.getSnapshot, kitchenOutbox.getSnapshot);

export function startKitchenReplay(onSent: () => Promise<void>) {
  invalidate = onSent;
  const timer = setInterval(() => {
    if (AppState.currentState === 'active') void kitchenOutbox.replay();
  }, 15_000);
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'active') void kitchenOutbox.replay();
  });
  return () => {
    clearInterval(timer);
    subscription.remove();
    invalidate = null;
    kitchenOutbox.suspend();
  };
}
/**
 * Turn a rejected device entry back into an editable draft for its diary.
 * The server is asked first whether it already applied the entry for this
 * user (scoped to the entry's site and date); if so nothing is restored. The
 * draft is reviewed against the latest diary and controls before it can be
 * saved, under a new entry identifier.
 */
export async function restoreKitchenEntry(entryId: string) {
  const owner = kitchenOutbox.getSnapshot().owner;
  if (!owner) throw new Error('Sign in to restore saved KitchenTrack entries.');
  const pending = kitchenOutbox.getSnapshot().entries.find(entry => entry.entryId === entryId);
  // The form records today's diary; an older diary may be locked to edits.
  if (pending && pending.recordDate !== deviceLocalCalendarDate(new Date())) {
    throw new Error(`These readings were for ${pending.recordDate}. Only today’s diary can be edited here; if that day’s diary is still open for edits, re-enter them there.`);
  }
  if (pending && await loadKitchenDraft(kitchenDraftStorage, owner, pending.siteId, pending.recordDate)) {
    throw new Error('This diary already has unsaved readings on this device. Save or discard them first.');
  }
  const entry = await kitchenOutbox.restoreToDraft(entryId, async candidate => {
    const params = new URLSearchParams({ recordDate: candidate.recordDate });
    if (candidate.siteId !== null) params.set('siteId', String(candidate.siteId));
    const result = await apiFetch<{ receipted: boolean }>(
      `/api/food-safety/mobile-entries/${encodeURIComponent(candidate.entryId)}?${params}`);
    return result.receipted === true;
  });
  await saveKitchenDraft(kitchenDraftStorage, {
    version: 1, owner: entry.owner, siteId: entry.siteId, recordDate: entry.recordDate,
    values: formValuesFromEntryBody(entry.body), baseline: null, origin: 'restored',
    restoredFrom: entry.entryId, savedAt: new Date().toISOString(),
  });
  notifyKitchenDraftChanged(kitchenFormDraftKey(entry.owner, entry.siteId, entry.recordDate));
  return entry;
}
