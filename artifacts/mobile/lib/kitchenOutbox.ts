import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useSyncExternalStore } from 'react';
import { apiFetch } from './api';
import { KitchenOutbox } from './kitchenOutboxCore';
import { kitchenDiaryScope } from '@/components/kitchen-diary-scope';

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