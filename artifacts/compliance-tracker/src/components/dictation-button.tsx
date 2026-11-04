import * as React from "react";
import { Mic, Square } from "lucide-react";
import { useDictation } from "@/hooks/use-dictation";
import { insertDictatedText, isDictationSupported } from "@/lib/dictation";
import { cn } from "@/lib/utils";

type DictationTarget = HTMLTextAreaElement | HTMLInputElement;

// Set a box's value the way typing would, so React state and react-hook-form
// fields both see the change through their normal onChange handlers.
function setFieldValue(element: DictationTarget, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertIntoField(element: DictationTarget, spoken: string) {
  const focused = document.activeElement === element;
  const start = focused ? element.selectionStart ?? element.value.length : element.value.length;
  const end = focused ? element.selectionEnd ?? start : start;
  const maxLength = element.maxLength >= 0 ? element.maxLength : undefined;
  const { value, cursor } = insertDictatedText(element.value, spoken, start, end, maxLength);
  if (value === element.value) return;
  setFieldValue(element, value);
  if (focused) element.setSelectionRange(cursor, cursor);
}

export const dictationSupported = isDictationSupported();

/** Microphone toggle: words spoken are typed into `targetRef`'s box. */
export function DictationButton({
  targetRef,
  disabled,
  singleLine,
  className,
}: {
  targetRef: React.RefObject<DictationTarget | null>;
  disabled?: boolean;
  /** One-line box: show the words being heard underneath it, not over it. */
  singleLine?: boolean;
  className?: string;
}) {
  const { listening, interim, toggle, stop } = useDictation((text) => {
    if (targetRef.current) insertIntoField(targetRef.current, text);
  });

  React.useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);

  if (disabled) return null;
  return (
    <>
      <button
        type="button"
        data-slot="dictation-button"
        aria-label={listening ? "Stop dictating" : "Dictate (speak instead of typing)"}
        data-listening={listening ? "true" : undefined}
        title={listening ? "Listening… click to stop" : "Speak instead of typing"}
        // Keep the cursor where it is in the box while clicking the button.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          listening && "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground animate-pulse",
          className,
        )}
      >
        {listening ? <Square className="h-3.5 w-3.5 fill-current" /> : <Mic className="h-4 w-4" />}
      </button>
      {listening && (
        <span
          aria-live="polite"
          className={cn(
            "pointer-events-none absolute left-2 right-10 z-10 truncate rounded bg-background/90 px-1 text-xs italic text-muted-foreground",
            singleLine ? "top-full mt-0.5 border shadow-sm" : "bottom-1",
          )}
        >
          {interim || "Listening…"}
        </span>
      )}
    </>
  );
}

export function useMergedRef<T>(forwarded: React.ForwardedRef<T>) {
  const inner = React.useRef<T | null>(null);
  const setRef = React.useCallback((node: T | null) => {
    inner.current = node;
    if (typeof forwarded === "function") forwarded(node);
    else if (forwarded) forwarded.current = node;
  }, [forwarded]);
  return [inner, setRef] as const;
}
