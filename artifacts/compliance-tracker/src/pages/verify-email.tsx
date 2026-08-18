import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { CheckCircle2, XCircle, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE } from "@/lib/api";

export default function VerifyEmailPage() {
  const [location, navigate] = useLocation();
  const [state, setState] = useState<"checking" | "success" | "error" | "pending">("checking");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(location.split("?")[1] ?? "");
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
  }, [location]);

  async function resendVerification() {
    if (!email) return;
    setResending(true);
    try {
      await fetch(`${API_BASE}/auth/resend-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } finally {
      setResending(false);
      setResent(true);
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
      text: "We sent a verification link to your email address. Open it to activate your ComplyTrack account.",
    },
    success: {
      icon: <CheckCircle2 className="w-10 h-10 text-green-600" />,
      title: "Email verified",
      text: "Your account is ready. You can now sign in to ComplyTrack.",
    },
    error: {
      icon: <XCircle className="w-10 h-10 text-destructive" />,
      title: "Verification link unavailable",
      text: message,
    },
  }[state];

  return (
    <div className="min-h-screen bg-[#F7F2E4] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white shadow-xl p-10 text-center">
        <ShieldCheck className="w-10 h-10 text-primary mx-auto mb-5" />
        <div className="flex justify-center mb-5">{content.icon}</div>
        <h1 className="text-2xl font-display text-[#162D42] mb-3">{content.title}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed mb-8">{content.text}</p>
        {state === "success" || state === "error" ? (
          <Button className="w-full" onClick={() => navigate("/login")}>Go to sign in</Button>
        ) : (
          <div className="space-y-3">
            {state === "pending" && email && (
              <Button className="w-full" onClick={resendVerification} disabled={resending || resent}>
                {resent ? "Verification email sent" : resending ? "Sending…" : "Resend verification email"}
              </Button>
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