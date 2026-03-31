import { useState } from "react";
import { useAuth } from "@/context/auth-context";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion, AnimatePresence } from "framer-motion";

type View = "login" | "forgot" | "forgot-sent";

export default function LoginPage() {
  const { login } = useAuth();
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
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md"
      >
        <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
          <div className="bg-primary px-8 py-10 text-center">
            <div className="flex justify-center mb-4">
              <div className="bg-white/20 p-4 rounded-2xl">
                <ShieldCheck className="w-10 h-10 text-white" />
              </div>
            </div>
            <h1 className="text-2xl font-bold text-white font-display">
              Comply<span className="text-white/80">Track</span>
            </h1>
            <p className="text-white/70 text-sm mt-1">Health & Safety Compliance Platform</p>
          </div>

          <div className="px-8 py-8">
            <AnimatePresence mode="wait">
              {view === "login" && (
                <motion.div
                  key="login"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.2 }}
                >
                  <h2 className="text-xl font-semibold text-foreground mb-6 text-center">Sign in to your account</h2>
                  <form onSubmit={handleLogin} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email">Email address</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                        autoComplete="email"
                        className="h-11"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="password">Password</Label>
                        <button
                          type="button"
                          onClick={() => { setError(""); setView("forgot"); }}
                          className="text-xs text-primary hover:underline"
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
                        className="h-11"
                      />
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
                    <Button type="submit" className="w-full h-11 font-semibold" disabled={loading}>
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
                  transition={{ duration: 0.2 }}
                >
                  <button
                    type="button"
                    onClick={() => { setError(""); setView("login"); }}
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-5"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back to sign in
                  </button>
                  <h2 className="text-xl font-semibold text-foreground mb-2">Forgot your password?</h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    Enter your email and we'll send you a link to reset your password.
                  </p>
                  <form onSubmit={handleForgot} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="forgot-email">Email address</Label>
                      <Input
                        id="forgot-email"
                        type="email"
                        placeholder="you@example.com"
                        value={forgotEmail}
                        onChange={e => setForgotEmail(e.target.value)}
                        required
                        autoComplete="email"
                        className="h-11"
                      />
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
                    <Button type="submit" className="w-full h-11 font-semibold" disabled={loading}>
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
                  transition={{ duration: 0.25 }}
                  className="text-center py-4"
                >
                  <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-semibold text-foreground mb-2">Check your email</h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    If an account exists for <strong>{forgotEmail}</strong>, you'll receive a password reset link shortly.
                  </p>
                  <Button
                    variant="outline"
                    className="w-full h-11"
                    onClick={() => { setError(""); setView("login"); }}
                  >
                    Back to sign in
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Contact your Health & Safety consultant if you need access.
        </p>
      </motion.div>
    </div>
  );
}
