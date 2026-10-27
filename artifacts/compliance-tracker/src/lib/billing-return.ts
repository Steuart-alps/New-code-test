import { useEffect, useRef } from "react";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { trackModuleActivation } from "@/lib/analytics";

/**
 * Stripe Checkout sends the payer back to /dashboard?billing=success&clientId=N
 * (or billing=cancel). These helpers bring them back into the business they
 * paid for, rather than the consultant portfolio or the setup wizard, which
 * read as if paying had started a new account.
 */
export type BillingReturn = { status: "success" | "cancel"; clientId: number | null };

export function readBillingReturn(search: string = typeof window === "undefined" ? "" : window.location.search): BillingReturn | null {
  const params = new URLSearchParams(search);
  const status = params.get("billing");
  if (status !== "success" && status !== "cancel") return null;
  const clientId = Number(params.get("clientId"));
  return { status, clientId: Number.isSafeInteger(clientId) && clientId > 0 ? clientId : null };
}

/** The checkout pages remember the modules being bought, for analytics only. */
export function pendingCheckoutKey(clientId: number): string {
  return `complytrack:analytics:pending-checkout:${clientId}`;
}

export function trackCompletedCheckout(clientId: number | null): void {
  if (clientId === null) return;
  try {
    const key = pendingCheckoutKey(clientId);
    const modules = JSON.parse(window.sessionStorage.getItem(key) ?? "[]");
    if (Array.isArray(modules)) {
      modules
        .filter((module): module is string => typeof module === "string")
        .forEach((module) => trackModuleActivation(clientId, module));
    }
    window.sessionStorage.removeItem(key);
  } catch {
    // Tracking cannot interfere with restored paid access.
  }
}

export function forgetPendingCheckout(clientId: number | null): void {
  if (clientId === null) return;
  try {
    window.sessionStorage.removeItem(pendingCheckoutKey(clientId));
  } catch {
    // Storage is only a best-effort analytics deduplication aid.
  }
}

/**
 * On the dashboard after Stripe Checkout: switch a consultant to the business
 * that was paid for, re-check access straight away, say what happened and
 * tidy the address bar so a reload doesn't repeat it.
 */
export function useBillingReturn(): void {
  const { user, activeClientId, setActiveClientId, refresh } = useAuth();
  const { toast } = useToast();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || !user) return;
    const result = readBillingReturn();
    if (!result) return;
    handled.current = true;

    const url = new URL(window.location.href);
    url.searchParams.delete("billing");
    url.searchParams.delete("clientId");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);

    const paidFor = result.clientId ?? activeClientId ?? user.clientId ?? null;
    if (user.role === "consultant" && paidFor !== null && paidFor !== activeClientId) {
      setActiveClientId(paidFor);
    }

    if (result.status === "cancel") {
      forgetPendingCheckout(paidFor);
      return;
    }
    void (async () => {
      try {
        await apiFetch("/billing/refresh-access", { method: "POST" });
      } catch {
        // best-effort: the webhook also clears the lock
      }
      await refresh();
      trackCompletedCheckout(paidFor);
      toast({
        title: "Payment received",
        description: "Your subscription is active. Everything you set up during the trial is still here.",
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
}
