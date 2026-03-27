import { useState } from "react";
import { useAuth } from "@/context/auth-context";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
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
            <h2 className="text-xl font-semibold text-foreground mb-6 text-center">Sign in to your account</h2>

            <form onSubmit={handleSubmit} className="space-y-4">
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
                <Label htmlFor="password">Password</Label>
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

              <Button
                type="submit"
                className="w-full h-11 font-semibold"
                disabled={loading}
              >
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Contact your Health & Safety consultant if you need access.
        </p>
      </motion.div>
    </div>
  );
}
