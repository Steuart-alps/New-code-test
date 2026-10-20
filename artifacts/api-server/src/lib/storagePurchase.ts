import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getUncachableStripeClient } from "./stripeClient";
import { collectAddonFirstMonthInvoice, findLiveSubscription } from "./billing";
import { invalidateEntitlements } from "./services";
import {
  evaluateStorageAddonPrice,
  findStoragePriceId,
  rememberStoragePriceCheck,
  type StoragePriceInput,
} from "./storagePricing";
import { logger as defaultLogger } from "./logger";

type Log = Pick<typeof defaultLogger, "error">;

export type StoragePurchaseResult =
  | { ok: true; gibAdded: number; monthlyGib: number; unitAmount: number; currency: string }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Add recurring storage to a client's subscription and collect the first
 * month at once (no proration), or roll the item back. The one charging path
 * for extra storage: Settings purchases and the automatic top-up both use it.
 * `requestId` makes a retry resume the same Stripe calls instead of charging
 * twice. The price is server-resolved and must be the £1 per 10 GiB price.
 */
export async function addStorageCapacity(input: {
  clientId: number;
  gib: number;
  requestId: string;
  log?: Log;
}): Promise<StoragePurchaseResult> {
  const log = input.log ?? defaultLogger;
  const { clientId, gib } = input;
  const priceId = await findStoragePriceId().catch(() => null);
  if (!priceId) return { ok: false, status: 503, error: "Storage add-on billing is not configured" };

  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId)).limit(1);
  if (!client?.stripeCustomerId) return { ok: false, status: 400, error: "No Stripe customer for this client" };

  const stripe = await getUncachableStripeClient();
  const subscription = await findLiveSubscription(client.stripeCustomerId);
  if (!subscription) return { ok: false, status: 400, error: "No active subscription — subscribe first" };

  const price = await stripe.prices.retrieve(priceId);
  const unitAmount = Number(price.unit_amount);
  const subscriptionCurrency = subscription.items.data.find((item) => item.price?.currency)?.price?.currency;
  if (
    !price.active
    || price.type !== "recurring"
    || price.recurring?.interval !== "month"
    || !subscriptionCurrency
    || price.currency !== subscriptionCurrency
    || !Number.isSafeInteger(unitAmount)
    || unitAmount < 1
  ) {
    return { ok: false, status: 503, error: "Storage add-on price must be an active monthly price in the subscription currency" };
  }

  // Never charge anything but the £1 per 10 GiB the customer was shown, or a
  // price that no longer covers costs; pause purchases and alert instead.
  const priceCheck = evaluateStorageAddonPrice(price as unknown as StoragePriceInput);
  rememberStoragePriceCheck(priceCheck);
  if (priceCheck.status !== "ok") {
    log.error({ clientId, storagePriceCheck: priceCheck }, "Storage add-on purchase refused: price out of line with provider rate");
    return {
      ok: false,
      status: 503,
      error: "Buying extra storage is paused while we update its price. You have not been charged.",
      code: "STORAGE_PRICE_UNDER_REVIEW",
    };
  }
  const existingItem = subscription.items.data.find(
    (item) => item.price?.id === priceId || item.price?.metadata?.service_key === "storage",
  );
  const oldQuantity = existingItem?.quantity ?? 0;
  const desiredQuantity = oldQuantity + gib;
  const periodStart = subscription.items.data[0]?.current_period_start ?? subscription.created;
  const idempotencyPrefix = `storage-add-${subscription.id}-${input.requestId}`;

  await stripe.subscriptions.update(
    subscription.id,
    {
      items: [existingItem
        ? { id: existingItem.id, price: priceId, quantity: desiredQuantity }
        : { price: priceId, quantity: desiredQuantity }],
      proration_behavior: "none",
    },
    { idempotencyKey: `${idempotencyPrefix}-subscription` },
  );

  try {
    const payment = await collectAddonFirstMonthInvoice(stripe, {
      customerId: client.stripeCustomerId,
      amount: unitAmount * gib,
      currency: price.currency,
      description: `Additional storage — ${gib} GB per month`,
      metadata: {
        addon_service: "storage",
        client_id: String(clientId),
        gib_added: String(gib),
        period_start: String(periodStart),
      },
      idempotencyPrefix,
    });
    if (payment === "unknown") {
      invalidateEntitlements(clientId);
      return {
        ok: false,
        status: 502,
        error: "We couldn't confirm the payment outcome. Storage access was kept while Stripe confirms it; please contact support before retrying.",
      };
    }
    if (payment !== "paid") throw new Error("Storage add-on invoice was not collected");
  } catch (error) {
    try {
      const fresh = await findLiveSubscription(client.stripeCustomerId);
      const added = fresh?.items.data.find(
        (item) => item.price?.id === priceId || item.price?.metadata?.service_key === "storage",
      );
      if (added) {
        if (oldQuantity > 0 && existingItem?.price?.id) {
          await stripe.subscriptionItems.update(added.id, {
            price: existingItem.price.id,
            quantity: oldQuantity,
            proration_behavior: "none",
          });
        } else {
          await stripe.subscriptionItems.del(added.id, { proration_behavior: "none" });
        }
      }
    } catch (rollbackError) {
      log.error({ err: rollbackError, clientId }, "Storage add-on rollback failed");
    }
    invalidateEntitlements(clientId);
    log.error({ err: error, clientId }, "Storage add-on payment failed");
    return { ok: false, status: 502, error: "We couldn't complete the storage charge, so the add-on was not enabled. Please try again." };
  }

  invalidateEntitlements(clientId);
  return { ok: true, gibAdded: gib, monthlyGib: desiredQuantity, unitAmount, currency: price.currency };
}
