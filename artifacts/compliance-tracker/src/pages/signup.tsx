import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import {
  ShieldCheck, CheckCircle2, Tag, Eye, EyeOff, ArrowLeft,
  Flame, UtensilsCrossed, Droplets, Wrench, Building2, FolderOpen, BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import alpsLogo from "@/assets/alps-logo.png";

interface PerSitePrice {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
}

const ADDONS = [
  {
    key: "firetrack",
    label: "FireTrack",
    desc: "Digital fire safety logbook — alarm tests, extinguishers, drills, door checks.",
    icon: Flame,
    iconColor: "text-orange-600",
    iconBg: "bg-orange-50",
    activeBorder: "border-orange-500",
    activeBg: "bg-orange-50/60",
  },
  {
    key: "kitchentrack",
    label: "KitchenTrack",
    desc: "Food safety diary — temperature logs, delivery checks, corrective actions.",
    icon: UtensilsCrossed,
    iconColor: "text-amber-600",
    iconBg: "bg-amber-50",
    activeBorder: "border-amber-500",
    activeBg: "bg-amber-50/60",
  },
  {
    key: "legionellatrack",
    label: "LegionellaTrack",
    desc: "Water safety logbook — L8 ACOP & HSG274 checks for Legionella control.",
    icon: Droplets,
    iconColor: "text-sky-600",
    iconBg: "bg-sky-50",
    activeBorder: "border-sky-500",
    activeBg: "bg-sky-50/60",
  },
  {
    key: "fixtrack",
    label: "FixTrack",
    desc: "Staff maintenance issue reporting — log faults, attach photos, track to resolution.",
    icon: Wrench,
    iconColor: "text-orange-700",
    iconBg: "bg-orange-50",
    activeBorder: "border-orange-500",
    activeBg: "bg-orange-50/60",
  },
  {
    key: "safetrack",
    label: "PremisesTrack",
    desc: "Digital premises safety logbook — routine inspections, fault reporting, housekeeping.",
    icon: Building2,
    iconColor: "text-violet-700",
    iconBg: "bg-violet-50",
    activeBorder: "border-violet-500",
    activeBg: "bg-violet-50/60",
  },
  {
    key: "doctrack",
    label: "DocTrack",
    desc: "Centralised document library — risk assessments, SOPs, policies, procedures.",
    icon: FolderOpen,
    iconColor: "text-cyan-700",
    iconBg: "bg-cyan-50",
    activeBorder: "border-cyan-500",
    activeBg: "bg-cyan-50/60",
  },
  {
    key: "traintrack",
    label: "TrainTrack",
    desc: "Staff training records and certificate expiry tracking.",
    icon: BookOpen,
    iconColor: "text-emerald-700",
    iconBg: "bg-emerald-50",
    activeBorder: "border-emerald-500",
    activeBg: "bg-emerald-50/60",
  },
];

export default function SignupPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();

  const [perSite, setPerSite] = useState<PerSitePrice | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [showPromo, setShowPromo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Parse pre-selected modules from URL query string (?modules=firetrack,legionellatrack)
  const [selectedAddons, setSelectedAddons] = useState<Set<string>>(() => {
    const params = new URLSearchParams(search);
    const modules = params.get("modules");
    if (!modules) return new Set();
    return new Set(modules.split(",").filter(k => ADDONS.some(a => a.key === k)));
  });
  const [bundle, setBundle] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}api/billing/plans`)
      .then(r => r.json())
      .then(data => { if (data?.perSite) setPerSite(data.perSite as PerSitePrice); })
      .catch(() => setPerSite(null));
  }, []);

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

  const total = bundle ? 50 : 10 + selectedAddons.size * 10;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const services = Array.from(selectedAddons);
      const registerBody: Record<string, any> = {
        name,
        email,
        password,
        bundle,
        services: services.length > 0 ? services : undefined,
      };
      if (perSite) {
        registerBody.priceId = perSite.priceId;
        if (promoCode.trim()) registerBody.promoCode = promoCode.trim();
      }

      const registerRes = await fetch(`${import.meta.env.BASE_URL}api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(registerBody),
      });
      const registerData = await registerRes.json();
      if (!registerRes.ok) throw new Error(registerData.error ?? "Registration failed.");

      if (registerData.checkoutUrl) {
        window.location.href = registerData.checkoutUrl;
        return;
      }
      toast({ title: "Account created!", description: "Welcome to ComplyTrack." });
      navigate("/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  const passwordStrength =
    password.length === 0 ? null :
    password.length < 8 ? "weak" :
    password.length < 12 ? "good" : "strong";

  return (
    <div className="min-h-screen bg-[#F7F2E4] flex flex-col font-sans">
      {/* Header */}
      <div className="p-6 flex items-center justify-between max-w-6xl mx-auto w-full">
        <button onClick={() => navigate("/")} className="flex items-center gap-2 text-muted-foreground hover:text-[#162D42] transition-colors text-sm">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-primary" />
          <span className="font-medium font-display text-xl text-[#162D42]">ComplyTrack</span>
        </div>
        <button onClick={() => navigate("/login")} className="text-sm font-medium text-muted-foreground hover:text-[#162D42] transition-colors">
          Sign in
        </button>
      </div>

      <div className="flex-1 flex items-start justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="w-full max-w-xl"
        >
          <div className="text-center mb-10">
            <div className="flex justify-center items-center gap-2 mb-6 opacity-70">
              <span className="text-xs font-display italic text-[#162D42]">by</span>
              <img src={alpsLogo} alt="ALPS Consulting" className="h-4 grayscale mix-blend-multiply" />
            </div>
            <h1 className="text-4xl font-display text-[#162D42] mb-3">Create your account</h1>
            <p className="text-muted-foreground text-sm font-light">Start your 14-day free trial. No credit card required.</p>
          </div>

          <div className="bg-white border-none rounded-none shadow-xl p-10 space-y-8">
            <form onSubmit={handleSubmit} className="space-y-6">

              {/* Account details */}
              <div className="space-y-2">
                <Label htmlFor="name" className="text-[#1A1A1A]">Full name</Label>
                <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" required
                  className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-[#1A1A1A]">Email address</Label>
                <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@yourcompany.com" required
                  className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-[#1A1A1A]">Password</Label>
                <div className="relative">
                  <Input
                    id="password" type={showPassword ? "text" : "password"} value={password}
                    onChange={e => setPassword(e.target.value)} placeholder="Min. 8 characters"
                    required minLength={8} autoComplete="new-password"
                    className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary pr-10"
                  />
                  <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-[#162D42]"
                    onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {passwordStrength && (
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex gap-1 flex-1">
                      {["weak", "good", "strong"].map((level, i) => (
                        <div key={level} className={`h-1 flex-1 rounded-none transition-all ${
                          passwordStrength === "weak" && i === 0 ? "bg-red-400" :
                          passwordStrength === "good" && i <= 1 ? "bg-amber-400" :
                          passwordStrength === "strong" ? "bg-green-500" : "bg-muted"
                        }`} />
                      ))}
                    </div>
                    <span className={`text-xs uppercase tracking-wider font-medium ${
                      passwordStrength === "weak" ? "text-red-500" :
                      passwordStrength === "good" ? "text-amber-500" : "text-green-600"
                    }`}>{passwordStrength}</span>
                  </div>
                )}
              </div>

              {/* Service selection */}
              <div className="space-y-4 pt-2">
                <div>
                  <h3 className="font-display text-lg text-[#162D42]">Choose your modules</h3>
                  <p className="text-xs text-muted-foreground mt-0.5 font-light">All modules active during your free trial. You'll only pay for what you select.</p>
                </div>

                {/* Core — always included */}
                <div className="flex items-start gap-3 p-4 border-2 border-[#162D42]/20 bg-[#162D42]/5">
                  <div className="mt-0.5 w-5 h-5 bg-[#162D42] flex items-center justify-center flex-shrink-0">
                    <CheckCircle2 className="w-3 h-3 text-white" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-[#162D42]" />
                        <span className="font-medium text-[#162D42]">ComplyTrack Core</span>
                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 uppercase tracking-wide font-medium">Included</span>
                      </div>
                      <span className="font-medium text-sm text-[#162D42]">£10/mo</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 font-light">Compliance checks, contractors, certificates, audit trail.</p>
                  </div>
                </div>

                {/* Add-on modules */}
                {ADDONS.map(addon => {
                  const Icon = addon.icon;
                  const active = selectedAddons.has(addon.key) || bundle;
                  return (
                    <div
                      key={addon.key}
                      onClick={() => !bundle && toggleAddon(addon.key)}
                      className={`flex items-start gap-3 p-4 border-2 cursor-pointer transition-all duration-150 ${
                        bundle ? "opacity-60 cursor-default border-border" :
                        active ? `${addon.activeBorder} ${addon.activeBg}` : "border-border hover:border-primary/40 bg-white"
                      }`}
                    >
                      <div className={`mt-0.5 w-5 h-5 border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                        active ? `border-current bg-current ${addon.iconColor}` : "border-border bg-white"
                      }`}>
                        {active && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Icon className={`w-4 h-4 ${addon.iconColor}`} />
                            <span className="font-medium text-[#162D42]">{addon.label}</span>
                          </div>
                          <span className="font-medium text-sm text-muted-foreground">+ £10/mo</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 font-light">{addon.desc}</p>
                      </div>
                    </div>
                  );
                })}

                {/* Bundle */}
                <div
                  onClick={toggleBundle}
                  className={`flex items-start gap-3 p-4 border-2 cursor-pointer transition-all duration-150 ${
                    bundle ? "border-emerald-500 bg-emerald-50/60" : "border-border hover:border-emerald-400 bg-white"
                  }`}
                >
                  <div className={`mt-0.5 w-5 h-5 border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                    bundle ? "border-emerald-600 bg-emerald-600" : "border-border bg-white"
                  }`}>
                    {bundle && <CheckCircle2 className="w-3 h-3 text-white" />}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-emerald-800">ComplyTrack Complete</span>
                      <span className="font-semibold text-emerald-800 text-sm">£50/mo cap</span>
                    </div>
                    <p className="text-xs text-emerald-700/80 mt-1 font-light">All current and future modules. Best value if you need everything.</p>
                  </div>
                </div>

                {/* Running total */}
                <div className="bg-[#162D42] text-white p-4 flex items-center justify-between">
                  <span className="text-sm font-medium text-white/80">Total per site per month</span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-display">£{total}</span>
                    <span className="text-sm text-white/60">+ VAT</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground font-light text-center">
                  Full access during your 14-day trial regardless of selection. You start with one site.
                </p>
              </div>

              {/* Promo code */}
              <div className="pt-2">
                {!showPromo ? (
                  <button type="button" onClick={() => setShowPromo(true)} className="flex items-center gap-2 text-sm text-primary font-medium hover:underline">
                    <Tag className="w-4 h-4" /> Have a discount code?
                  </button>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="promo" className="flex items-center gap-2 text-[#1A1A1A]">
                      <Tag className="w-4 h-4 text-primary" /> Discount / promo code
                    </Label>
                    <Input
                      id="promo" value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())}
                      placeholder="e.g. LAUNCH50"
                      className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none font-mono tracking-widest text-[#162D42]"
                    />
                    <p className="text-xs text-muted-foreground font-light">Applied automatically at payment.</p>
                  </div>
                )}
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  className="bg-destructive/10 border-l-2 border-destructive text-destructive text-sm px-4 py-3"
                >
                  {error}
                </motion.div>
              )}

              <Button type="submit" className="w-full h-14 text-base font-medium bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]" disabled={loading}>
                {loading ? "Setting up your account..." : "Create account & start free trial"}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                By creating an account you agree to our{" "}
                <button type="button" onClick={() => navigate("/terms")} className="underline underline-offset-2 hover:text-foreground">Terms of Service</button>
                {" "}and{" "}
                <button type="button" onClick={() => navigate("/privacy")} className="underline underline-offset-2 hover:text-foreground">Privacy Policy</button>.
              </p>
            </form>

            <div className="flex flex-col gap-5 pt-8 border-t border-border/50">
              <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground uppercase tracking-wider font-medium flex-wrap">
                {["14-day free trial", "Cancel anytime", "Secure via Stripe"].map(t => (
                  <div key={t} className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary flex-shrink-0" /> {t}
                  </div>
                ))}
              </div>
              <p className="text-center text-sm text-[#1A1A1A]">
                Already have an account?{" "}
                <button onClick={() => navigate("/login")} className="text-primary font-medium hover:underline">Sign in</button>
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
