import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ShieldCheck, CheckCircle2, Tag, Eye, EyeOff, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";

interface Plan {
  id: string;
  name: string;
  description: string | null;
  prices: { id: string; unitAmount: number; currency: string; interval: string | null }[];
}

export default function SignupPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPriceId, setSelectedPriceId] = useState<string>("");

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
        const sorted = (data.plans as Plan[]).sort((a, b) => {
          const aPrice = a.prices.find(p => p.interval === "month")?.unitAmount ?? 0;
          const bPrice = b.prices.find(p => p.interval === "month")?.unitAmount ?? 0;
          return aPrice - bPrice;
        });
        setPlans(sorted);
        // Default to Professional (middle tier)
        const professional = sorted.find(p => p.name?.toLowerCase().includes("professional"));
        const defaultPlan = professional ?? sorted[1] ?? sorted[0];
        if (defaultPlan) {
          const monthlyPrice = defaultPlan.prices.find(p => p.interval === "month") ?? defaultPlan.prices[0];
          if (monthlyPrice) setSelectedPriceId(monthlyPrice.id);
        }
      })
      .catch(() => setPlans([]));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, email, password, priceId: selectedPriceId || undefined, promoCode: promoCode.trim() || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Registration failed. Please try again.");
      }

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        toast({ title: "Account created!", description: "Welcome to ComplyTrack." });
        navigate("/");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function formatPrice(plan: Plan) {
    const monthly = plan.prices.find(p => p.interval === "month");
    if (!monthly) return "";
    const amount = monthly.unitAmount / 100;
    return `£${amount}/mo`;
  }

  const passwordStrength = password.length === 0 ? null : password.length < 8 ? "weak" : password.length < 12 ? "good" : "strong";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-background to-indigo-50/20 flex flex-col">
      {/* Top bar */}
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

      {/* Main */}
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

              {/* Name */}
              <div className="space-y-1.5">
                <Label htmlFor="name">Full name</Label>
                <Input id="name" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" required className="h-11" />
              </div>

              {/* Email */}
              <div className="space-y-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="jane@yourcompany.com" required className="h-11" />
              </div>

              {/* Password */}
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
                        <div
                          key={level}
                          className={`h-1 flex-1 rounded-full transition-all ${
                            passwordStrength === "weak" && i === 0 ? "bg-red-400" :
                            passwordStrength === "good" && i <= 1 ? "bg-amber-400" :
                            passwordStrength === "strong" ? "bg-green-500" : "bg-muted"
                          }`}
                        />
                      ))}
                    </div>
                    <span className={`text-xs ${passwordStrength === "weak" ? "text-red-500" : passwordStrength === "good" ? "text-amber-500" : "text-green-600"}`}>
                      {passwordStrength}
                    </span>
                  </div>
                )}
              </div>

              {/* Plan Selection */}
              {plans.length > 0 && (
                <div className="space-y-2">
                  <Label>Choose your plan</Label>
                  <div className="grid grid-cols-1 gap-2">
                    {plans.map(plan => {
                      const monthlyPrice = plan.prices.find(p => p.interval === "month");
                      if (!monthlyPrice) return null;
                      const isSelected = selectedPriceId === monthlyPrice.id;
                      return (
                        <button
                          type="button"
                          key={plan.id}
                          onClick={() => setSelectedPriceId(monthlyPrice.id)}
                          className={`text-left p-4 rounded-xl border-2 transition-all ${
                            isSelected ? "border-primary bg-primary/5" : "border-border/50 hover:border-primary/40"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="font-semibold text-sm">{plan.name}</p>
                              {plan.description && <p className="text-xs text-muted-foreground">{plan.description}</p>}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-primary">{formatPrice(plan)}</span>
                              {isSelected && <CheckCircle2 className="w-4 h-4 text-primary" />}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Promo Code */}
              <div>
                {!showPromo ? (
                  <button
                    type="button"
                    onClick={() => setShowPromo(true)}
                    className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                  >
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

              {/* Error */}
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
                {loading ? "Creating your account..." : selectedPriceId ? "Create account & choose payment →" : "Create free account"}
              </Button>
            </form>

            <div className="flex flex-col gap-3 pt-2 border-t border-border/50">
              <div className="flex items-center justify-center gap-5 text-xs text-muted-foreground">
                {["14-day free trial", "Cancel anytime", "Secure payments via Stripe"].map(t => (
                  <div key={t} className="flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-green-500" /> {t}
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
