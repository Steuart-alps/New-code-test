import { useState } from "react";
import { useAuth } from "@/context/auth-context";
import { useLocation } from "wouter";
import { ShieldCheck, ArrowLeft, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion, AnimatePresence } from "framer-motion";
import alpsLogo from "@/assets/alps-logo.png";

type View = "login" | "totp" | "forgot" | "forgot-sent";

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const DEMO_ACCOUNTS = [
  { email: "consultant@demo.complytrack.app", label: "Consultant",           desc: "Manages multiple clients" },
  { email: "admin@demo.complytrack.app",      label: "Client Admin",          desc: "Full account control" },
  { email: "staff@demo.complytrack.app",      label: "Staff Member",          desc: "Day-to-day compliance" },
  { email: "viewer@demo.complytrack.app",     label: "Viewer",               desc: "Read-only access" },
  { email: "maintenance@demo.complytrack.app",label: "Maintenance Manager",  desc: "FixTrack full access" },
] as const;

const DEMO_PASSWORD = "Demo1234!";

export default function LoginPage() {
  const { login, refresh } = useAuth();
  const [, navigate] = useLocation();
  const [view, setView] = useState<View>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [forgotEmail, setForgotEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState<string | null>(null);

  async function tryDemo(demoEmail: string) {
    setDemoLoading(demoEmail);
    setError("");
    try {
      await login(demoEmail, DEMO_PASSWORD);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Demo login failed");
    } finally {
      setDemoLoading(null);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.requires2fa) {
        setView("totp");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleTotp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/auth/2fa/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpCode.replace(/\s/g, "") }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Verification failed");
      // Session is now fully established — reload auth state
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setTotpCode("");
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/auth/forgot-password`, {
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

                  {/* Demo accounts */}
                  <div className="mt-8">
                    <div className="relative flex items-center gap-3 mb-4">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">or try a demo account</span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      {DEMO_ACCOUNTS.map(acct => (
                        <button
                          key={acct.email}
                          type="button"
                          onClick={() => tryDemo(acct.email)}
                          disabled={!!demoLoading}
                          className="flex items-center justify-between w-full px-4 py-2.5 rounded-[2px] border border-border/60 bg-[#F7F2E4]/30 hover:bg-[#F7F2E4]/80 hover:border-[#162D42]/30 transition-all text-left group disabled:opacity-50"
                        >
                          <div>
                            <div className="text-sm font-medium text-[#162D42]">{acct.label}</div>
                            <div className="text-xs text-muted-foreground">{acct.desc}</div>
                          </div>
                          <span className="text-xs text-muted-foreground group-hover:text-[#162D42] transition-colors flex-shrink-0 ml-2">
                            {demoLoading === acct.email ? "Signing in…" : "Try →"}
                          </span>
                        </button>
                      ))}
                    </div>
                    <p className="text-center text-xs text-muted-foreground/50 mt-3">
                      Password for all demo accounts: <span className="font-mono">{DEMO_PASSWORD}</span>
                    </p>
                  </div>
                </motion.div>
              )}

              {view === "totp" && (
                <motion.div
                  key="totp"
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.3 }}
                >
                  <div className="flex justify-center mb-6">
                    <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                      <KeyRound className="w-7 h-7 text-primary" />
                    </div>
                  </div>
                  <h2 className="text-2xl font-display text-[#162D42] mb-2 text-center">Two-factor authentication</h2>
                  <p className="text-sm text-muted-foreground mb-8 text-center font-light">
                    Open your authenticator app and enter the 6-digit code — or use your recovery
                    code if you've lost access to your device.
                  </p>
                  <form onSubmit={handleTotp} className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="totp-code" className="text-[#1A1A1A]">Authentication code</Label>
                      <Input
                        id="totp-code"
                        type="text"
                        placeholder="000 000 or recovery code"
                        value={totpCode}
                        onChange={e => setTotpCode(e.target.value.replace(/[^0-9A-Za-z\s-]/g, "").slice(0, 16))}
                        required
                        autoComplete="one-time-code"
                        autoFocus
                        className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary text-center text-xl tracking-[0.3em] font-mono"
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
                    <Button type="submit" className="w-full h-12 font-medium bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]" disabled={loading || totpCode.replace(/[\s-]/g, "").length < 6}>
                      {loading ? "Verifying..." : "Verify"}
                    </Button>
                    <button
                      type="button"
                      onClick={() => { setError(""); setTotpCode(""); setView("login"); }}
                      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-[#162D42] transition-colors mx-auto"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
                    </button>
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
