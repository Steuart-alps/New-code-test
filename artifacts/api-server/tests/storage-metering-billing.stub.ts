// Test-only replacement for ../src/lib/billing as imported by routes/storage.ts
// and lib/storageLimit.ts in the storage-metering bundle. The storage cost
// estimate and the storage limit need a live subscription; this answers from
// an in-memory map instead of calling Stripe, so the suite never needs or
// reaches billing credentials.
type FakeItem = { quantity?: number; price?: { metadata?: Record<string, string> } };
type FakeSubscription = { id: string; items: { data: FakeItem[] } };

const subscriptions = new Map<string, FakeSubscription>();
export const stripeLookups: string[] = [];

export function setTestSubscription(customerId: string, serviceKeys: string[] | null): void {
  if (serviceKeys === null) subscriptions.delete(customerId);
  else subscriptions.set(customerId, {
    id: `sub_test_${customerId}`,
    items: { data: serviceKeys.map((service_key) => ({ price: { metadata: { service_key } } })) },
  });
}

/** Extra storage (GiB) on a fake subscription, like the Stripe storage item's quantity. */
export function setTestStorageGib(customerId: string, gib: number): void {
  const subscription = subscriptions.get(customerId);
  if (!subscription) throw new Error(`No test subscription for ${customerId}`);
  subscription.items.data = subscription.items.data.filter((item) => item.price?.metadata?.service_key !== "storage");
  if (gib > 0) subscription.items.data.push({ quantity: gib, price: { metadata: { service_key: "storage" } } });
}

export async function findLiveSubscription(customerId: string) {
  stripeLookups.push(customerId);
  return subscriptions.get(customerId) ?? null;
}
