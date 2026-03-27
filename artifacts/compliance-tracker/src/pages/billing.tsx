import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Zap, Building2, Crown, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Price = { id: string; unitAmount: number; currency: string; interval: string | null };
type Plan = { id: string; name: string; description: string; metadata: Record<string, string>; prices: Price[] };

const planIcons: Record<string, React.ElementType> = {
  Starter: Zap,
  Professional: Building2,
  Enterprise: Crown,
};

const planColours: Record<string, string> = {
  Starter: "border-blue-200 hover:border-blue-400",
  Professional: "border-primary hover:border-primary ring-2 ring-primary/20",
  Enterprise: "border-purple-200 hover:border-purple-400",
};

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(amount / 100);
}

export default function BillingPage() {
  const { activeClientId } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billing, setBilling] = useState<"month" | "year">("month");
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [subscription, setSubscription] = useState<any>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [plansRes, configRes] = await Promise.all([
        apiFetch("/billing/plans"),
        apiFetch(`/billing/config${activeClientId ? `?clientId=${activeClientId}` : ""}`),
      ]);
      if (plansRes.ok) {
        const { plans: raw } = await plansRes.json();
        setPlans(raw ?? []);
      }
      if (configRes.ok) {
        const { subscription: sub } = await configRes.json();
        setSubscription(sub);
      }
      setLoading(false);
    }
    load();
  }, [activeClientId]);

  async function handleSubscribe(priceId: string) {
    if (!activeClientId) return;
    setSubscribing(priceId);
    try {
      const res = await apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ priceId, clientId: activeClientId }),
      });
      if (res.ok) {
        const { url } = await res.json();
        window.location.href = url;
      }
    } finally {
      setSubscribing(null);
    }
  }

  async function handlePortal() {
    if (!activeClientId) return;
    setPortalLoading(true);
    try {
      const res = await apiFetch(`/billing/portal?clientId=${activeClientId}`, { method: "POST" });
      if (res.ok) {
        const { url } = await res.json();
        window.open(url, "_blank");
      }
    } finally {
      setPortalLoading(false);
    }
  }

  const hasActiveSub = subscription?.status === "active" || subscription?.status === "trialing";
  const subStatus = subscription?.status ?? "trial";

  return (
    <AppLayout title="Billing & Plans">
      <div className="max-w-5xl space-y-8">

        {/* Status bar */}
        {subscription && (
          <div className={cn(
            "flex items-center justify-between p-4 rounded-xl border",
            hasActiveSub ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"
          )}>
            <div className="flex items-center gap-3">
              <CheckCircle2 className={cn("w-5 h-5", hasActiveSub ? "text-green-600" : "text-amber-500")} />
              <div>
                <p className="text-sm font-semibold">
                  {hasActiveSub ? "Active subscription" : "Trial / No active subscription"}
                </p>
                <p className="text-xs text-muted-foreground capitalize">Status: {subStatus.replace("_", " ")}</p>
              </div>
            </div>
            {hasActiveSub && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={handlePortal} disabled={portalLoading}>
                {portalLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
                Manage Subscription
              </Button>
            )}
          </div>
        )}

        {/* Billing toggle */}
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-2xl font-bold text-center">Choose a Plan</h2>
          <p className="text-muted-foreground text-sm text-center">All plans include a 14-day free trial. No credit card required to start.</p>
          <div className="flex items-center bg-muted rounded-lg p-1 gap-1 mt-2">
            <button
              onClick={() => setBilling("month")}
              className={cn("px-4 py-1.5 rounded-md text-sm font-medium transition-all", billing === "month" ? "bg-card shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling("year")}
              className={cn("px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1.5", billing === "year" ? "bg-card shadow text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              Annual
              <Badge className="bg-green-100 text-green-700 text-xs px-1.5 py-0">Save 17%</Badge>
            </button>
          </div>
        </div>

        {/* Plans grid */}
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-7 h-7 animate-spin text-muted-foreground" />
          </div>
        ) : plans.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            No plans available yet. Run the seed-plans script to create them.
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            {plans.map((plan) => {
              const Icon = planIcons[plan.name] ?? Zap;
              const isRecommended = plan.metadata?.recommended === "true";
              const price = plan.prices.find(p => p.interval === billing);
              const features = (plan.metadata?.features ?? "").split(",").filter(Boolean);

              return (
                <div
                  key={plan.id}
                  className={cn(
                    "bg-card border-2 rounded-2xl p-6 flex flex-col gap-5 transition-all",
                    planColours[plan.name] ?? "border-border hover:border-border/80"
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className={cn(
                        "p-2 rounded-xl",
                        plan.name === "Starter" ? "bg-blue-100 text-blue-600" :
                        plan.name === "Professional" ? "bg-primary/10 text-primary" :
                        "bg-purple-100 text-purple-600"
                      )}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <h3 className="font-bold text-lg">{plan.name}</h3>
                    </div>
                    {isRecommended && (
                      <Badge className="bg-primary text-primary-foreground text-xs">Most popular</Badge>
                    )}
                  </div>

                  <div>
                    {price ? (
                      <div className="flex items-end gap-1">
                        <span className="text-3xl font-bold">{formatAmount(price.unitAmount, price.currency)}</span>
                        <span className="text-muted-foreground text-sm mb-1">/{billing === "year" ? "yr" : "mo"}</span>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm italic">Pricing on request</p>
                    )}
                    <p className="text-muted-foreground text-sm mt-1">{plan.description}</p>
                  </div>

                  <ul className="space-y-2 flex-1">
                    {features.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                        {f.trim()}
                      </li>
                    ))}
                  </ul>

                  <Button
                    onClick={() => price && handleSubscribe(price.id)}
                    disabled={!price || !activeClientId || !!subscribing}
                    variant={isRecommended ? "default" : "outline"}
                    className="w-full"
                  >
                    {subscribing === price?.id ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Redirecting…</>
                    ) : hasActiveSub ? "Switch to this plan" : "Start free trial"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {!activeClientId && !loading && (
          <p className="text-center text-sm text-muted-foreground">
            Select a client first to subscribe them to a plan.
          </p>
        )}
      </div>
    </AppLayout>
  );
}
