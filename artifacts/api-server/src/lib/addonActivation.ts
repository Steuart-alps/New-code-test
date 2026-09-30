import type { AddonPaymentResult, PerSitePrice } from "./billing";

interface SubscriptionItemLike {
  id: string;
  current_period_start?: number | null;
  price?: {
    metadata?: Record<string, string>;
  } | null;
}

interface SubscriptionLike {
  id: string;
  created: number;
  items: { data: SubscriptionItemLike[] };
}

type AddonActivationResult =
  | { status: "unknown_service" }
  | { status: "price_missing" }
  | { status: "already_active" }
  | { status: "payment_unknown" }
  | { status: "charge_failed" }
  | { status: "activated"; entitled: unknown };

/**
 * Apply the paid portion of an add-on activation. Dependencies are injected so
 * the Stripe/update/rollback contract can be exercised without a live account.
 */
export async function activatePaidAddonService(input: {
  allowedServiceKeys: readonly string[];
  service: string;
  serviceLabel: string;
  clientId: number;
  customerId: string;
  subscription: SubscriptionLike;
  stripe: any;
  getServicePrice: (service: string) => Promise<PerSitePrice | null>;
  countClientSites: (clientId: number) => Promise<number>;
  findLiveSubscription: (customerId: string) => Promise<SubscriptionLike | null>;
  collectFirstMonthInvoice: (
    stripe: any,
    invoice: {
      customerId: string;
      amount: number;
      currency: string;
      description: string;
      metadata: Record<string, string>;
      idempotencyPrefix: string;
    },
  ) => Promise<AddonPaymentResult>;
  invalidateEntitlements: (clientId: number) => void;
  getEntitledServices: (clientId: number) => Promise<unknown>;
  onRollbackFailure?: (error: unknown) => void;
  onChargeFailure?: (error: unknown) => void;
}): Promise<AddonActivationResult> {
  if (!input.allowedServiceKeys.includes(input.service)) {
    return { status: "unknown_service" };
  }

  const price = await input.getServicePrice(input.service);
  if (!price) return { status: "price_missing" };

  if (input.subscription.items.data.some(
    (item) => item.price?.metadata?.service_key === input.service,
  )) {
    return { status: "already_active" };
  }

  const quantity = Math.max(await input.countClientSites(input.clientId), 1);
  const periodStart =
    input.subscription.items.data[0]?.current_period_start ??
    input.subscription.created;

  await input.stripe.subscriptions.update(
    input.subscription.id,
    {
      items: [{ price: price.priceId, quantity }],
      proration_behavior: "none",
    },
    {
      idempotencyKey: `svc-add-${input.subscription.id}-${input.service}-${periodStart}`,
    },
  );

  const amount = price.unitAmount * quantity;
  const description = `${input.serviceLabel} — 1 month access, ${quantity} site${quantity === 1 ? "" : "s"} (no proration)`;

  try {
    const payment = await input.collectFirstMonthInvoice(input.stripe, {
      customerId: input.customerId,
      amount,
      currency: price.currency,
      description,
      metadata: {
        addon_service: input.service,
        client_id: String(input.clientId),
        period_start: String(periodStart),
      },
      idempotencyPrefix: `svc-add-${input.subscription.id}-${input.service}-${periodStart}`,
    });
    if (payment === "unknown") {
      // Stripe may have accepted payment but lost both the response and lookup.
      // Preserve access rather than risk charging for a disabled service.
      input.invalidateEntitlements(input.clientId);
      return { status: "payment_unknown" };
    }
    if (payment === "not_collected") {
      throw new Error("Add-on invoice was not collected");
    }
  } catch (error) {
    // A failed or voided first-month invoice must not leave an unpaid service
    // item on the subscription. Re-read Stripe before compensating in case the
    // first update's response was delayed or the subscription changed.
    try {
      const fresh = await input.findLiveSubscription(input.customerId);
      const added = fresh?.items.data.find(
        (item) => item.price?.metadata?.service_key === input.service,
      );
      if (added) {
        await input.stripe.subscriptionItems.del(added.id, {
          proration_behavior: "none",
        });
      }
    } catch (rollbackError) {
      input.onRollbackFailure?.(rollbackError);
    }
    input.invalidateEntitlements(input.clientId);
    input.onChargeFailure?.(error);
    return { status: "charge_failed" };
  }

  input.invalidateEntitlements(input.clientId);
  const entitled = await input.getEntitledServices(input.clientId);
  return { status: "activated", entitled };
}