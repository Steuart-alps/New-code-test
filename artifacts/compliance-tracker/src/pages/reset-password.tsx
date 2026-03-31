import { useState } from "react";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useLocation } from "wouter";

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
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
            {!token ? (
              <div className="text-center py-4">
                <p className="text-sm text-muted-foreground mb-6">This reset link is invalid or missing a token.</p>
                <Button variant="outline" className="w-full h-11" onClick={() => navigate("/login")}>
                  Back to sign in
                </Button>
              </div>
            ) : done ? (
              <motion.div
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
                <h2 className="text-xl font-semibold text-foreground mb-2">Password updated</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Your password has been reset successfully. You can now sign in with your new password.
                </p>
                <Button className="w-full h-11 font-semibold" onClick={() => navigate("/login")}>
                  Sign in
                </Button>
              </motion.div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-5"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to sign in
                </button>
                <h2 className="text-xl font-semibold text-foreground mb-2">Set a new password</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Choose a new password for your account. It must be at least 8 characters.
                </p>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="new-password">New password</Label>
                    <Input
                      id="new-password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">Confirm new password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      placeholder="••••••••"
                      value={confirm}
                      onChange={e => setConfirm(e.target.value)}
                      required
                      autoComplete="new-password"
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
                    {loading ? "Updating..." : "Update password"}
                  </Button>
                </form>
              </>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Contact your Health & Safety consultant if you need access.
        </p>
      </motion.div>
    </div>
  );
}
