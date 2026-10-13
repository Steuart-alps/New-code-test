// Test stand-in for lib/checkOutbox.ts: the production CheckOutbox core with
// in-memory device storage, sending through the fixture apiFetch, activated
// for the fixture user (normally lib/auth.tsx activates it after sign-in).
import { useSyncExternalStore } from 'react';
import { CheckOutbox } from '../../lib/checkOutboxCore';
import { apiFetch } from './pat-native.jsx';

const memory = new Map();
export const checkOutbox = new CheckOutbox({
  storage: {
    async getItem(key) { return memory.get(key) ?? null; },
    async setItem(key, value) { memory.set(key, value); },
  },
  send: (entry) => apiFetch(entry.path, { method: 'POST', body: JSON.stringify(entry.body) }),
  async onSent() {},
});
void checkOutbox.activate({ clientId: 23, userId: 5 }, 'test-only-token');
export const newCheckEntryId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const useCheckOutbox = () =>
  useSyncExternalStore(checkOutbox.subscribe, checkOutbox.getSnapshot, checkOutbox.getSnapshot);
