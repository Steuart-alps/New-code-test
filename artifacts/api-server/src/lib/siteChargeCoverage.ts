/**
 * Stripe needs a subscription quantity of at least 1, so a business that
 * subscribes before adding any site already pays for one. The first site it
 * adds afterwards is therefore covered and must not be charged on top; every
 * later site is. (Sites that existed at checkout were counted in its quantity.)
 */
export function isCoveredByMinimumQuantity(input: {
  rowId: number;
  firstRowAfterSubscriptionId: number | null;
  sitesBeforeSubscription: number;
  rowsBeforeSubscription: number;
}): boolean {
  return input.sitesBeforeSubscription === 0
    && input.rowsBeforeSubscription === 0
    && input.firstRowAfterSubscriptionId === input.rowId;
}
