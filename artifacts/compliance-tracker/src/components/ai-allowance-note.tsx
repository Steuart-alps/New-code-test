import type { AiStatus } from "@workspace/api-client-react";

function formatResetDate(iso: string | null): string {
  if (!iso) return "when the add-on renews";
  return `on ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" })}`;
}

/**
 * Allowance carried over, given as a share of one month's allowance (the
 * screens never show what the AI costs in pounds): "40% of a month's
 * allowance", "1 month's allowance", "2.5 months' allowance".
 */
export function formatMonthsOfAllowance(percent: number): string {
  if (percent < 100) return `${Math.max(1, percent)}% of a month's allowance`;
  const months = Math.round(percent / 10) / 10;
  return months === 1 ? "1 month's allowance" : `${months} months' allowance`;
}

/**
 * What an AI button's box says about the AI features add-on: how to switch it
 * on, how much of what is available this month (allowance carried over
 * included) is used, or that it is all used up.
 * `canUse` is true when the button may be pressed.
 */
export function aiAllowanceState(ai: AiStatus): { canUse: boolean; note: string } {
  if (!ai.active) {
    return { canUse: false, note: "This needs the AI features add-on (£15 a month + VAT for the whole business), which an owner can switch on in Settings." };
  }
  if (ai.usedUp) {
    return {
      canUse: false,
      note: ai.plan === "trial"
        ? "Your trial's AI allowance is used up. It comes with the AI features add-on once you subscribe."
        : ai.plan === "included"
        ? `The AI allowance is used up, including any carried over. More is added ${formatResetDate(ai.resetsAt)}, or an owner can agree to a top-up in Settings.`
        : `The AI allowance is used up, including any carried over. More is added ${formatResetDate(ai.resetsAt)}, or an owner can buy a top-up in Settings.`,
    };
  }
  // Steuart, 2026-10-27: warn everyone once 75% is used.
  const nearlyUsed = ai.percentUsed >= 75 ? ", so it's nearly used up" : "";
  return { canUse: true, note: `${ai.percentUsed}% of ${ai.plan === "trial" ? "your trial's AI allowance" : "the AI allowance available this month"} used${nearlyUsed}.` };
}

/** One line under an AI button, with a link to Settings when the add-on is off or used up. */
export function AiAllowanceNote({ ai }: { ai: AiStatus }) {
  const { note } = aiAllowanceState(ai);
  return (
    <span className="text-xs text-muted-foreground" data-testid="ai-allowance-note">
      {note}
      {(!ai.active || (ai.usedUp && (ai.plan === "addon" || ai.plan === "included"))) && <> <a href="/settings#ai" className="font-semibold underline underline-offset-2">Open Settings</a></>}
    </span>
  );
}
