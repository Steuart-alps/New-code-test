import { useEffect, useMemo, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dictationSupported } from "@/components/dictation-button";
import { useDictation } from "@/hooks/use-dictation";
import { matchSpokenName, type SpokenNameItem } from "@/lib/dictation";

/**
 * Say the name of something on a list ("fairway mower one") and it is picked
 * straight away when one item clearly fits. When several could fit they are
 * shown to tap; the name can also be typed. Uses the browser's own speech
 * recognition, so nothing is sent to an AI service.
 */
export function SpeakToPickDialog<T extends SpokenNameItem>({
  open,
  title,
  description,
  items,
  noun = "item",
  onClose,
  onPick,
}: {
  open: boolean;
  title: string;
  description?: string;
  items: T[];
  /** What the items are, for messages: "machine", "call point". */
  noun?: string;
  onClose: () => void;
  onPick: (item: T) => void;
}) {
  const [heard, setHeard] = useState("");
  const [typed, setTyped] = useState("");

  const { listening, interim, start, stop, toggle } = useDictation((spoken) => {
    const text = spoken.trim();
    if (!text) return;
    setHeard(text);
    setTyped("");
    const { match } = matchSpokenName(text, items);
    if (match) {
      stop();
      onPick(match);
    }
  });

  useEffect(() => {
    if (!open) return;
    setHeard("");
    setTyped("");
    // Opening the dialog is the tap that starts listening.
    if (dictationSupported && items.length) start();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = typed.trim() || heard;
  const { choices } = useMemo(() => (query ? matchSpokenName(query, items) : { choices: [] as T[] }), [query, items]);

  function close() {
    stop();
    onClose();
  }

  function pick(item: T) {
    stop();
    onPick(item);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" data-testid="speak-to-pick-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? (dictationSupported
              ? `Say the ${noun}'s name, for example its name and number.`
              : `Type the ${noun}'s name.`)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">There are no {noun}s to choose from yet.</p>
          ) : (
            <>
              {dictationSupported && (
                <Button
                  type="button"
                  size="lg"
                  variant={listening ? "destructive" : "default"}
                  className="w-full gap-2"
                  onClick={toggle}
                  data-testid="button-speak-to-pick-mic"
                >
                  {listening ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4 w-4" />}
                  {listening ? "Listening… tap to stop" : heard ? "Try again" : "Start speaking"}
                </Button>
              )}
              <div aria-live="polite" className="min-h-5 text-sm" data-testid="text-speak-to-pick-heard">
                {listening && interim ? (
                  <span className="italic text-muted-foreground">{interim}</span>
                ) : heard && !typed.trim() ? (
                  <span>
                    Heard <span className="font-medium">"{heard}"</span>.{" "}
                    {choices.length
                      ? `Which ${noun} did you mean?`
                      : `No ${noun} matches that. Try again, or type the name below.`}
                  </span>
                ) : null}
              </div>
              {choices.length > 0 && (
                <ul className="space-y-2" data-testid="list-speak-to-pick-choices">
                  {choices.map((item) => (
                    <li key={item.id}>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto w-full justify-start py-3 text-left text-base"
                        onClick={() => pick(item)}
                      >
                        {item.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="speak-to-pick-typed">{dictationSupported ? "Or type the name" : "Name"}</Label>
                <Input
                  id="speak-to-pick-typed"
                  dictation={false}
                  value={typed}
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const { match } = matchSpokenName(typed, items);
                    if (match) pick(match);
                  }}
                  placeholder={items[0]?.name}
                />
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
