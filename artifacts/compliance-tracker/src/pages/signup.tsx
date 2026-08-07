import { useState } from "react";
import { useLocation } from "wouter";
import {
  ShieldCheck, CheckCircle2, Eye, EyeOff, ArrowLeft, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import alpsLogo from "@/assets/alps-logo.png";

export default function SignupPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [name, setName]                 = useState("");
  const [orgName, setOrgName]           = useState("");
  const [email, setEmail]               = useState("");
  const [password, setPassword]               = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword]       = useState(false);
  const [businessType, setBusinessType] = useState("");
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState("");

  const passwordStrength =
    password.length === 0 ? null :
    password.length < 8   ? "weak" :
    password.length < 12  ? "good" : "strong";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name,
          orgName: orgName.trim() || name,
          email,
          password,
          ...(businessType ? { businessType } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Registration failed.");
      toast({ title: "Account created!", description: "Welcome to ComplyTrack." });
      navigate("/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F2E4] flex flex-col font-sans">
      {/* Header */}
      <div className="p-6 flex items-center justify-between max-w-6xl mx-auto w-full">
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-2 text-muted-foreground hover:text-[#162D42] transition-colors text-sm"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-primary" />
          <span className="font-medium font-display text-xl text-[#162D42]">ComplyTrack</span>
        </div>
        <button
          onClick={() => navigate("/login")}
          className="text-sm font-medium text-muted-foreground hover:text-[#162D42] transition-colors"
        >
          Sign in
        </button>
      </div>

      <div className="flex-1 flex items-start justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="w-full max-w-lg"
        >
          <div className="text-center mb-10">
            <div className="flex justify-center items-center gap-2 mb-6 opacity-70">
              <span className="text-xs font-display italic text-[#162D42]">by</span>
              <img src={alpsLogo} alt="ALPS Consulting" className="h-4 grayscale mix-blend-multiply" />
            </div>
            <h1 className="text-4xl font-display text-[#162D42] mb-3">Start your free trial</h1>
            <p className="text-muted-foreground text-sm font-light">
              14 days, full access. No credit card required.
            </p>
          </div>

          <div className="bg-white rounded-none shadow-xl p-10 space-y-6">
            <form onSubmit={handleSubmit} className="space-y-5">

              <div className="space-y-2">
                <Label htmlFor="name" className="text-[#1A1A1A]">Full name</Label>
                <Input
                  id="name" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Jane Smith" required
                  className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="org-name" className="text-[#1A1A1A]">Organisation name</Label>
                <Input
                  id="org-name" value={orgName} onChange={e => setOrgName(e.target.value)}
                  placeholder="Your company or organisation"
                  className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-[#1A1A1A]">Work email</Label>
                <Input
                  id="email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="jane@yourcompany.com" required
                  className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="business-type" className="text-[#1A1A1A]">Type of business</Label>
                <div className="relative">
                  <select
                    id="business-type"
                    value={businessType}
                    onChange={e => setBusinessType(e.target.value)}
                    className="w-full h-12 pl-4 pr-10 bg-[#F7F2E4]/50 border border-border/50 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary rounded-none text-[#1A1A1A]"
                  >
                    <option value="">Select your business type…</option>
                    <option value="hotel_accommodation">Hotel / Accommodation</option>
                    <option value="holiday_park_campsite">Holiday Park / Campsite</option>
                    <option value="leisure_sports_centre">Leisure / Sports Centre</option>
                    <option value="restaurant_cafe_pub">Restaurant / Café / Pub</option>
                    <option value="care_home_healthcare">Care Home / Healthcare</option>
                    <option value="nursery_school">Nursery / School</option>
                    <option value="offices_commercial">Offices / Commercial</option>
                    <option value="retail">Retail</option>
                    <option value="pest_control">Pest Control</option>
                    <option value="other">Other</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                </div>
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
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-[#162D42]"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {passwordStrength && (
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex gap-1 flex-1">
                      {["weak", "good", "strong"].map((level, i) => (
                        <div key={level} className={`h-1 flex-1 rounded-none transition-all ${
                          passwordStrength === "weak"   && i === 0 ? "bg-red-400"   :
                          passwordStrength === "good"   && i <= 1  ? "bg-amber-400" :
                          passwordStrength === "strong"             ? "bg-green-500" : "bg-muted"
                        }`} />
                      ))}
                    </div>
                    <span className={`text-xs uppercase tracking-wider font-medium ${
                      passwordStrength === "weak"   ? "text-red-500"   :
                      passwordStrength === "good"   ? "text-amber-500" : "text-green-600"
                    }`}>{passwordStrength}</span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password" className="text-[#1A1A1A]">Confirm password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Repeat your password"
                  required
                  autoComplete="new-password"
                  className={`h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary ${
                    confirmPassword && confirmPassword !== password ? "border-red-400 focus-visible:ring-red-400" : ""
                  }`}
                />
                {confirmPassword && confirmPassword !== password && (
                  <p className="text-xs text-red-500">Passwords do not match</p>
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

              <Button
                type="submit"
                className="w-full h-14 text-base font-medium bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]"
                disabled={loading}
              >
                {loading ? "Creating your account…" : "Start free trial"}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                By creating an account you agree to our{" "}
                <button type="button" onClick={() => navigate("/terms")} className="underline underline-offset-2 hover:text-foreground">Terms of Service</button>
                {" "}and{" "}
                <button type="button" onClick={() => navigate("/privacy")} className="underline underline-offset-2 hover:text-foreground">Privacy Policy</button>.
              </p>
            </form>

            <div className="flex flex-col gap-5 pt-6 border-t border-border/50">
              <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground uppercase tracking-wider font-medium flex-wrap">
                {["14-day free trial", "No credit card required", "Cancel anytime"].map(t => (
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
