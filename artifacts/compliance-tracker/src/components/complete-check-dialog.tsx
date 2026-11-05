import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
 *
 * A check can also be marked as done in house by a competent person (an
 * annual emergency lighting test, say) instead of by a contractor: their name
 * is kept with the completion and no contractor certificate is chased for it.
 */
/** What the dialog asks for a part check (lib/equipmentParts.ts on the server). */
function partWording(equipmentPart: string | null | undefined) {
  switch (equipmentPart) {
    case "ppe_examination":
      return { doneLabel: "Date it was examined", nextLabel: "Next thorough examination due", order: "The next examination must be after the date it was examined", note: "the date the competent person gave for the next examination" };
    case "rpe_filters":
      return { doneLabel: "Date the new filters were fitted", nextLabel: "Replace-by date of the new filters", order: "The new filters must expire after the date they were fitted", note: "the date on the new filters" };
    case "ppe_replace_by":
      return { doneLabel: "Date it was replaced", nextLabel: "Replace-by date of the new one", order: "The new one must expire after the date it was replaced", note: "the date printed on the new one" };
    default: {
      const word = equipmentPart === "defib_battery" ? "battery" : equipmentPart === "defib_child_pads" ? "child pads" : "pads";
      const battery = word === "battery";
      return {
        doneLabel: `Date the new ${word} ${battery ? "was" : "were"} fitted`,
        nextLabel: `Expiry date of the new ${word}`,
        order: `The new ${word} must expire after the date ${battery ? "it was" : "they were"} fitted`,
        note: `the date printed on the new ${word}`,
      };
    }
  }
}

export function CompleteCheckDialog({
  item,
  onClose,
  onAddCertificate,
}: {
  item: { id: number; title: string; frequencyMonths?: number | null; equipmentPart?: string | null } | null;
  onClose: () => void;
  /** Offered as "Mark done and add certificate"; receives the date done. */
  onAddCertificate?: (completedAt: string) => void;
}) {
  const { updateItemStatus } = useAppMutations();
  const [date, setDate] = useState(localToday());
  const [inHouse, setInHouse] = useState(false);
  const [competentPerson, setCompetentPerson] = useState("");
  // A replaced part (a defibrillator's pads or battery) is next due on the new part's expiry date.
  const [nextExpiry, setNextExpiry] = useState("");
  const isPart = !!item?.equipmentPart;
  const part = partWording(item?.equipmentPart);
  const today = localToday();

  useEffect(() => {
    if (item) {
      setDate(localToday());
      setInHouse(false);
      setCompetentPerson("");
      setNextExpiry("");
    }
  }, [item]);

  const invalid = !/^\d{4}-\d{2}-\d{2}$/.test(date) ? "Enter the date the check was done"
    : date > today ? "The date done cannot be in the future"
    : date < "2000-01-01" ? "Enter a date after 2000"
    : inHouse && !competentPerson.trim() ? "Enter the name of the competent person who did it"
    : isPart && !/^\d{4}-\d{2}-\d{2}$/.test(nextExpiry) ? `Enter the ${part.nextLabel.toLowerCase()}`
    : isPart && nextExpiry <= date ? part.order : null;

  const submit = async (thenCertificate: boolean) => {
    if (!item || invalid) return;
    try {
      await updateItemStatus.mutateAsync({
        id: item.id,
        data: {
          status: "completed", completedAt: date,
          ...(inHouse ? { completedInHouseBy: competentPerson.trim() } : {}),
          ...(isPart ? { nextDueDate: nextExpiry } : {}),
        },
      });
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
          <DialogTitle className="font-display font-bold">Mark as done</DialogTitle>
          <DialogDescription>{item?.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="completed-at">{isPart ? part.doneLabel : "Date the check was done"}</Label>
          <Input id="completed-at" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          {isPart && (
            <>
              <Label htmlFor="next-expiry">{part.nextLabel}</Label>
              <Input id="next-expiry" type="date" value={nextExpiry} min={date} onChange={(e) => setNextExpiry(e.target.value)} />
            </>
          )}
          {invalid ? (
            <p className="text-xs text-destructive">{invalid}</p>
          ) : isPart ? (
            <p className="text-xs text-muted-foreground">Next due {formatDay(nextExpiry)}, {part.note}.</p>
          ) : item?.frequencyMonths ? (
            <p className="text-xs text-muted-foreground">
              Next due {formatDay(addMonthsToDay(date, item.frequencyMonths))} (every {item.frequencyMonths} month{item.frequencyMonths === 1 ? "" : "s"} from the date done).
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">This check does not repeat, so it will stay completed.</p>
          )}
          <div className="space-y-2 rounded-sm border border-border p-3">
            <div className="flex items-start gap-2">
              <Checkbox id="completed-in-house" checked={inHouse} onCheckedChange={(value) => setInHouse(value === true)} className="mt-0.5" />
              <Label htmlFor="completed-in-house" className="font-normal leading-snug">
                Done in house by a competent person, not a contractor
              </Label>
            </div>
            {inHouse && (
              <div className="space-y-1">
                <Label htmlFor="competent-person" className="text-xs">Competent person's name</Label>
                <Input id="competent-person" value={competentPerson} maxLength={200} placeholder="e.g. Sam Patel, maintenance manager"
                  onChange={(e) => setCompetentPerson(e.target.value)} />
                <p className="text-xs text-muted-foreground">No contractor certificate is chased for this one. Add your own test record as a certificate if you have one.</p>
              </div>
            )}
          </div>
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
