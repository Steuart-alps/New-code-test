import { CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Pass all" at the end of a Pass / Fail / N/A form. It answers Pass only on
 * the items nobody has answered yet: anything already marked Fail or N/A
 * stays as it is, so the usual rules (a note or corrective action for each
 * fail, a signature to save) still apply when the form is saved.
 */
export function PassAllButton({ remaining, total, onPassAll, disabled }: {
  /** Items still unanswered. The button hides when there are none. */
  remaining: number;
  total: number;
  onPassAll: () => void;
  disabled?: boolean;
}) {
  if (remaining <= 0) return null;
  const label = remaining >= total ? "Pass all" : `Pass the other ${remaining}`;
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onPassAll}
        disabled={disabled}
        data-testid="button-pass-all"
        className="w-full gap-1.5 border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
      >
        <CheckCheck className="h-3.5 w-3.5" />
        {label}
      </Button>
      <p className="text-[11px] text-muted-foreground text-center">
        {remaining >= total
          ? "Marks every item Pass. Change any that aren't, then save."
          : "Marks the unanswered items Pass. Anything you marked Fail or N/A stays as it is."}
      </p>
    </div>
  );
}
