import { useState } from "react";
import { useAuth } from "@/context/auth-context";
import { useLocation } from "wouter";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion, AnimatePresence } from "framer-motion";
import alpsLogo from "@/assets/alps-logo.png";

type View = "login" | "forgot" | "forgot-sent";

export default function LoginPage() {
  const { login } = useAuth();
  const [, navigate] = useLocation();
  const [view, setView] = useState<View>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      if (!res.ok) throw new Error("Something went wrong. Please try again.");
      setView("forgot-sent");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F2E4] flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <div className="bg-white border-none shadow-xl overflow-hidden rounded-none">
          <div className="bg-[#162D42] px-8 py-12 text-center relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 blur-[40px] pointer-events-none" />
            <div className="flex justify-center mb-6 relative z-10">
              <ShieldCheck className="w-12 h-12 text-primary" />
            </div>
            <h1 className="text-3xl font-display text-white mb-2 relative z-10">
              ComplyTrack
            </h1>
            <div className="flex items-center justify-center gap-2 mt-4 relative z-10">
              <span className="text-white/60 text-xs font-display italic">by</span>
              <img src={alpsLogo} alt="Alps Consultancy" className="h-4 opacity-70 brightness-0 invert" />
            </div>
          </div>

          <div className="px-8 py-10">
            <AnimatePresence mode="wait">
              {view === "login" && (
                <motion.div
                  key="login"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.3 }}
                >
                  <h2 className="text-2xl font-display text-[#162D42] mb-8 text-center">Sign in to your account</h2>
                  <form onSubmit={handleLogin} className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="email" className="text-[#1A1A1A]">Email address</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                        autoComplete="email"
                        className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password" className="text-[#1A1A1A]">Password</Label>
                        <button
                          type="button"
                          onClick={() => { setError(""); setView("forgot"); }}
                          className="text-xs text-primary hover:underline transition-all"
                        >
                          Forgot password?
                        </button>
                      </div>
                      <Input
                        id="password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        autoComplete="current-password"
                        className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                      />
                    </div>
                    {error && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-destructive/10 border-l-2 border-destructive text-destructive text-sm px-4 py-3"
                      >
                        {error}
                      </motion.div>
                    )}
                    <Button type="submit" className="w-full h-12 font-medium bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]" disabled={loading}>
                      {loading ? "Signing in..." : "Sign in"}
                    </Button>
                  </form>
                </motion.div>
              )}

              {view === "forgot" && (
                <motion.div
                  key="forgot"
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.3 }}
                >
                  <button
                    type="button"
                    onClick={() => { setError(""); setView("login"); }}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-[#162D42] transition-colors mb-8"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back to sign in
                  </button>
                  <h2 className="text-2xl font-display text-[#162D42] mb-3">Forgot your password?</h2>
                  <p className="text-sm text-muted-foreground mb-8 font-light">
                    Enter your email and we'll send you a link to reset your password.
                  </p>
                  <form onSubmit={handleForgot} className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="forgot-email" className="text-[#1A1A1A]">Email address</Label>
                      <Input
                        id="forgot-email"
                        type="email"
                        placeholder="you@example.com"
                        value={forgotEmail}
                        onChange={e => setForgotEmail(e.target.value)}
                        required
                        autoComplete="email"
                        className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                      />
                    </div>
                    {error && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-destructive/10 border-l-2 border-destructive text-destructive text-sm px-4 py-3"
                      >
                        {error}
                      </motion.div>
                    )}
                    <Button type="submit" className="w-full h-12 font-medium bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]" disabled={loading}>
                      {loading ? "Sending..." : "Send reset link"}
                    </Button>
                  </form>
                </motion.div>
              )}

              {view === "forgot-sent" && (
                <motion.div
                  key="forgot-sent"
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className="text-center py-6"
                >
                  <div className="w-16 h-16 bg-[#F7F2E4] rounded-full flex items-center justify-center mx-auto mb-6">
                    <svg className="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h2 className="text-2xl font-display text-[#162D42] mb-3">Check your email</h2>
                  <p className="text-sm text-muted-foreground mb-8 font-light leading-relaxed">
                    If an account exists for <strong className="text-[#1A1A1A] font-medium">{forgotEmail}</strong>, you'll receive a password reset link shortly.
                  </p>
                  <Button
                    variant="outline"
                    className="w-full h-12 rounded-[2px] border-border/60"
                    onClick={() => { setError(""); setView("login"); }}
                  >
                    Back to sign in
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="text-center mt-8 space-y-3">
          <p className="text-sm text-muted-foreground">
            New to ComplyTrack?{" "}
            <button onClick={() => navigate("/signup")} className="text-primary font-medium hover:underline">
              Create a free account
            </button>
          </p>
          <p className="text-xs text-muted-foreground/60 font-light">
            Or ask your account owner to invite you if your business already uses ComplyTrack.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
