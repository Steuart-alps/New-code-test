import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, CheckCircle2, Tag, Eye, EyeOff, ArrowLeft, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

interface PerSitePrice {
  priceId: string;
  unitAmount: number;
  currency: string;
  interval: string | null;
}

export default function SignupPage() {
  const [, navigate] = useLocation();
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

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}api/billing/plans`)
      .then(r => r.json())
      .then(data => {
        if (data?.perSite) setPerSite(data.perSite as PerSitePrice);
      })
      .catch(() => setPerSite(null));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // Step 1: Register account
      const registerBody: Record<string, any> = { name, email, password };
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

      // Step 2: Proceed to Stripe checkout if pricing is configured
      if (registerData.checkoutUrl) {
        window.location.href = registerData.checkoutUrl;
        return;
      }
      // No Stripe price configured — go straight to dashboard
      toast({ title: "Account created!", description: "Welcome to ComplyTrack." });
      navigate("/dashboard");
      return;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  const perSitePrice = perSite ? `£${(perSite.unitAmount / 100).toFixed(0)}` : "£10";

  const passwordStrength = password.length === 0 ? null : password.length < 8 ? "weak" : password.length < 12 ? "good" : "strong";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-background to-indigo-50/20 flex flex-col">
      <div className="p-5 flex items-center justify-between max-w-6xl mx-auto w-full">
        <button onClick={() => navigate("/")} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center gap-2">
          <div className="bg-primary p-1.5 rounded-lg">
            <ShieldCheck className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold font-display">ComplyTrack</span>
        </div>
        <button onClick={() => navigate("/login")} className="text-sm text-muted-foreground hover:text-foreground">
          Sign in
        </button>
      </div>

      <div className="flex-1 flex items-start justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-xl"
        >
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold font-display mb-2">Create your account</h1>
            <p className="text-muted-foreground text-sm">Start your 14-day free trial. No credit card required.</p>
          </div>

          <div className="bg-card border border-border/50 rounded-2xl shadow-xl p-8 space-y-6">
            <form onSubmit={handleSubmit} className="space-y-5">

              <div className="space-y-1.5">
                <Label htmlFor="name">Full name</Label>
                <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" required className="h-11" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@yourcompany.com" required className="h-11" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="h-11 pr-10"
                  />
                  <button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {passwordStrength && (
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex gap-1 flex-1">
                      {["weak", "good", "strong"].map((level, i) => (
                        <div key={level} className={`h-1 flex-1 rounded-full transition-all ${
                          passwordStrength === "weak" && i === 0 ? "bg-red-400" :
                          passwordStrength === "good" && i <= 1 ? "bg-amber-400" :
                          passwordStrength === "strong" ? "bg-green-500" : "bg-muted"
                        }`} />
                      ))}
                    </div>
                    <span className={`text-xs ${passwordStrength === "weak" ? "text-red-500" : passwordStrength === "good" ? "text-amber-500" : "text-green-600"}`}>
                      {passwordStrength}
                    </span>
                  </div>
                )}
              </div>

              {/* Per-site pricing */}
              <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4">
                <div className="flex items-start gap-3">
                  <div className="bg-primary/10 p-2 rounded-lg">
                    <Building2 className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-bold font-display">{perSitePrice}</span>
                      <span className="text-sm text-muted-foreground">per site / month</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Pay only for the sites you manage. You start with one site — each added site is charged one
                      month's access up front. No proration, no refunds.
                    </p>
                  </div>
                </div>
              </div>

              {/* Promo Code */}
              <div>
                  {!showPromo ? (
                    <button type="button" onClick={() => setShowPromo(true)} className="flex items-center gap-1.5 text-sm text-primary hover:underline">
                      <Tag className="w-3.5 h-3.5" /> Have a discount code?
                    </button>
                  ) : (
                    <div className="space-y-1.5">
                      <Label htmlFor="promo" className="flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5 text-primary" /> Discount / promo code
                      </Label>
                      <Input
                        id="promo"
                        value={promoCode}
                        onChange={e => setPromoCode(e.target.value.toUpperCase())}
                        placeholder="e.g. LAUNCH50"
                        className="h-11 font-mono tracking-wider"
                      />
                      <p className="text-xs text-muted-foreground">Applied automatically when you proceed to payment.</p>
                    </div>
                  )}
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-destructive/10 border border-destructive/20 text-destructive text-sm px-4 py-3 rounded-lg"
                >
                  {error}
                </motion.div>
              )}

              <Button type="submit" className="w-full h-11 font-semibold shadow-lg shadow-primary/20" disabled={loading}>
                {loading ? "Setting up your account..." : "Create account & proceed to payment →"}
              </Button>
            </form>

            <div className="flex flex-col gap-3 pt-2 border-t border-border/50">
              <div className="flex items-center justify-center gap-5 text-xs text-muted-foreground flex-wrap">
                {["14-day free trial", "Cancel anytime", "Secure payments via Stripe"].map(t => (
                  <div key={t} className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" /> {t}
                  </div>
                ))}
              </div>
              <p className="text-center text-sm text-muted-foreground">
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
