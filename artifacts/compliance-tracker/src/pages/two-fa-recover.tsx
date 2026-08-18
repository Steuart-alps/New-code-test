import { useState } from "react";
import { useLocation } from "wouter";
import { ShieldOff, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useAuth } from "@/context/auth-context";

const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export default function TwoFaRecoverPage() {
  const { refresh } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/auth/2fa/recover`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, recoveryCode: recoveryCode.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Recovery failed");
      setSuccess(true);
      await refresh();
      // Navigate to dashboard after a short delay so the user sees the success message
      setTimeout(() => navigate("/dashboard"), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Recovery failed");
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
              <ShieldOff className="w-12 h-12 text-primary" />
            </div>
            <h1 className="text-3xl font-display text-white mb-2 relative z-10">
              Account Recovery
            </h1>
            <p className="text-white/60 text-sm relative z-10">
              Use your recovery code to regain access
            </p>
          </div>

          <div className="px-8 py-10">
            {success ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center py-6"
              >
                <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-6">
                  <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-2xl font-display text-[#162D42] mb-3">Access restored</h2>
                <p className="text-sm text-muted-foreground font-light">
                  Two-factor authentication has been disabled. You can re-enable it from your account settings.
                  Redirecting…
                </p>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-[#162D42] transition-colors mb-8"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
                </button>

                <h2 className="text-2xl font-display text-[#162D42] mb-3">Recover account access</h2>
                <p className="text-sm text-muted-foreground mb-8 font-light leading-relaxed">
                  Enter your email, password and the recovery code you saved when you set up two-factor
                  authentication. This will disable 2FA so you can sign in normally and re-enrol with a
                  new device.
                </p>

                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="recover-email" className="text-[#1A1A1A]">Email address</Label>
                    <Input
                      id="recover-email"
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
                    <Label htmlFor="recover-password" className="text-[#1A1A1A]">Password</Label>
                    <Input
                      id="recover-password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="recover-code" className="text-[#1A1A1A]">Recovery code</Label>
                    <Input
                      id="recover-code"
                      type="text"
                      placeholder="XXXX-XXXX-XXXX"
                      value={recoveryCode}
                      onChange={e => setRecoveryCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
                      required
                      autoComplete="off"
                      spellCheck={false}
                      className="h-12 bg-[#F7F2E4]/50 border-border/50 rounded-none focus-visible:ring-primary focus-visible:border-primary font-mono tracking-wider"
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
                  <Button
                    type="submit"
                    className="w-full h-12 font-medium bg-[#162D42] hover:bg-[#162D42]/90 text-white rounded-[2px]"
                    disabled={loading || !email || !password || !recoveryCode}
                  >
                    {loading ? "Verifying…" : "Recover access"}
                  </Button>
                </form>
              </motion.div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
