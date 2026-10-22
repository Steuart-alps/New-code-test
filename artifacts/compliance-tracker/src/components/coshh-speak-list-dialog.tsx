import { useEffect, useMemo, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dictationSupported } from "@/components/dictation-button";
import { SiteSelect } from "@/components/register-shared";
import { useDictation } from "@/hooks/use-dictation";
import { splitSpokenList } from "@/lib/dictation";
import { cn } from "@/lib/utils";

const MAX_ITEMS = 100;

/**
 * Speak (or type) a list of products, check the list, then add them all to
 * the COSHH register in one go. Each pause while speaking starts a new item.
 * The added entries still need their safety data sheet and assessment.
 */
export function CoshhSpeakListDialog({
  open,
  defaultSiteId,
  existing,
  onClose,
  onAdd,
}: {
  open: boolean;
  defaultSiteId: string;
  /** Products already on the register, to flag repeats. */
  existing: Array<{ siteId: number | null; productName: string; status: string }>;
  onClose: () => void;
  /** Adds the products; resolves with the names that could not be added. */
  onAdd: (siteId: number, productNames: string[]) => Promise<string[]>;
}) {
  const [siteId, setSiteId] = useState(defaultSiteId);
  const [text, setText] = useState("");
  // Ticks the person changed; otherwise repeats start unticked, the rest ticked.
  const [ticks, setTicks] = useState<Map<string, boolean>>(new Map());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (open) { setSiteId(defaultSiteId); setText(""); setTicks(new Map()); }
  }, [open, defaultSiteId]);

  const { listening, interim, toggle, stop } = useDictation((spoken) => {
    // Each finished phrase goes on its own line, so a pause separates items.
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n` : "") + spoken.trim());
  });

  const items = useMemo(() => splitSpokenList(text).map((name) => name.slice(0, 200)).slice(0, MAX_ITEMS), [text]);
  const onRegister = useMemo(() => new Set(existing
    .filter((item) => item.status === "in_use" && String(item.siteId) === siteId)
    .map((item) => item.productName.trim().toLowerCase())), [existing, siteId]);
  const isChosen = (name: string) => {
    const key = name.toLowerCase();
    return ticks.get(key) ?? !onRegister.has(key);
  };
  const chosen = items.filter(isChosen);

  function setChosen(name: string, value: boolean) {
    setTicks((current) => new Map(current).set(name.toLowerCase(), value));
  }

  async function add() {
    if (!siteId || chosen.length === 0) return;
    stop();
    setAdding(true);
    try {
      const failed = await onAdd(Number(siteId), chosen);
      if (failed.length === 0) onClose();
      else setText(failed.join("\n"));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !adding) { stop(); onClose(); } }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a list of substances</DialogTitle>
          <DialogDescription>
            {dictationSupported
              ? "Press Start speaking and say each product name, pausing between them (or say \"comma\"). You can also type, one per line."
              : "Type the product names, one per line or separated by commas."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <SiteSelect id="coshh-list-site" value={siteId} onChange={setSiteId} />
          {dictationSupported && (
            <Button
              type="button"
              variant={listening ? "destructive" : "default"}
              className="w-full gap-2"
              onClick={toggle}
            >
              {listening ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4 w-4" />}
              {listening ? "Stop listening" : "Start speaking"}
            </Button>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="coshh-list-text">Product names</Label>
            <Textarea
              id="coshh-list-text"
              dictation={false}
              rows={5}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={"Thick bleach\nOven cleaner\nMilton sterilising fluid"}
            />
            {listening && (
              <p aria-live="polite" className="text-xs italic text-muted-foreground">{interim || "Listening…"}</p>
            )}
          </div>
          {items.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Check the list ({chosen.length} to add)</legend>
              <p className="text-xs text-muted-foreground">Fix any name by editing the text above. Untick anything you don't want.</p>
              <ul className="divide-y rounded-md border">
                {items.map((name) => {
                  const repeat = onRegister.has(name.toLowerCase());
                  return (
                    <li key={name.toLowerCase()}>
                      <label className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40">
                        <Checkbox checked={isChosen(name)} onCheckedChange={(checked) => setChosen(name, checked === true)} />
                        <span className={cn("flex-1", !isChosen(name) && "text-muted-foreground line-through")}>{name}</span>
                        {repeat && <span className="text-[11px] text-amber-700">Already on the register</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}
          <p className="text-xs text-muted-foreground">
            Each product is added as "in use" with no data sheet yet. Open it afterwards to attach the supplier's safety data sheet and record the assessment.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => { stop(); onClose(); }} disabled={adding}>Cancel</Button>
          <Button onClick={add} disabled={adding || !siteId || chosen.length === 0}>
            {adding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {chosen.length === 1 ? "Add 1 substance" : `Add ${chosen.length} substances`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
