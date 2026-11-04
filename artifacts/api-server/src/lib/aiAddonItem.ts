// The AI features add-on on a client's Stripe subscription: one flat monthly
// item per business (never per site), recognised by service_key=ai price
// metadata or by AI_ADDON_PRICE_ID. Kept free of imports so billing code and
// test bundles can use it without pulling in Stripe or the database.

export const AI_SERVICE_KEY = "ai";
export const AI_ADDON_LABEL = "AI features";
/** £15 a month (+VAT), whatever the number of sites. */
export const AI_ADDON_AMOUNT_PENCE = 1500;
export const AI_ADDON_CURRENCY = "gbp";

type SubscriptionItemLike = {
  price?: { id?: string | null; metadata?: Record<string, string> | null } | null;
};

/** Whether a subscription item is the AI features add-on. */
export function isAiSubscriptionItem(item: SubscriptionItemLike): boolean {
  const configured = process.env.AI_ADDON_PRICE_ID?.trim();
  return item.price?.metadata?.service_key === AI_SERVICE_KEY
    || (Boolean(configured) && item.price?.id === configured);
}
