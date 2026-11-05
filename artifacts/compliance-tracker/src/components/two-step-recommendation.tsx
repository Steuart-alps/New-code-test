import { useState } from "react";
import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "@/context/auth-context";

// "Remind me later" hides the prompt for this long, per user on this browser.
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

function snoozeKey(userId: number) {
  return `complytrack:two-step-prompt-snoozed:${userId}`;
}

function snoozedUntil(userId: number): number {
  try {
    return Number(window.localStorage.getItem(snoozeKey(userId))) || 0;
  } catch {
    return 0;
  }
}

/**
 * Dashboard prompt for anyone signed in without two-step sign-in where their
 * business has not made it required (when it is required they are held at
 * setup instead). ComplyTrack holds sensitive records, so we strongly
 * recommend it; Owners are also pointed at the business-wide requirement.
 */
export function TwoStepRecommendation() {
  const { user, twoFactorRequired } = useAuth();
  const [hidden, setHidden] = useState(false);
  if (!user || user.totpEnabled || twoFactorRequired || hidden) return null;
  if (snoozedUntil(user.id) > Date.now()) return null;
  const isOwner = user.role === "consultant" || user.role === "client_admin";

  const remindLater = () => {
    try {
      window.localStorage.setItem(snoozeKey(user.id), String(Date.now() + SNOOZE_MS));
    } catch { /* private window: hidden for this visit only */ }
    setHidden(true);
  };

  return (
    <section
      className="rounded-xl border border-amber-300 bg-amber-50 p-4"
      aria-labelledby="two-step-recommendation-title"
      data-testid="card-two-step-recommendation"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 id="two-step-recommendation-title" className="font-semibold text-sm text-amber-900">
            We strongly recommend turning on two-step sign-in
          </h2>
          <p className="text-xs text-amber-900/80">
            ComplyTrack holds sensitive information, such as staff injury and incident records and people's
            personal details. With two-step sign-in, a code from your phone stops anyone who has guessed or
            stolen your password.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
            <Link
              href="/account-security"
              className="inline-flex items-center rounded-sm bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
              data-testid="link-turn-on-two-step"
            >
              Turn on two-step sign-in
            </Link>
            {isOwner && (
              <Link href="/settings#security" className="text-xs font-medium text-amber-900 underline underline-offset-2">
                Require it for everyone in your business
              </Link>
            )}
            <button
              type="button"
              onClick={remindLater}
              className="text-xs text-amber-900/70 hover:text-amber-900"
              data-testid="button-two-step-remind-later"
            >
              Remind me later
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
