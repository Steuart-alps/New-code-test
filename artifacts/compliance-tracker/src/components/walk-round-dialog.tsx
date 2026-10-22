import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Footprints, Loader2, Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dictationSupported } from "@/components/dictation-button";
import { useDictation } from "@/hooks/use-dictation";
import { nameWalkRoundItems, readWalkRound, type WalkRoundKind, type WalkRoundOutletType } from "@/lib/walk-round";

const MAX_POINTS = 200;

/** What a checked point is saved as. Outlets said as "hot and cold" become two outlets. */
export interface WalkRoundPoint { name: string; location: string; types: WalkRoundOutletType[] }

type OutletChoice = "" | "hot_cold" | WalkRoundOutletType;
const OUTLET_CHOICES: Array<[OutletChoice, string]> = [
  ["hot_cold", "Sentinel, hot and cold"],
  ["hot", "Sentinel, hot"],
  ["cold", "Sentinel, cold"],
  ["tmv", "TMV outlet"],
  ["calorifier", "Calorifier"],
  ["little_used", "Little used (weekly flush)"],
];
const choiceOf = (types: WalkRoundOutletType[]): OutletChoice =>
  types.includes("hot") && types.includes("cold") ? "hot_cold" : types[0] ?? "";
const typesOf = (choice: OutletChoice): WalkRoundOutletType[] =>
  choice === "hot_cold" ? ["hot", "cold"] : choice ? [choice] : [];

interface RowEdit { name?: string; location?: string; choice?: OutletChoice; removed?: boolean }

/**
 * "Walk round and speak": walk the premises with a phone, say each point as
 * you reach it, then check the list before it is saved. The order spoken is
 * the order of the list. Typing works too (one point per line).
 */
export function WalkRoundDialog({
  open, onClose, kind, title, prefix, examples, existingNames, before, saveBlocked, onSave,
}: {
  open: boolean;
  onClose: () => void;
  kind: WalkRoundKind;
  title: string;
  /** Name for a point: prefix + number, e.g. "CP" → "CP3". */
  prefix: string;
  /** What to say, one example per line. */
  examples: string[];
  /** Names already listed, so unnumbered points carry on from them. */
  existingNames: string[];
  /** Shown above the microphone, e.g. the site chooser. */
  before?: ReactNode;
  /** Why the list cannot be saved yet (e.g. no site chosen). */
  saveBlocked?: string | null;
  /** Saves the points in order; resolves with an error message, or null when saved. */
  onSave: (points: WalkRoundPoint[]) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [edits, setEdits] = useState<Record<number, RowEdit>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setText(""); setEdits({}); setError(null); }
  }, [open]);

  const { listening, interim, toggle, stop } = useDictation((spoken) => {
    // Each finished phrase goes on its own line, so a pause starts a new point.
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n` : "") + spoken.trim());
  });

  const items = useMemo(() => readWalkRound(text, kind).slice(0, MAX_POINTS), [text, kind]);
  const names = useMemo(() => nameWalkRoundItems(items, prefix, existingNames), [items, prefix, existingNames]);
  const rows = items.map((item, index) => {
    const edit = edits[index] ?? {};
    return {
      index,
      name: edit.name ?? names[index],
      location: edit.location ?? item.location,
      choice: edit.choice ?? choiceOf(item.types),
      removed: edit.removed ?? false,
    };
  });
  const kept = rows.filter(row => !row.removed);
  const missingType = kind === "outlet" && kept.some(row => !row.choice);
  const missingName = kept.some(row => !row.name.trim());
  const edit = (index: number, change: RowEdit) => setEdits(current => ({ ...current, [index]: { ...current[index], ...change } }));
  const savedCount = kind === "outlet" ? kept.reduce((sum, row) => sum + Math.max(1, typesOf(row.choice).length), 0) : kept.length;
  const noun = kind === "outlet" ? "outlet" : "call point";

  async function save() {
    stop();
    setSaving(true);
    setError(null);
    try {
      const failure = await onSave(kept.map(row => ({ name: row.name.trim(), location: row.location.trim(), types: typesOf(row.choice) })));
      if (failure) setError(failure);
      else onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) { stop(); onClose(); } }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Footprints className="h-4 w-4" /> {title}</DialogTitle>
          <DialogDescription>
            {dictationSupported
              ? "Walk round with your phone, press Start speaking, and say each one as you reach it. The order you walk is the order of the list. Check it below before saving."
              : "Type one per line, in the order you want them. Check the list below before saving."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {before}
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-0.5" data-testid="walk-round-examples">
            <p className="font-medium text-foreground">For example, say:</p>
            {examples.map(example => <p key={example}>"{example}"</p>)}
          </div>
          {dictationSupported && (
            <Button type="button" variant={listening ? "destructive" : "default"} className="w-full gap-2" onClick={toggle}>
              {listening ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4 w-4" />}
              {listening ? "Stop listening" : "Start speaking"}
            </Button>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="walk-round-text">What was said</Label>
            <Textarea id="walk-round-text" dictation={false} rows={4} value={text} data-testid="walk-round-text"
              onChange={(event) => { setText(event.target.value); setEdits({}); }}
              placeholder={examples.join("\n")} />
            {listening && <p aria-live="polite" className="text-xs italic text-muted-foreground">{interim || "Listening…"}</p>}
          </div>
          {rows.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Check the list ({savedCount} {noun}{savedCount === 1 ? "" : "s"} to save, in this order)</legend>
              <ol className="space-y-2" data-testid="walk-round-rows">
                {rows.map(row => row.removed ? null : (
                  <li key={row.index} className="rounded-md border p-2 space-y-1.5" data-testid={`walk-round-row-${row.index}`}>
                    <div className="flex gap-2 items-center">
                      <Input value={row.name} aria-label="Name" className="h-8 w-24 shrink-0 text-sm"
                        onChange={event => edit(row.index, { name: event.target.value })} />
                      <Input value={row.location} aria-label="Location" placeholder="Location" className="h-8 flex-1 min-w-0 text-sm"
                        onChange={event => edit(row.index, { location: event.target.value })} />
                      <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0" aria-label="Leave this one out"
                        title="Leave this one out" onClick={() => edit(row.index, { removed: true })}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {kind === "outlet" && (
                      <Select value={row.choice || undefined} onValueChange={value => edit(row.index, { choice: value as OutletChoice })}>
                        <SelectTrigger className={row.choice ? "h-8 text-xs" : "h-8 text-xs border-amber-400"} aria-label="Outlet type">
                          <SelectValue placeholder="Choose what kind of outlet" />
                        </SelectTrigger>
                        <SelectContent>
                          {OUTLET_CHOICES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </li>
                ))}
              </ol>
              {missingType && <p className="text-xs text-amber-800">Choose what kind each outlet is before saving.</p>}
            </fieldset>
          )}
          {saveBlocked && <p className="text-xs text-amber-800">{saveBlocked}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { stop(); onClose(); }} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || savedCount === 0 || missingType || missingName || !!saveBlocked} data-testid="walk-round-save">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save {savedCount} {noun}{savedCount === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
