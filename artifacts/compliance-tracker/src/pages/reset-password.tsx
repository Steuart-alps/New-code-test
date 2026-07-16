import { useState } from "react";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useLocation } from "wouter";
import alpsLogo from "@/assets/alps-logo.png";

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
            {!token ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground mb-8 font-light">This reset link is invalid or missing a token.</p>
                <Button variant="outline" className="w-full h-12 rounded-[2px] border-border/60" onClick={() => navigate("/login")}>
                  Back to sign in
                </Button>
              </div>
            ) : done ? (
              <motion.div
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
                <h2 className="text-2xl font-display text-[#162D42] mb-3">Password updated</h2>
                <p className="text-sm text-muted-foreground mb-8 font-light">
                  Your password has been reset successfully. You can now sign in with your new password.
                </p>
                <Button className="w-full h-12 font-medium bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]" onClick={() => navigate("/login")}>
                  Sign in
                </Button>
              </motion.div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-[#162D42] transition-colors mb-8"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to sign in
                </button>
                <h2 className="text-2xl font-display text-[#162D42] mb-3">Set a new password</h2>
                <p className="text-sm text-muted-foreground mb-8 font-light">
                  Choose a new password for your account. It must be at least 8 characters.
                </p>
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="new-password" className="text-[#1A1A1A]">New password</Label>
                    <Input
                      id="new-password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password" className="text-[#1A1A1A]">Confirm new password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      placeholder="••••••••"
                      value={confirm}
                      onChange={e => setConfirm(e.target.value)}
                      required
                      autoComplete="new-password"
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
                    {loading ? "Updating..." : "Update password"}
                  </Button>
                </form>
              </>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground/60 font-light mt-8">
          Ask your account owner to invite you if you need access.
        </p>
      </motion.div>
    </div>
  );
}
