// Test-only replacement for ../src/lib/stripeClient in the AI add-on bundle.
// An in-memory Stripe holding one subscription per customer, which can add
// and remove items and collect a first-month invoice, so the suite never
// needs or reaches billing credentials.
type Item = {
  id: string;
  quantity: number;
  created?: number;
  current_period_start: number;
  current_period_end: number;
  price: { id: string; unit_amount: number; currency: string; metadata: Record<string, string> };
};
type Subscription = { id: string; customer: string; status: string; created: number; items: { data: Item[] } };

const subscriptions = new Map<string, Subscription>();
const prices = new Map<string, Item["price"]>();
export const calls: Array<{ method: string; id: string; params: any; idempotencyKey?: string }> = [];
let invoiceStatus: "paid" | "open" = "paid";
let nextItem = 1;

export function setInvoiceOutcome(status: "paid" | "open"): void { invoiceStatus = status; }

/** A price the fake Stripe knows, so an item can be added by price id. */
export function definePrice(id: string, unitAmount: number, serviceKey: string): void {
  prices.set(id, { id, unit_amount: unitAmount, currency: "gbp", metadata: { service_key: serviceKey } });
}

export function setSubscription(customer: string, items: Array<{ serviceKey: string; quantity: number }>, periodStart: number, periodEnd: number): Subscription {
  const subscription: Subscription = {
    id: `sub_${customer}`,
    customer,
    status: "active",
    created: periodStart - 40 * 86400,
    items: {
      data: items.map((item) => ({
        id: `si_${nextItem++}`,
        quantity: item.quantity,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        price: prices.get(`price_${item.serviceKey}`) ?? { id: `price_${item.serviceKey}`, unit_amount: 1000, currency: "gbp", metadata: { service_key: item.serviceKey } },
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
function record(method: string, id: string, params: any, options?: { idempotencyKey?: string }) {
  calls.push({ method, id, params: clone(params ?? null), idempotencyKey: options?.idempotencyKey });
}

const invoices = new Map<string, { id: string; status: string; amount: number }>();

const fakeStripe = {
  subscriptions: {
    list: async ({ customer }: { customer: string }) => {
      const subscription = subscriptions.get(customer);
      return { data: subscription ? [clone(subscription)] : [] };
    },
    update: async (id: string, params: any, options?: { idempotencyKey?: string }) => {
      record("subscriptions.update", id, params, options);
      const subscription = [...subscriptions.values()].find((sub) => sub.id === id);
      if (!subscription) throw new Error(`No such subscription: ${id}`);
      const first = subscription.items.data[0];
      for (const change of params.items ?? []) {
        if (change.id) {
          const index = subscription.items.data.findIndex((candidate) => candidate.id === change.id);
          if (index < 0) throw new Error(`No such subscription item: ${change.id}`);
          if (change.deleted) subscription.items.data.splice(index, 1);
          else if (change.quantity !== undefined) subscription.items.data[index].quantity = change.quantity;
        } else {
          const price = prices.get(change.price);
          if (!price) throw new Error(`No such price: ${change.price}`);
          subscription.items.data.push({
            id: `si_${nextItem++}`,
            quantity: change.quantity ?? 1,
            created: Math.floor(Date.now() / 1000),
            current_period_start: first?.current_period_start ?? subscription.created,
            current_period_end: first?.current_period_end ?? subscription.created + 30 * 86400,
            price: clone(price),
          });
        }
      }
      return clone(subscription);
    },
  },
  subscriptionItems: {
    del: async (id: string, params: any, options?: { idempotencyKey?: string }) => {
      record("subscriptionItems.del", id, params, options);
      for (const subscription of subscriptions.values()) {
        const index = subscription.items.data.findIndex((item) => item.id === id);
        if (index >= 0) subscription.items.data.splice(index, 1);
      }
      return { id, deleted: true };
    },
  },
  invoices: {
    create: async (params: any, options?: { idempotencyKey?: string }) => {
      record("invoices.create", "", params, options);
      const id = `in_${invoices.size + 1}`;
      invoices.set(id, { id, status: "draft", amount: 0 });
      return { id, status: "draft" };
    },
    finalizeInvoice: async (id: string) => {
      record("invoices.finalizeInvoice", id, null);
      const invoice = invoices.get(id)!;
      invoice.status = "open";
      return { ...invoice };
    },
    pay: async (id: string, _params: unknown, options?: { idempotencyKey?: string }) => {
      record("invoices.pay", id, null, options);
      const invoice = invoices.get(id)!;
      invoice.status = invoiceStatus;
      return { ...invoice };
    },
    retrieve: async (id: string) => ({ ...invoices.get(id)! }),
    voidInvoice: async (id: string) => {
      record("invoices.voidInvoice", id, null);
      const invoice = invoices.get(id)!;
      invoice.status = "void";
      return { ...invoice };
    },
  },
  invoiceItems: {
    create: async (params: any, options?: { idempotencyKey?: string }) => {
      record("invoiceItems.create", "", params, options);
      const invoice = invoices.get(params.invoice);
      if (invoice) invoice.amount += params.amount;
      return { id: `ii_${calls.length}` };
    },
  },
};

export function getStripeCredentialSource(): "env" | null { return null; }
export async function getUncachableStripeClient() { return fakeStripe as any; }
export async function getStripePublishableKey() { return ""; }
export async function getStripeSecretKey() { return ""; }
export async function getStripeSync(): Promise<never> { throw new Error("Stripe sync is not available in this test"); }
