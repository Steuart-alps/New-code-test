import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppMutations } from "@/hooks/use-app-data";
import { formatDay, localToday } from "@/lib/onboarding";

/** Calendar months after a YYYY-MM-DD date, clamped to the month's last day
 *  (matches the server's next-due calculation). */
function addMonthsToDay(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d!, lastDay));
  return first.toISOString().slice(0, 10);
}

/**
 * Asks for the date a compliance check was actually done (an EICR or gas
 * inspection is often recorded days later). Defaults to today; future dates are
 * refused here and by the server, which judges "today" in the account's
 * timezone. A repeating check is next due its interval after this date.
 */
export function CompleteCheckDialog({
  item,
  onClose,
  onAddCertificate,
}: {
  item: { id: number; title: string; frequencyMonths?: number | null } | null;
  onClose: () => void;
  /** Offered as "Mark done and add certificate"; receives the date done. */
  onAddCertificate?: (completedAt: string) => void;
}) {
  const { updateItemStatus } = useAppMutations();
  const [date, setDate] = useState(localToday());
  const today = localToday();

  useEffect(() => {
    if (item) setDate(localToday());
  }, [item]);

  const invalid = !/^\d{4}-\d{2}-\d{2}$/.test(date) ? "Enter the date the check was done"
    : date > today ? "The date done cannot be in the future"
    : date < "2000-01-01" ? "Enter a date after 2000" : null;

  const submit = async (thenCertificate: boolean) => {
    if (!item || invalid) return;
    try {
      await updateItemStatus.mutateAsync({ id: item.id, data: { status: "completed", completedAt: date } });
      onClose();
      if (thenCertificate) onAddCertificate?.(date);
    } catch {
      /* the mutation hook shows the error */
    }
  };

  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="font-display">Mark as done</DialogTitle>
          <DialogDescription>{item?.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="completed-at">Date the check was done</Label>
          <Input id="completed-at" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          {invalid ? (
            <p className="text-xs text-destructive">{invalid}</p>
          ) : item?.frequencyMonths ? (
            <p className="text-xs text-muted-foreground">
              Next due {formatDay(addMonthsToDay(date, item.frequencyMonths))} (every {item.frequencyMonths} month{item.frequencyMonths === 1 ? "" : "s"} from the date done).
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">This check does not repeat, so it will stay completed.</p>
          )}
          <p className="text-xs text-muted-foreground">
            If the certificate is unsatisfactory or lists defects, add it with its outcome so the remedial work is tracked.
          </p>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
          {onAddCertificate && (
            <Button variant="secondary" type="button" disabled={!!invalid || updateItemStatus.isPending} onClick={() => void submit(true)}>
              Done + add certificate
            </Button>
          )}
          <Button type="button" disabled={!!invalid || updateItemStatus.isPending} onClick={() => void submit(false)}>
            {updateItemStatus.isPending ? "Saving..." : "Mark done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
