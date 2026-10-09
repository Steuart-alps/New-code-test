/**
 * Classifies a Settings add-on add/remove response so the UI only shows a
 * service as Active when the server confirmed it, and explains every other
 * outcome (declined payment, unavailable price, pending payment, unconfirmed
 * entitlement, API failure) on the row the admin acted on.
 */

export interface ServiceActionResponseBody {
  ok?: unknown;
  entitled?: unknown;
  paymentPending?: unknown;
  error?: unknown;
  missingServicePrices?: unknown;
  duplicateServicePrices?: unknown;
}

export type ServiceActionOutcome =
  | { kind: "confirmed" }
  | { kind: "payment_pending"; message: string }
  | { kind: "unconfirmed"; message: string }
  | { kind: "price_unavailable"; message: string }
  | { kind: "failed"; message: string };

/**
 * The API returns the client's entitlements after an add: `"all"` or the list
 * of service keys. `true` is accepted for older callers.
 */
export function isServiceEntitled(serviceKey: string, entitled: unknown): boolean {
  return entitled === true
    || entitled === "all"
    || (Array.isArray(entitled) && entitled.includes(serviceKey));
}

function listsService(value: unknown, serviceKey: string): boolean {
  return Array.isArray(value) && value.includes(serviceKey);
}

export function classifyServiceActionResponse(
  serviceKey: string,
  serviceLabel: string,
  action: "add" | "remove",
  status: number,
  body: ServiceActionResponseBody | null,
): ServiceActionOutcome {
  const serverError = typeof body?.error === "string" && body.error.length > 0 ? body.error : null;
  if (status < 200 || status >= 300) {
    if (
      action === "add"
      && (listsService(body?.missingServicePrices, serviceKey) || listsService(body?.duplicateServicePrices, serviceKey))
    ) {
      return {
        kind: "price_unavailable",
        message: `${serviceLabel} can't be added online right now because its price is temporarily unavailable. You have not been charged.`,
      };
    }
    return { kind: "failed", message: serverError ?? `Request failed (${status}). ${serviceLabel} was not changed.` };
  }
  if (!body || typeof body.ok !== "boolean") {
    return {
      kind: "unconfirmed",
      message: `We couldn't confirm the result for ${serviceLabel}. Refresh this page to check before trying again.`,
    };
  }
  if (body.ok !== true) {
    return { kind: "failed", message: serverError ?? `${serviceLabel} was not changed.` };
  }
  if (body.paymentPending === true) {
    return {
      kind: "payment_pending",
      message: `Payment for ${serviceLabel} needs attention in the billing portal before it can be used.`,
    };
  }
  if (action === "add" && !isServiceEntitled(serviceKey, body.entitled)) {
    return {
      kind: "unconfirmed",
      message: `We couldn't confirm ${serviceLabel} is active yet. Refresh in a moment; contact support if it doesn't appear.`,
    };
  }
  return { kind: "confirmed" };
}
