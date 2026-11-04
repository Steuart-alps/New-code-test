// Test-only replacement for ../src/lib/stripeClient in the storage capacity
// reduction bundle. An in-memory Stripe that keeps subscriptions per customer,
// honours idempotency keys, and can lose or fail a response on demand, so the
// suite never needs or reaches billing credentials.
type Item = {
  id: string;
  quantity: number;
  current_period_start: number;
  current_period_end: number;
  price: { id: string; unit_amount: number; currency: string; metadata: Record<string, string> };
};
type Subscription = { id: string; customer: string; status: string; created: number; items: { data: Item[] } };

const subscriptions = new Map<string, Subscription>();
const idempotent = new Map<string, string>();
export const calls: Array<{ method: string; id: string; params: any; idempotencyKey?: string }> = [];
/** "lose-response": apply, then throw. "fail": throw without applying. */
let nextFault: "lose-response" | "fail" | null = null;
let updateDelayMs = 0;

export function setFault(fault: typeof nextFault): void { nextFault = fault; }
export function setUpdateDelay(ms: number): void { updateDelayMs = ms; }

export function setSubscription(customer: string, items: Array<{ serviceKey: string; quantity: number; unitAmount?: number }>, periodEnd: number): Subscription {
  const id = `sub_${customer}`;
  const subscription: Subscription = {
    id,
    customer,
    status: "active",
    created: periodEnd - 40 * 86400,
    items: {
      data: items.map((item, index) => ({
        id: `si_${customer}_${index}`,
        quantity: item.quantity,
        current_period_start: periodEnd - 30 * 86400,
        current_period_end: periodEnd,
        price: {
          id: `price_${item.serviceKey}`,
          unit_amount: item.unitAmount ?? (item.serviceKey === "storage" ? 25 : 500),
          currency: "gbp",
          metadata: { service_key: item.serviceKey },
        },
      })),
    },
  };
  subscriptions.set(customer, subscription);
  return subscription;
}

export function getSubscription(customer: string): Subscription | undefined {
  return subscriptions.get(customer);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

async function mutate(method: string, id: string, params: any, options: { idempotencyKey?: string } | undefined, apply: () => void) {
  calls.push({ method, id, params: clone(params), idempotencyKey: options?.idempotencyKey });
  if (updateDelayMs) await new Promise((resolve) => setTimeout(resolve, updateDelayMs));
  const fault = nextFault;
  nextFault = null;
  if (fault === "fail") throw new Error("Simulated Stripe failure");
  const key = options?.idempotencyKey;
  const fingerprint = JSON.stringify([method, id, params]);
  if (key && idempotent.has(key)) {
    if (idempotent.get(key) !== fingerprint) throw new Error("Idempotency key reused with different parameters");
  } else {
    apply();
    if (key) idempotent.set(key, fingerprint);
  }
  if (fault === "lose-response") throw new Error("Simulated lost Stripe response");
}

function findItem(itemId: string): { subscription: Subscription; index: number } {
  for (const subscription of subscriptions.values()) {
    const index = subscription.items.data.findIndex((item) => item.id === itemId);
    if (index >= 0) return { subscription, index };
  }
  throw new Error(`No such subscription item: ${itemId}`);
}

const fakeStripe = {
  subscriptions: {
    list: async ({ customer }: { customer: string }) => {
      const subscription = subscriptions.get(customer);
      return { data: subscription ? [clone(subscription)] : [] };
    },
    update: async (id: string, params: any, options?: { idempotencyKey?: string }) => {
      await mutate("subscriptions.update", id, params, options, () => {
        const subscription = [...subscriptions.values()].find((sub) => sub.id === id);
        if (!subscription) throw new Error(`No such subscription: ${id}`);
        for (const change of params.items ?? []) {
          const item = subscription.items.data.find((candidate) => candidate.id === change.id);
          if (!item) throw new Error(`No such subscription item: ${change.id}`);
          if (change.quantity !== undefined) item.quantity = change.quantity;
        }
      });
      return clone([...subscriptions.values()].find((sub) => sub.id === id));
    },
  },
  subscriptionItems: {
    del: async (id: string, params: any, options?: { idempotencyKey?: string }) => {
      await mutate("subscriptionItems.del", id, params, options, () => {
        const { subscription, index } = findItem(id);
        subscription.items.data.splice(index, 1);
      });
      return { id, deleted: true };
    },
  },
};

export function getStripeCredentialSource(): "env" | null { return null; }
export async function getUncachableStripeClient() { return fakeStripe as any; }
export async function getStripePublishableKey() { return ""; }
export async function getStripeSecretKey() { return ""; }
export async function getStripeSync(): Promise<never> { throw new Error("Stripe sync is not available in this test"); }
