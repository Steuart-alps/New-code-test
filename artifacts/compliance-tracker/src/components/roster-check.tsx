import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { onboardingRequest } from "@/lib/onboarding";
import { RosterImportDialog } from "@/components/roster-import-dialog";
import type { TaskRow } from "@/components/task-item";

/** Module key of the monthly staff roster check task (api-server lib/rosterChecks.ts). */
export const ROSTER_CHECK_MODULE = "roster_check";

export const isRosterCheck = (task: Pick<TaskRow, "module">) => task.module === ROSTER_CHECK_MODULE;

/** "November 2026" for a roster check's month. */
export function rosterCheckMonth(occurrenceDate: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${occurrenceDate.slice(0, 10)}T00:00:00Z`));
}

/**
 * "Answer" on the monthly staff roster check: Any changes to the staff
 * roster? No and N/A are recorded straight away; Yes opens the roster upload
 * for the task's site, which records the check when the new roster is saved.
 */
export function RosterCheckButton({ task, clientId, onAnswered, disabled }: {
  task: TaskRow; clientId: number | null; onAnswered: () => void; disabled?: boolean;
}) {
  const { toast } = useToast();
  const [asking, setAsking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState(false);
  const where = task.siteName ?? "the business";

  async function answer(value: "no" | "na") {
    setBusy(true);
    try {
      await onboardingRequest(`/tasks/${task.id}/complete`, clientId, { method: "POST", body: JSON.stringify({ date: task.occurrenceDate, answer: value }) });
      toast({ title: "Roster check done", description: value === "no" ? "No changes to the staff roster." : "Marked as not applicable." });
      setAsking(false);
      onAnswered();
    } catch (err) {
      toast({ title: "Could not record the answer", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" className="shrink-0" disabled={disabled || busy} onClick={() => setAsking(true)} data-testid={`button-roster-check-${task.id}`}>
        Answer
      </Button>
      <Dialog open={asking} onOpenChange={(open) => { if (!busy) setAsking(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Any changes to the staff roster?</DialogTitle>
            <DialogDescription>
              {where}, {rosterCheckMonth(task.occurrenceDate)}. Has anyone started or left since the last check?
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button onClick={() => { setAsking(false); setUploading(true); }} disabled={busy} data-testid="roster-check-yes">
              Yes: upload the updated roster
            </Button>
            <Button variant="outline" onClick={() => void answer("no")} disabled={busy} data-testid="roster-check-no">No changes</Button>
            <Button variant="outline" onClick={() => void answer("na")} disabled={busy} data-testid="roster-check-na">N/A</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            With Yes, anyone missing from the new roster is marked as left (their records are kept) and new starters are added to TrainTrack.
          </p>
        </DialogContent>
      </Dialog>
      {uploading && (
        <RosterImportDialog
          open={uploading}
          // Refresh the task list only once the result has been read: the
          // answered check leaves "My tasks today", and this dialog with it.
          onClose={() => { setUploading(false); if (imported) onAnswered(); }}
          onImported={() => setImported(true)}
          sites={[]}
          fixedSite={task.siteId != null ? { id: task.siteId, name: task.siteName ?? "This site" } : null}
          rosterCheck={{ taskId: task.id, date: task.occurrenceDate }}
        />
      )}
    </>
  );
}
