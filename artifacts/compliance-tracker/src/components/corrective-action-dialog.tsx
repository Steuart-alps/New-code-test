import { useEffect, useRef, useState } from "react";
import { setCorrectiveActionHandler, type CorrectiveActionRequest } from "@workspace/api-client-react";
import { setApiFetchCorrectiveActionHandler } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Pending = CorrectiveActionRequest & { resolve: (answers: Record<string, string> | null) => void };

/** As the API checks it (lib/correctiveActions.ts). */
const MIN_LENGTH = 3;
const MAX_LENGTH = 1000;

/**
 * Asks what was done about each fail when a check is saved with something
 * failed, on every track. Registered once for the generated API client and
 * `apiFetch`: the API answers 428 CORRECTIVE_ACTION_REQUIRED with what
 * failed, this box asks for a corrective action against each one, and the
 * save is sent again with the answers (then signed). Each answer goes on the
 * action the fail opens on its track. Cancelling leaves the save unsent.
 */
/**
 * An example that fits what failed, read from the fail's own words and the
 * track it was saved on. The first match wins, so the most specific come first.
 */
const EXAMPLES: [RegExp, string][] = [
  [/first.?aid/, "first aid kit restocked and the missing items noted"],
  [/probe/, "probe recalibrated, or replaced and checked again in iced and boiling water"],
  [/allergen/, "allergen chart updated and kitchen team told"],
  [/emergency.?light/, "bulb replaced and retested, or reported to maintenance"],
  [/fire.?door|self.?clos/, "door closer adjusted so the door shuts fully, or repair booked"],
  [/extinguisher/, "extinguisher replaced and put back on its bracket"],
  [/escape route|fire.?walk|night.?walk|fire exit/, "boxes moved and the fire exit cleared"],
  [/drill/, "repeat drill booked and staff told where the assembly point is"],
  [/alarm|call.?point|panel/, "fire alarm engineer called, panel back to normal after reset"],
  [/hot.?tub|\bspa\b|\btub\b/, "tub closed, water adjusted and retested before reopening"],
  [/pool|swim|bather|lifeguard|surveillance/, "pool closed to bathers, dosing adjusted and water retested"],
  [/sanitiser|chlorine|bromine|\bph\b/, "closed to bathers, dosing adjusted and water retested before reopening"],
  [/storage temp/, "tank lid and insulation checked, water hygiene contractor told"],
  [/tank/, "tank lid refitted and a clean booked with the water hygiene contractor"],
  [/calorifier/, "calorifier set point checked and water hygiene contractor called"],
  [/shower/, "shower head descaled and disinfected again"],
  [/tmv|mixing valve/, "TMV adjusted and retested, outlet out of use until it passes"],
  [/legionella|outlet|sentinel|flush|\btap\b|cold water|hot water/, "outlet flushed and retested, water hygiene contractor told"],
  [/freezer|fridge|chill|cold|cooling|delivery/, "moved food to another fridge and called the engineer"],
  [/cook|\bcore\b|reheat|hot.?hold|sous.?vide/, "cooked for longer and probed again at 75°C"],
  [/clean|hygiene|dirty|grease/, "area cleaned again and checked by the supervisor"],
  [/\bpat\b|appliance|electrical|plug|cable/, "appliance taken out of use and labelled, repair booked"],
  [/bike|brake|tyre|helmet/, "bike taken off hire until the fault is fixed"],
  [/machine|mower|puwer|green|\bshed\b|tractor|spray/, "machine taken out of use and reported to the mechanic"],
  [/\btree/, "area fenced off and the tree surgeon booked"],
  [/pest|rodent|droppings|fly/, "pest contractor called and the gap sealed"],
  [/\broom\b|bedroom|housekeeping/, "fault reported to maintenance and room taken off sale until fixed"],
  [/hazard|premises|slip|\btrip|spill/, "area made safe and coned off, repair reported to maintenance"],
];

export function correctiveActionExample(label: string, url: string): string {
  const failed = label.toLowerCase();
  const track = url.toLowerCase();
  const found = EXAMPLES.find(([words]) => words.test(failed)) ?? EXAMPLES.find(([words]) => words.test(track));
  return `For example: ${found ? found[1] : "put right straight away, or reported to the manager to arrange"}`;
}

export function CorrectiveActionDialog() {
  const [current, setCurrent] = useState<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const currentRef = useRef<Pending | null>(null);

  useEffect(() => {
    const showNext = () => {
      const next = queue.current.shift() ?? null;
      currentRef.current = next;
      setCurrent(next);
    };
    let mounted = true;
    const handler = (info: CorrectiveActionRequest) => new Promise<Record<string, string> | null>((resolve) => {
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
    setCorrectiveActionHandler(handler);
    setApiFetchCorrectiveActionHandler(handler);
    return () => {
      mounted = false;
      setCorrectiveActionHandler(null);
      setApiFetchCorrectiveActionHandler(null);
      // Never leave a save waiting on a box that is gone.
      const waiting = [currentRef.current, ...queue.current.splice(0)];
      currentRef.current = null;
      for (const pending of waiting) pending?.resolve(null);
    };
  }, []);

  return (
    <Dialog open={current !== null} onOpenChange={(open) => { if (!open) current?.resolve(null); }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg max-h-[90vh] overflow-y-auto rounded-sm">
        {current && (
          <CorrectiveActionForm
            key={`${current.method} ${current.url} ${current.failures.map(f => f.key).join(",")}`}
            request={current}
            onCancel={() => current.resolve(null)}
            onDone={(answers) => current.resolve(answers)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CorrectiveActionForm({ request, onCancel, onDone }: {
  request: CorrectiveActionRequest;
  onCancel: () => void;
  onDone: (answers: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const missing = request.failures.filter(f => (answers[f.key] ?? "").trim().length < MIN_LENGTH);
  const several = request.failures.length > 1;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setTried(true);
    if (missing.length) return;
    onDone(Object.fromEntries(request.failures.map(f => [f.key, answers[f.key].trim()])));
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Corrective action needed</DialogTitle>
        <DialogDescription>
          {several ? "Some things failed on this check." : "Something failed on this check."} Say what you
          have done about {several ? "each one" : "it"}, or what needs doing, before it saves. This goes on the
          action for the fail, so it can be followed up and signed off.
        </DialogDescription>
      </DialogHeader>
      {request.failures.map((failure, index) => {
        const id = `corrective-action-${index}`;
        const value = answers[failure.key] ?? "";
        const showError = tried && value.trim().length < MIN_LENGTH;
        return (
          <div key={failure.key} className="space-y-1.5">
            <Label htmlFor={id} className="text-sm font-medium">
              <span className="text-destructive">Fail:</span> {failure.label}
            </Label>
            <Textarea
              id={id}
              data-testid="corrective-action-input"
              value={value}
              maxLength={MAX_LENGTH}
              rows={2}
              autoFocus={index === 0}
              aria-invalid={showError || undefined}
              placeholder={correctiveActionExample(failure.label, request.url)}
              onChange={(e) => setAnswers(prev => ({ ...prev, [failure.key]: e.target.value }))}
            />
            {showError && <p className="text-xs text-destructive" role="alert">Say what was done about this fail.</p>}
          </div>
        );
      })}
      <DialogFooter className="gap-2 sm:gap-0">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={tried && missing.length > 0}>Save with corrective action</Button>
      </DialogFooter>
    </form>
  );
}
