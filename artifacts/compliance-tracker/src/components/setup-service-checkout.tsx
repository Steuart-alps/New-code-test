import { CheckCircle2, ClipboardList } from "lucide-react";

/** GET /billing/config `setupService`: the ALPS setup service at checkout. */
export type SetupServiceBilling = { fee: string; requestedAt: string | null; paidAt: string | null } | null | undefined;

/** Offered at a first checkout until it has been paid once. */
export const offerSetupService = (setupService: SetupServiceBilling) => !!setupService && !setupService.paidAt;

/**
 * "Would you like ALPS to set you up?" on the checkout pickers (trial ended
 * page and Settings > Billing). Ticked, the one-off fee joins this first
 * payment as its own line; it is ticked already for a business that asked on
 * the setup page.
 */
export function SetupServiceCheckoutOption({ fee, checked, onChange }: { fee: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label
      className={`flex items-start gap-3 p-3 border-2 cursor-pointer transition-all ${checked ? "border-[#162D42] bg-[#162D42]/5" : "border-border hover:border-primary/40"}`}
      data-testid="checkout-setup-service"
    >
      <input type="checkbox" className="sr-only" checked={checked} onChange={(event) => onChange(event.target.checked)} data-testid="checkbox-checkout-setup-service" />
      <span aria-hidden className={`mt-0.5 w-5 h-5 border-2 flex items-center justify-center flex-shrink-0 transition-all ${checked ? "border-[#162D42] bg-[#162D42]" : "border-border bg-white"}`}>
        {checked && <CheckCircle2 className="w-3 h-3 text-white" />}
      </span>
      <ClipboardList className="mt-0.5 w-4 h-4 flex-shrink-0 text-[#162D42]" />
      <span className="flex-1 min-w-0">
        <span className="block font-medium text-sm text-[#162D42]">Would you like ALPS to set you up?</span>
        <span className="block text-xs text-muted-foreground font-light">
          ALPS enters your sites, team, contractors, checks and lists for you. A one-off {fee}, added to this first payment only.
        </span>
      </span>
      <span className="text-sm font-medium text-muted-foreground flex-shrink-0">+ {fee.replace(/ \+ VAT$/, "")}</span>
    </label>
  );
}
