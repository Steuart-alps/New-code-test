import type { AddonPaymentResult, PerSitePrice } from "./billing";

interface SubscriptionItemLike {
  id: string;
  current_period_start?: number | null;
  quantity?: number | null;
  price?: {
    id?: string;
    unit_amount?: number | null;
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
  | { status: "activated"; entitled: unknown; bundled?: boolean };

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
  /**
   * A flat add-on billed once per business (the AI add-on): quantity 1 and
   * this invoice line, instead of one per site.
   */
  perBusiness?: { description: string };
  /**
   * The per-site cap. When the client's per-site services plus this add-on
   * would reach it, the subscription is moved to the bundle instead, so the
   * advertised cap is never exceeded.
   */
  bundle?: {
    capPence: number;
    serviceKey: string;
    label: string;
    getPrice: () => Promise<PerSitePrice | null>;
    /** A legacy core price without service_key metadata, if any. */
    corePriceId?: string | null;
  };
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

  const quantity = input.perBusiness ? 1 : Math.max(await input.countClientSites(input.clientId), 1);
  const periodStart =
    input.subscription.items.data[0]?.current_period_start ??
    input.subscription.created;

  if (input.bundle) {
    const bundled = await switchToBundleAtCap(input, input.bundle, price, quantity, periodStart);
    if (bundled) return bundled;
  }

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
  const description = input.perBusiness?.description
    ?? `${input.serviceLabel} — 1 month access, ${quantity} site${quantity === 1 ? "" : "s"} (no proration)`;

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
/**
 * Replace the per-site service items with the bundle when adding this service
 * would reach the cap. Returns null (no switch) when the cap is not reached,
 * when an existing item's price is unknown, or when no bundle price exists.
 * The client pays the difference between the cap and what it already pays for
 * this month (no proration), and a failed charge restores the original items.
 */
async function switchToBundleAtCap(
  input: Parameters<typeof activatePaidAddonService>[0],
  bundle: NonNullable<Parameters<typeof activatePaidAddonService>[0]["bundle"]>,
  price: PerSitePrice,
  quantity: number,
  periodStart: number,
): Promise<AddonActivationResult | null> {
  // Per-site service items (core, add-ons); storage and AI are separate products.
  const perSiteItems = input.subscription.items.data.filter((item) => {
    const key = item.price?.metadata?.service_key;
    if (key) return key !== "storage" && key !== "ai";
    return Boolean(bundle.corePriceId) && item.price?.id === bundle.corePriceId;
  });
  if (perSiteItems.some((item) => typeof item.price?.unit_amount !== "number" || !item.price?.id)) return null;
  const currentRate = perSiteItems.reduce((sum, item) => sum + (item.price!.unit_amount as number), 0);
  if (currentRate + price.unitAmount < bundle.capPence) return null;
  const bundlePrice = await bundle.getPrice();
  if (!bundlePrice) return null;

  await input.stripe.subscriptions.update(
    input.subscription.id,
    {
      items: [
        ...perSiteItems.map((item) => ({ id: item.id, deleted: true })),
        { price: bundlePrice.priceId, quantity },
      ],
      proration_behavior: "none",
    },
    { idempotencyKey: `svc-bundle-${input.subscription.id}-${input.service}-${periodStart}` },
  );

  const amount = Math.max(0, bundle.capPence - currentRate) * quantity;
  try {
    if (amount > 0) {
      const payment = await input.collectFirstMonthInvoice(input.stripe, {
        customerId: input.customerId,
        amount,
        currency: bundlePrice.currency,
        description: `${bundle.label} — upgrade for the rest of this month, ${quantity} site${quantity === 1 ? "" : "s"} (no proration)`,
        metadata: {
          addon_service: bundle.serviceKey,
          client_id: String(input.clientId),
          period_start: String(periodStart),
        },
        idempotencyPrefix: `svc-bundle-${input.subscription.id}-${input.service}-${periodStart}`,
      });
      if (payment === "unknown") {
        input.invalidateEntitlements(input.clientId);
        return { status: "payment_unknown" };
      }
      if (payment === "not_collected") throw new Error("Bundle upgrade invoice was not collected");
    }
  } catch (error) {
    try {
      const fresh = await input.findLiveSubscription(input.customerId);
      const added = fresh?.items.data.find((item) => item.price?.metadata?.service_key === bundle.serviceKey);
      if (added) {
        await input.stripe.subscriptions.update(input.subscription.id, {
          items: [
            { id: added.id, deleted: true },
            ...perSiteItems.map((item) => ({ price: item.price!.id, quantity: item.quantity ?? quantity })),
          ],
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
  return { status: "activated", entitled, bundled: true };
}
