import { useState } from "react";
import { Mail } from "lucide-react";
import { useAuth } from "@/context/auth-context";
import { apiFetch } from "@/lib/api";

type ResendState = "idle" | "sending" | "sent" | "limited" | "failed";

// A self-registered Owner can sign in before opening the welcome email's
// link; this reminds them to confirm the address until they do.
export function EmailVerificationBanner() {
  const { user } = useAuth();
  const [resend, setResend] = useState<ResendState>("idle");

  if (!user || user.emailVerified !== false) return null;

  async function sendAgain() {
    if (!user) return;
    setResend("sending");
    try {
      const res = await apiFetch("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: user.email }),
      });
      setResend(res.ok ? "sent" : res.status === 429 ? "limited" : "failed");
    } catch {
      setResend("failed");
    }
  }

  const status = {
    idle: null,
    sending: null,
    sent: "New link sent. It expires in 24 hours.",
    limited: "Too many requests for now. Please try again in an hour.",
    failed: "We couldn't send the link. Please try again.",
  }[resend];

  return (
    <div role="status" className="flex flex-col gap-3 rounded-md border border-sky-300 bg-sky-50 p-4 text-sky-950 sm:flex-row sm:items-center sm:justify-between dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100">
      <div className="flex items-start gap-3">
        <Mail aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="text-sm">
          <strong>Please confirm your email address.</strong>{" "}
          Open the link we sent to {user.email} so reminders and billing emails reach you.
          {status && <span className="block mt-1">{status}</span>}
        </p>
      </div>
      <button
        type="button"
        onClick={sendAgain}
        disabled={resend === "sending" || resend === "sent"}
        className="shrink-0 text-sm font-semibold underline underline-offset-2 disabled:opacity-60 disabled:no-underline"
      >
        {resend === "sending" ? "Sending…" : resend === "sent" ? "Link sent" : "Send the link again"}
      </button>
    </div>
  );
}
