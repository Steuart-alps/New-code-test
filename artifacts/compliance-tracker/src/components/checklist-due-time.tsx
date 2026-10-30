import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Clock } from "lucide-react";
import { getListSitesQueryKey, useSetSiteChecklistDueTimes, type Site } from "@workspace/api-client-react";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/** Used when a site has no due time of its own (api-server lib/checklistDueTimes.ts). */
export const DEFAULT_CHECKLIST_DUE_TIMES = { opening: "06:00", closing: "18:00" } as const;
/** When the reminder goes out if a checklist is still not submitted. */
export const DEFAULT_CHECKLIST_REMINDER_TIMES = { opening: "11:00", closing: "21:00" } as const;

export type ChecklistPeriod = "opening" | "closing";

type SiteDueTimes = Pick<Site, "openingChecksDue" | "closingChecksDue" | "openingReminderAt" | "closingReminderAt">;

/** The site's opening and closing due times ("HH:MM"), defaults filled in. */
export function siteChecklistDueTimes(site: Partial<SiteDueTimes> | null | undefined): Record<ChecklistPeriod, string> {
  return {
    opening: site?.openingChecksDue || DEFAULT_CHECKLIST_DUE_TIMES.opening,
    closing: site?.closingChecksDue || DEFAULT_CHECKLIST_DUE_TIMES.closing,
  };
}

/** When the site's opening and closing reminders go out ("HH:MM"), defaults filled in. */
export function siteChecklistReminderTimes(site: Partial<SiteDueTimes> | null | undefined): Record<ChecklistPeriod, string> {
  return {
    opening: site?.openingReminderAt || DEFAULT_CHECKLIST_REMINDER_TIMES.opening,
    closing: site?.closingReminderAt || DEFAULT_CHECKLIST_REMINDER_TIMES.closing,
  };
}

/** Owners, consultants and Managers set the due times. */
export function useCanSetChecklistDueTimes(): boolean {
  const { user } = useAuth();
  return user?.role === "consultant" || user?.role === "client_admin" || user?.role === "client_manager";
}

/**
 * "Opening checks due by 06:00" for the chosen site, red once today's checks
 * are overdue, with "Change" for Owners and Managers.
 */
export function ChecklistDueTime({ site, period, date, done, className }: {
  site: Site | null | undefined;
  period: ChecklistPeriod;
  /** The day being shown (YYYY-MM-DD); only today can be overdue. */
  date: string;
  /** Every checklist due for the period has been submitted. */
  done: boolean;
  className?: string;
}) {
  const canSet = useCanSetChecklistDueTimes();
  const [editing, setEditing] = useState(false);
  if (!site) return null;
  const due = siteChecklistDueTimes(site)[period];
  const reminder = siteChecklistReminderTimes(site)[period];
  const now = new Date();
  const overdue = !done && date === format(now, "yyyy-MM-dd") && format(now, "HH:mm") >= due;
  const name = period === "opening" ? "Opening" : "Closing";
  return (
    <div className={cn(
      "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm",
      overdue ? "border-rose-300 bg-rose-50 text-rose-800" : "border-border bg-card text-muted-foreground",
      className,
    )}>
      <Clock className={cn("h-4 w-4 shrink-0", overdue ? "text-rose-600" : "text-primary")} />
      <span className="min-w-0 flex-1">
        {overdue
          ? <><strong>Overdue:</strong> {name.toLowerCase()} checks for {site.name} were due by <strong>{due}</strong></>
          : <>{name} checks for {site.name} are due by <strong className="text-foreground">{due}</strong></>}
        <span className="text-xs opacity-80"> · reminder at {reminder} if not done</span>
      </span>
      {canSet && (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(true)}>
          Change
        </Button>
      )}
      {canSet && <ChecklistDueTimesDialog site={site} open={editing} onOpenChange={setEditing} />}
    </div>
  );
}

/** Set when a site's opening and closing checks are due. */
export function ChecklistDueTimesDialog({ site, open, onOpenChange }: {
  site: Site;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const current = siteChecklistDueTimes(site);
  const currentReminder = siteChecklistReminderTimes(site);
  const [opening, setOpening] = useState(current.opening);
  const [closing, setClosing] = useState(current.closing);
  const [openingReminder, setOpeningReminder] = useState(currentReminder.opening);
  const [closingReminder, setClosingReminder] = useState(currentReminder.closing);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const save = useSetSiteChecklistDueTimes();

  const reset = (next: boolean) => {
    if (next) {
      setOpening(current.opening);
      setClosing(current.closing);
      setOpeningReminder(currentReminder.opening);
      setClosingReminder(currentReminder.closing);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    try {
      await save.mutateAsync({
        id: site.id,
        data: {
          openingChecksDue: opening || null, closingChecksDue: closing || null,
          openingReminderAt: openingReminder || null, closingReminderAt: closingReminder || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListSitesQueryKey() });
      toast({ title: "Times saved", description: `${site.name}: opening checks by ${opening || DEFAULT_CHECKLIST_DUE_TIMES.opening}, closing checks by ${closing || DEFAULT_CHECKLIST_DUE_TIMES.closing}.` });
      onOpenChange(false);
    } catch (err) {
      toast({ title: "Could not save the due times", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Check times at {site.name}</DialogTitle>
          <DialogDescription>
            Checks not submitted by their due time show as overdue. If they are still not done at the reminder time,
            the track owner gets a reminder (within the hour). Applies to every opening and closing checklist at this site.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`opening-due-${site.id}`}>Opening checks by</Label>
            <Input id={`opening-due-${site.id}`} type="time" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`closing-due-${site.id}`}>Closing checks by</Label>
            <Input id={`closing-due-${site.id}`} type="time" value={closing} onChange={(e) => setClosing(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`opening-reminder-${site.id}`}>Opening reminder at</Label>
            <Input id={`opening-reminder-${site.id}`} type="time" value={openingReminder} onChange={(e) => setOpeningReminder(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`closing-reminder-${site.id}`}>Closing reminder at</Label>
            <Input id={`closing-reminder-${site.id}`} type="time" value={closingReminder} onChange={(e) => setClosingReminder(e.target.value)} />
          </div>
        </div>
        <Button type="button" variant="link" size="sm" className="h-auto justify-start px-0 text-xs"
          onClick={() => {
            setOpening(DEFAULT_CHECKLIST_DUE_TIMES.opening); setClosing(DEFAULT_CHECKLIST_DUE_TIMES.closing);
            setOpeningReminder(DEFAULT_CHECKLIST_REMINDER_TIMES.opening); setClosingReminder(DEFAULT_CHECKLIST_REMINDER_TIMES.closing);
          }}>
          Use the usual times (due 06:00 and 18:00, reminders 11:00 and 21:00)
        </Button>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => reset(false)}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
