// Test-only replacement for ../src/lib/billing as imported by routes/storage.ts
// in the storage-metering bundle. The storage cost estimate needs a live
// subscription; this answers from an in-memory map instead of calling Stripe,
// so the suite never needs or reaches billing credentials.
type FakeSubscription = { items: { data: Array<{ price?: { metadata?: Record<string, string> } }> } };

const subscriptions = new Map<string, FakeSubscription>();
export const stripeLookups: string[] = [];

export function setTestSubscription(customerId: string, serviceKeys: string[] | null): void {
  if (serviceKeys === null) subscriptions.delete(customerId);
  else subscriptions.set(customerId, { items: { data: serviceKeys.map((service_key) => ({ price: { metadata: { service_key } } })) } });
}

export async function findLiveSubscription(customerId: string) {
  stripeLookups.push(customerId);
  return subscriptions.get(customerId) ?? null;
}
