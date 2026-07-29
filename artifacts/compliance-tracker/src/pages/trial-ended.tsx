import { useEffect, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { CreditCard, LogOut, RefreshCw, Lock } from "lucide-react";
import alpsLogo from "@/assets/alps-logo.png";

export default function TrialEndedPage() {
  const { user, client, activeClientId, logout, refresh } = useAuth();
  const { toast } = useToast();
  const [checkingOut, setCheckingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [firetrack, setFiretrack] = useState(false);
  const [kitchentrack, setKitchentrack] = useState(false);
  const [bundle, setBundle] = useState(false);

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
      const services = [];
      if (firetrack) services.push("firetrack");
      if (kitchentrack) services.push("kitchentrack");

      const res = await apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ 
          ...(clientId ? { clientId } : {}),
          bundle,
          services: services.length > 0 ? services : undefined
        }),
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#F7F2E4] p-4 font-sans">
      <Card className="w-full max-w-md border-none shadow-xl rounded-none relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-[40px] pointer-events-none" />
        <CardHeader className="text-center pt-10 pb-6 relative z-10">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-none bg-[#162D42] text-white">
            <Lock className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl font-display text-[#162D42]">Your free trial has ended</CardTitle>
          <CardDescription className="text-base mt-3 leading-relaxed font-light text-[#1A1A1A]">
            {client?.name ? `The free trial for ${client.name} has expired.` : "Your free trial has expired."}{" "}
            {canPay
              ? "Set up billing to restore full access for your team — access is restored immediately after payment."
              : "Ask your account owner or administrator to set up billing. Access is restored immediately after payment."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-6 sm:px-10 relative z-10">
          {canPay && (
            <div className="space-y-3 mb-6 bg-white/50 p-4 border border-border">
              <h3 className="font-display text-sm text-[#162D42] font-semibold mb-2">Choose your services</h3>
              <label className="flex items-center justify-between opacity-80 cursor-not-allowed text-sm">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked disabled className="h-4 w-4 rounded accent-primary" />
                  <span>ComplyTrack Core</span>
                </div>
                <span className="font-medium">£10/mo</span>
              </label>

              <label className={`flex items-center justify-between text-sm cursor-pointer ${bundle ? "opacity-50 pointer-events-none" : ""}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={firetrack || bundle} disabled={bundle} onChange={(e) => setFiretrack(e.target.checked)} className="h-4 w-4 rounded accent-primary" />
                  <span>FireTrack</span>
                </div>
                <span className="font-medium">£10/mo</span>
              </label>

              <label className={`flex items-center justify-between text-sm cursor-pointer ${bundle ? "opacity-50 pointer-events-none" : ""}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={kitchentrack || bundle} disabled={bundle} onChange={(e) => setKitchentrack(e.target.checked)} className="h-4 w-4 rounded accent-primary" />
                  <span>KitchenTrack</span>
                </div>
                <span className="font-medium">£10/mo</span>
              </label>

              <div className="border-t border-border pt-3 mt-3">
                <label className="flex items-center justify-between text-sm cursor-pointer text-emerald-800">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={bundle} onChange={(e) => setBundle(e.target.checked)} className="h-4 w-4 rounded accent-emerald-600" />
                    <span className="font-semibold">Complete Bundle</span>
                  </div>
                  <span className="font-semibold">£50/mo</span>
                </label>
              </div>
            </div>
          )}

          {canPay && (
            <Button className="w-full h-12 bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]" onClick={startCheckout} disabled={checkingOut}>
              <CreditCard className="mr-2 h-4 w-4" />
              {checkingOut ? "Opening checkout…" : "Set up billing"}
            </Button>
          )}
          <Button variant="outline" className="w-full h-12 rounded-[2px] border-border/60" onClick={recheck} disabled={refreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Checking…" : "I've subscribed — check again"}
          </Button>
        </CardContent>
        <CardFooter className="justify-center pt-6 pb-8 border-t border-border/50 mt-6 relative z-10">
          <Button variant="ghost" size="sm" onClick={logout} className="text-muted-foreground hover:text-[#162D42]">
            <LogOut className="mr-2 h-4 w-4" /> Log out
          </Button>
        </CardFooter>
      </Card>
      
      <div className="mt-8 flex items-center justify-center gap-2 opacity-50">
        <span className="text-sm font-display italic text-[#162D42]">by</span>
        <img src={alpsLogo} alt="Alps Consultancy" className="h-5 grayscale invert-0 mix-blend-multiply" />
      </div>
    </div>
  );
}
