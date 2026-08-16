import { useEffect, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { CreditCard, LogOut, RefreshCw, Lock, CheckCircle2, ShieldCheck, Flame, UtensilsCrossed, Droplets, Wrench, Building2, BookOpen, Waves, TreePine, AlertOctagon, Bike, LifeBuoy, Leaf, PlugZap, Bug, Sunrise, Sunset } from "lucide-react";
import alpsLogo from "@/assets/alps-logo.png";

const ADDONS = [
  {
    key: "firetrack",
    label: "FireTrack",
    desc: "Fire safety logbook",
    icon: Flame,
    iconColor: "text-orange-600",
    activeBorder: "border-orange-400",
    activeBg: "bg-orange-50/60",
  },
  {
    key: "kitchentrack",
    label: "KitchenTrack",
    desc: "Food safety diary",
    icon: UtensilsCrossed,
    iconColor: "text-amber-600",
    activeBorder: "border-amber-400",
    activeBg: "bg-amber-50/60",
  },
  {
    key: "legionellatrack",
    label: "LegionellaTrack",
    desc: "Water safety logbook (L8/HSG274)",
    icon: Droplets,
    iconColor: "text-sky-600",
    activeBorder: "border-sky-400",
    activeBg: "bg-sky-50/60",
  },
  {
    key: "fixtrack",
    label: "FixTrack",
    desc: "Maintenance issue reporting",
    icon: Wrench,
    iconColor: "text-orange-700",
    activeBorder: "border-orange-500",
    activeBg: "bg-orange-50/60",
  },
  {
    key: "premisestrack",
    label: "PremisesTrack",
    desc: "Premises safety logbook",
    icon: Building2,
    iconColor: "text-violet-700",
    activeBorder: "border-violet-500",
    activeBg: "bg-violet-50/60",
  },
  {
    key: "traintrack",
    label: "TrainTrack",
    desc: "Staff training & cert expiry",
    icon: BookOpen,
    iconColor: "text-emerald-700",
    activeBorder: "border-emerald-500",
    activeBg: "bg-emerald-50/60",
  },
  {
    key: "hottubtrack",
    label: "TubTrack",
    desc: "Hot tub & spa pool maintenance (HSG282)",
    icon: Waves,
    iconColor: "text-cyan-600",
    activeBorder: "border-cyan-500",
    activeBg: "bg-cyan-50/60",
  },
  {
    key: "treetrack",
    label: "TreeTrack",
    desc: "Tree inspection logbook (BS 3998)",
    icon: TreePine,
    iconColor: "text-green-700",
    activeBorder: "border-green-500",
    activeBg: "bg-green-50/60",
  },
  {
    key: "incidenttrack",
    label: "IncidentTrack",
    desc: "Accident & incident log with RIDDOR reporting",
    icon: AlertOctagon,
    iconColor: "text-rose-700",
    activeBorder: "border-rose-500",
    activeBg: "bg-rose-50/60",
  },
  {
    key: "biketrack",
    label: "BikeTrack",
    desc: "Bike hire service & maintenance records",
    icon: Bike,
    iconColor: "text-lime-700",
    activeBorder: "border-lime-500",
    activeBg: "bg-lime-50/60",
  },
  {
    key: "pooltrack",
    label: "PoolTrack",
    desc: "Swimming pool water quality logbook (PWTAG)",
    icon: LifeBuoy,
    iconColor: "text-blue-600",
    activeBorder: "border-blue-400",
    activeBg: "bg-blue-50/60",
  },
  {
    key: "greentrack",
    label: "GreenTrack",
    desc: "Grounds & landscaping maintenance records",
    icon: Leaf,
    iconColor: "text-green-600",
    activeBorder: "border-green-400",
    activeBg: "bg-green-50/60",
    comingSoon: true,
  },
  {
    key: "swimtrack",
    label: "SwimTrack",
    desc: "Open water & swimming safety logbook",
    icon: Waves,
    iconColor: "text-teal-600",
    activeBorder: "border-teal-400",
    activeBg: "bg-teal-50/60",
  },
  {
    key: "pattrack",
    label: "PATtrack",
    desc: "Portable appliance testing records",
    icon: PlugZap,
    iconColor: "text-yellow-600",
    activeBorder: "border-yellow-400",
    activeBg: "bg-yellow-50/60",
  },
  {
    key: "pesttrack",
    label: "PestTrack",
    desc: "Pest control monitoring & treatment log",
    icon: Bug,
    iconColor: "text-stone-700",
    activeBorder: "border-stone-500",
    activeBg: "bg-stone-50/60",
  },
  {
    key: "dailytrack_am",
    label: "DailyTrack AM",
    desc: "Opening checks & morning checklists",
    icon: Sunrise,
    iconColor: "text-amber-500",
    activeBorder: "border-amber-400",
    activeBg: "bg-amber-50/60",
  },
  {
    key: "dailytrack_pm",
    label: "DailyTrack PM",
    desc: "Closing checks & evening checklists",
    icon: Sunset,
    iconColor: "text-orange-500",
    activeBorder: "border-orange-400",
    activeBg: "bg-orange-50/60",
  },
];

export default function TrialEndedPage() {
  const { user, client, activeClientId, logout, refresh } = useAuth();
  const { toast } = useToast();
  const [checkingOut, setCheckingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(new Set());
  const [bundle, setBundle] = useState(false);

  const canPay = user?.role === "consultant" || user?.role === "client_admin";
  const total = bundle ? 50 : 10 + selectedAddons.size * 10;

  const toggleAddon = (key: string) => {
    setBundle(false);
    setSelectedAddons(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleBundle = () => {
    if (bundle) {
      setBundle(false);
      setSelectedAddons(new Set());
    } else {
      setBundle(true);
      setSelectedAddons(new Set(ADDONS.map(a => a.key)));
    }
  };

  async function recheckAccess() {
    try {
      await apiFetch("/billing/refresh-access", { method: "POST" });
    } catch {
      // best-effort
    }
    await refresh();
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") === "success") {
      recheckAccess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-tick the modules the account picked on the pricing page at signup.
  useEffect(() => {
    const picked = (client as any)?.selectedServices as string[] | null | undefined;
    if (!picked || picked.length === 0) return;
    if (picked.includes("bundle")) {
      setBundle(true);
      setSelectedAddons(new Set(ADDONS.map(a => a.key)));
    } else {
      const known = new Set(ADDONS.map(a => a.key));
      setSelectedAddons(new Set(picked.filter(k => known.has(k))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client?.id]);

  async function startCheckout() {
    setCheckingOut(true);
    try {
      const clientId = activeClientId ?? user?.clientId ?? undefined;
      const services = Array.from(selectedAddons);

      const res = await apiFetch("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({
          ...(clientId ? { clientId } : {}),
          bundle,
          services: services.length > 0 ? services : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not start checkout");
      window.location.href = data.url;
    } catch (err: any) {
      toast({ title: "Couldn't start checkout", description: err.message, variant: "destructive" });
      setCheckingOut(false);
    }
  }

  async function recheck() {
    setRefreshing(true);
    try { await recheckAccess(); } finally { setRefreshing(false); }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#F7F2E4] px-4 py-12 font-sans">
      <div className="w-full max-w-md bg-white shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 blur-[40px] pointer-events-none" />

        {/* Header */}
        <div className="text-center pt-10 pb-6 px-8 relative z-10">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center bg-[#162D42] text-white">
            <Lock className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-display text-[#162D42] mb-3">Your free trial has ended</h1>
          <p className="text-base leading-relaxed font-light text-muted-foreground">
            {client?.name ? `The trial for ${client.name} has expired. ` : "Your trial has expired. "}
            {canPay
              ? "Choose your modules below and set up billing to restore access immediately."
              : "Ask your account admin to set up billing — access restores immediately after payment."}
          </p>
        </div>

        {/* Module picker */}
        {canPay && (
          <div className="px-6 pb-2 relative z-10 space-y-2">
            {/* Core */}
            <div className="flex items-center gap-3 p-3 border-2 border-[#162D42]/20 bg-[#162D42]/5">
              <div className="w-5 h-5 bg-[#162D42] flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-3 h-3 text-white" />
              </div>
              <ShieldCheck className="w-4 h-4 text-[#162D42]" />
              <div className="flex-1">
                <span className="font-medium text-sm text-[#162D42]">ComplyTrack Core</span>
                <span className="text-xs text-muted-foreground ml-1">(included)</span>
              </div>
              <span className="text-sm font-medium text-[#162D42]">£10/mo</span>
            </div>

            {/* Add-ons */}
            {ADDONS.map(addon => {
              const Icon = addon.icon;
              const isComingSoon = (addon as any).comingSoon === true;
              const active = !isComingSoon && (selectedAddons.has(addon.key) || bundle);
              if (isComingSoon) {
                return (
                  <div
                    key={addon.key}
                    className="flex items-center gap-3 p-3 border-2 border-border opacity-50 cursor-not-allowed"
                  >
                    <div className="w-5 h-5 border-2 border-border bg-white flex-shrink-0" />
                    <Icon className={`w-4 h-4 flex-shrink-0 ${addon.iconColor}`} />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-sm text-[#162D42]">{addon.label}</span>
                      <span className="text-xs text-muted-foreground ml-1.5 font-light">{addon.desc}</span>
                    </div>
                    <span className="text-[10px] font-semibold px-2 py-0.5 border border-border text-muted-foreground tracking-wide uppercase">
                      Coming soon
                    </span>
                  </div>
                );
              }
              return (
                <div
                  key={addon.key}
                  onClick={() => !bundle && toggleAddon(addon.key)}
                  className={`flex items-center gap-3 p-3 border-2 cursor-pointer transition-all ${
                    bundle ? "opacity-60 cursor-default border-border" :
                    active ? `${addon.activeBorder} ${addon.activeBg}` : "border-border hover:border-primary/40"
                  }`}
                >
                  <div className={`w-5 h-5 border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                    active ? `border-current bg-current ${addon.iconColor}` : "border-border bg-white"
                  }`}>
                    {active && <CheckCircle2 className="w-3 h-3 text-white" />}
                  </div>
                  <Icon className={`w-4 h-4 flex-shrink-0 ${addon.iconColor}`} />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm text-[#162D42]">{addon.label}</span>
                    <span className="text-xs text-muted-foreground ml-1.5 font-light">{addon.desc}</span>
                  </div>
                  <span className="text-sm font-medium text-muted-foreground flex-shrink-0">+ £10</span>
                </div>
              );
            })}

            {/* Bundle */}
            <div
              onClick={toggleBundle}
              className={`flex items-center gap-3 p-3 border-2 cursor-pointer transition-all ${
                bundle ? "border-emerald-500 bg-emerald-50/60" : "border-border hover:border-emerald-400"
              }`}
            >
              <div className={`w-5 h-5 border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                bundle ? "border-emerald-600 bg-emerald-600" : "border-border bg-white"
              }`}>
                {bundle && <CheckCircle2 className="w-3 h-3 text-white" />}
              </div>
              <div className="flex-1">
                <span className="font-semibold text-sm text-emerald-800">ComplyTrack Complete</span>
                <span className="text-xs text-emerald-700/70 ml-1.5 font-light">All modules</span>
              </div>
              <span className="text-sm font-semibold text-emerald-800 flex-shrink-0">£50/mo cap</span>
            </div>

            {/* Total */}
            <div className="bg-[#162D42] text-white px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-white/70">Per site per month</span>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-display">£{total}</span>
                <span className="text-xs text-white/50">+ VAT</span>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="px-6 pb-4 pt-4 relative z-10 space-y-3">
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
        </div>

        <div className="px-6 pb-8 pt-2 border-t border-border/50 mt-2 flex justify-center relative z-10">
          <Button variant="ghost" size="sm" onClick={logout} className="text-muted-foreground hover:text-[#162D42]">
            <LogOut className="mr-2 h-4 w-4" /> Log out
          </Button>
        </div>
      </div>

      <div className="mt-8 flex items-center justify-center gap-2 opacity-50">
        <span className="text-sm font-display italic text-[#162D42]">by</span>
        <img src={alpsLogo} alt="ALPS Consulting" className="h-5 grayscale mix-blend-multiply" />
      </div>
    </div>
  );
}
