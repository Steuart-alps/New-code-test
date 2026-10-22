import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CheckCircle2, XCircle, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { API_BASE, apiFetch } from "@/lib/api";

type ResendState = "idle" | "sending" | "sent" | "limited" | "failed";

export default function VerifyEmailPage() {
  const [, navigate] = useLocation();
  // wouter's location is the path only; the token and address are in the
  // query string, so read them from useSearch.
  const search = useSearch();
  const [state, setState] = useState<"checking" | "success" | "error" | "pending">("checking");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [resend, setResend] = useState<ResendState>("idle");

  useEffect(() => {
    const params = new URLSearchParams(search);
    const token = params.get("token");
    setEmail(params.get("email") ?? "");
    if (!token) {
      setState("pending");
      return;
    }
    fetch(`${API_BASE}/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "This link is invalid or expired.");
        setState("success");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "This link is invalid or expired.");
        setState("error");
      });
  }, [search]);

  // The server answers the same way whether or not the address has an
  // account, so this page never says which; it only reports rate limits and
  // connection problems.
  async function resendVerification(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setResend("sending");
    try {
      const res = await apiFetch("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setResend(res.ok ? "sent" : res.status === 429 ? "limited" : "failed");
    } catch {
      setResend("failed");
    }
  }

  const content = {
    checking: {
      icon: <Mail className="w-10 h-10 text-primary" />,
      title: "Checking your link…",
      text: "Please wait while we confirm your email address.",
    },
    pending: {
      icon: <Mail className="w-10 h-10 text-primary" />,
      title: "Check your inbox",
      text: "We sent a link to confirm your email address. Your account is ready, so you can sign in now and open the link when it arrives.",
    },
    success: {
      icon: <CheckCircle2 className="w-10 h-10 text-green-600" />,
      title: "Email verified",
      text: "Your account is ready. You can now sign in to ComplyTrack.",
    },
    error: {
      icon: <XCircle className="w-10 h-10 text-destructive" />,
      title: "Verification link unavailable",
      text: `${message} You can ask for a new link below.`,
    },
  }[state];

  const resendStatus = {
    idle: null,
    sending: null,
    sent: "If that address has an account waiting to be verified, we've sent a new link. It expires in 24 hours and replaces any earlier link.",
    limited: "Too many requests for now. Please wait an hour, then try again.",
    failed: "We couldn't send the request. Check your connection and try again.",
  }[resend];

  return (
    <div className="min-h-screen bg-[#F7F2E4] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white shadow-xl p-10 text-center">
        <ShieldCheck className="w-10 h-10 text-primary mx-auto mb-5" />
        <div className="flex justify-center mb-5">{content.icon}</div>
        <h1 className="text-2xl font-display text-[#162D42] mb-3">{content.title}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed mb-8">{content.text}</p>
        {state === "success" ? (
          <Button className="w-full" onClick={() => navigate("/login")}>Go to sign in</Button>
        ) : state === "checking" ? null : (
          <div className="space-y-3 text-left">
            {state === "pending" && (
              <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground space-y-2">
                <p className="font-medium text-foreground">No email?</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>It can take a few minutes to arrive.</li>
                  <li>Check your spam or junk folder.</li>
                  <li>Make sure the address below is the one you signed up with.</li>
                </ul>
                <p>Then send a new link. Your account is already created, so you don't need to sign up again.</p>
              </div>
            )}
            <form onSubmit={resendVerification} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="verify-email-address">Email address</Label>
                <Input
                  id="verify-email-address"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setResend("idle"); }}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={resend === "sending" || resend === "sent" || !email.trim()}>
                {resend === "sent" ? "New link requested" : resend === "sending" ? "Sending…" : "Send a new verification link"}
              </Button>
            </form>
            {resendStatus && (
              <p
                className={`text-sm ${resend === "sent" ? "text-green-700" : "text-destructive"}`}
                role={resend === "sent" ? "status" : "alert"}
              >
                {resendStatus}
              </p>
            )}
            <Link href="/login">
              <Button variant="outline" className="w-full">Back to sign in</Button>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
