import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useSyncExternalStore } from 'react';
import { apiFetch } from './api';
import { CheckOutbox, type CheckEntry } from './checkOutboxCore';

let invalidate: ((entry: CheckEntry) => Promise<void>) | null = null;
export const checkOutbox = new CheckOutbox({
  storage: AsyncStorage,
  async send(entry, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      await apiFetch(entry.path, {
        method: 'POST',
        body: JSON.stringify(entry.body),
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  },
  async onSent(entry) { await invalidate?.(entry); },
});
// This is a deduplication identifier, not a credential or an access capability.
export const newCheckEntryId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
export const useCheckOutbox = () =>
  useSyncExternalStore(checkOutbox.subscribe, checkOutbox.getSnapshot, checkOutbox.getSnapshot);

export function startCheckReplay(onSent: (entry: CheckEntry) => Promise<void>) {
  invalidate = onSent;
  const timer = setInterval(() => {
    if (AppState.currentState === 'active') void checkOutbox.replay();
  }, 15_000);
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'active') void checkOutbox.replay();
  });
  return () => {
    clearInterval(timer);
    subscription.remove();
    invalidate = null;
    checkOutbox.suspend();
  };
}
