import type { AiStatus } from "@workspace/api-client-react";

function formatResetDate(iso: string | null): string {
  if (!iso) return "when the add-on renews";
  return `on ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Europe/London" })}`;
}

/**
 * What an AI button's box says about the AI features add-on: how to switch it
 * on, how much of this month's allowance is used, or that it is used up.
 * `canUse` is true when the button may be pressed.
 */
export function aiAllowanceState(ai: AiStatus): { canUse: boolean; note: string } {
  if (!ai.active) {
    return { canUse: false, note: "This needs the AI features add-on (£25 a month + VAT for the whole business), which an owner can switch on in Settings." };
  }
  if (ai.usedUp) {
    return {
      canUse: false,
      note: ai.plan === "trial"
        ? "Your trial's AI allowance is used up. It comes with the AI features add-on once you subscribe."
        : `This month's AI allowance is used up. It starts again ${formatResetDate(ai.resetsAt)}.`,
    };
  }
  return { canUse: true, note: `${ai.percentUsed}% of ${ai.plan === "trial" ? "your trial's" : "this month's"} AI allowance used.` };
}

/** One line under an AI button, with a link to Settings when the add-on is off. */
export function AiAllowanceNote({ ai }: { ai: AiStatus }) {
  const { note } = aiAllowanceState(ai);
  return (
    <span className="text-xs text-muted-foreground" data-testid="ai-allowance-note">
      {note}
      {!ai.active && <> <a href="/settings#ai" className="font-semibold underline underline-offset-2">Open Settings</a></>}
    </span>
  );
}
