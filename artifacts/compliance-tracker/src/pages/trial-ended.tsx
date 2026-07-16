import { useEffect, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { CreditCard, LogOut, RefreshCw, Lock } from "lucide-react";

export default function TrialEndedPage() {
  const { user, client, activeClientId, logout, refresh } = useAuth();
  const { toast } = useToast();
  const [checkingOut, setCheckingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const canPay = user?.role === "consultant" || user?.role === "client_admin";

  // Force a fresh server-side check (drops the trial-lock cache and hits
  // Stripe), then re-pull /auth/me so a new subscription unlocks instantly.
  async function recheckAccess() {
    try {
      await apiFetch("/billing/refresh-access", { method: "POST" });
    } catch {
      // Best-effort: refresh() below still re-reads the lock state.
    }
    await refresh();
  }

  // Returning from a successful Stripe checkout: re-check access right away.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") === "success") {
      recheckAccess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCheckout() {
    setCheckingOut(true);
    try {
      const clientId = activeClientId ?? user?.clientId ?? undefined;
      const res = await apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify(clientId ? { clientId } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Could not start checkout");
      }
      window.location.href = data.url;
    } catch (err: any) {
      toast({ title: "Couldn't start checkout", description: err.message, variant: "destructive" });
      setCheckingOut(false);
    }
  }

  async function recheck() {
    setRefreshing(true);
    try {
      await recheckAccess();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <Lock className="h-6 w-6" />
          </div>
          <CardTitle>Your free trial has ended</CardTitle>
          <CardDescription>
            {client?.name ? `The free trial for ${client.name} has expired.` : "Your free trial has expired."}{" "}
            {canPay
              ? "Set up billing to restore full access for your team — access is restored immediately after payment."
              : "Ask your account owner or administrator to set up billing. Access is restored immediately after payment."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {canPay && (
            <Button className="w-full" onClick={startCheckout} disabled={checkingOut}>
              <CreditCard className="mr-2 h-4 w-4" />
              {checkingOut ? "Opening checkout…" : "Set up billing"}
            </Button>
          )}
          <Button variant="outline" className="w-full" onClick={recheck} disabled={refreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Checking…" : "I've subscribed — check again"}
          </Button>
        </CardContent>
        <CardFooter className="justify-center">
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="mr-2 h-4 w-4" /> Log out
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
