// Test stand-in for lib/checkOutbox.ts: the production CheckOutbox core with
// in-memory device storage (kept across screen remounts), sending through the
// fixture apiFetch. Like lib/auth.tsx, delivered entries refresh the query keys
// from deliveredQueryKeys, and the harness re-activates the outbox for the
// fixture user to model an app restart.
import { useSyncExternalStore } from 'react';
import { CheckOutbox, deliveredQueryKeys } from '../../lib/checkOutboxCore';
import { apiFetch, fixtureUser } from './cleaning-native.jsx';

export const outboxStorage = new Map();
let queryClient = null;
export const setOutboxQueryClient = (client) => { queryClient = client; };
export const checkOutbox = new CheckOutbox({
  storage: {
    async getItem(key) { return outboxStorage.get(key) ?? null; },
    async setItem(key, value) { outboxStorage.set(key, value); },
  },
  send: (entry) => apiFetch(entry.path, { method: 'POST', body: JSON.stringify(entry.body) }),
  async onSent(entry) {
    await Promise.all(deliveredQueryKeys(entry.kind).map((queryKey) => queryClient?.invalidateQueries({ queryKey })));
  },
});
export const activateOutbox = () => checkOutbox.activate({ clientId: fixtureUser.clientId, userId: fixtureUser.id }, 'test-only-token');
void activateOutbox();
export const newCheckEntryId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const useCheckOutbox = () =>
  useSyncExternalStore(checkOutbox.subscribe, checkOutbox.getSnapshot, checkOutbox.getSnapshot);
