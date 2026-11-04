import { useEffect, useId, useRef, useState } from "react";
import { setOverrideReasonHandler, type OverrideReasonRequest } from "@workspace/api-client-react";
import { setApiFetchOverrideReasonHandler } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;

type Pending = OverrideReasonRequest & { resolve: (reason: string | null) => void };

/**
 * Asks an owner why they are changing a record older than its correction
 * window. Registered once for the generated API client and `apiFetch`; the
 * request that needed the reason is resent with it, or fails as before when
 * the dialog is cancelled. Requests that need a reason at the same time are
 * asked about one after another.
 */
export function OverrideReasonDialog() {
  const [current, setCurrent] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const queue = useRef<Pending[]>([]);
  const currentRef = useRef<Pending | null>(null);
  const textareaId = useId();

  useEffect(() => {
    const showNext = () => {
      const next = queue.current.shift() ?? null;
      currentRef.current = next;
      setReason("");
      setCurrent(next);
    };
    let mounted = true;
    const handler = (info: OverrideReasonRequest) => new Promise<string | null>((resolve) => {
      let settled = false;
      const pending: Pending = {
        ...info,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
          if (mounted && currentRef.current === pending) showNext();
        },
      };
      queue.current.push(pending);
      if (!currentRef.current) showNext();
    });
    setOverrideReasonHandler(handler);
    setApiFetchOverrideReasonHandler(handler);
    return () => {
      mounted = false;
      setOverrideReasonHandler(null);
      setApiFetchOverrideReasonHandler(null);
      // Never leave a request waiting on a dialog that is gone.
      const waiting = [currentRef.current, ...queue.current.splice(0)];
      currentRef.current = null;
      for (const pending of waiting) pending?.resolve(null);
    };
  }, []);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= MIN_REASON_LENGTH;

  const submit = () => {
    if (!current || !canSubmit) return;
    current.resolve(trimmed);
  };

  return (
    <Dialog open={current !== null} onOpenChange={(open) => { if (!open) current?.resolve(null); }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg rounded-sm">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Reason for changing an older record</DialogTitle>
            <DialogDescription>
              Records more than a day old can only be changed with a reason. Your reason is kept in the audit trail
              with your name and the time of the change.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={textareaId}>Reason</Label>
            <Textarea
              id={textareaId}
              value={reason}
              maxLength={MAX_REASON_LENGTH}
              rows={4}
              autoFocus
              placeholder="For example: corrected a temperature that was entered against the wrong fridge"
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {canSubmit ? `${trimmed.length}/${MAX_REASON_LENGTH} characters` : `At least ${MIN_REASON_LENGTH} characters`}
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => current?.resolve(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Submit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
