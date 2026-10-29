import { useEffect, useRef, useState } from "react";
import { matchSpokenName, type SpokenNameItem } from "./dictation";
import type { SayItFormKey } from "./voice-forms";

// Hands what Say it heard to the track page whose form it fills. Say it
// stores the fill and, when the page isn't open yet, goes to it; the page
// takes the fill once its lists have loaded and opens its own form with the
// fields filled in, where the person checks them and saves.

export type SayItFill = {
  form: SayItFormKey;
  /** The item said ("hot tub 2"), matched against the page's own list. */
  item?: string;
  values: Record<string, string | number | boolean>;
  siteId: number | null;
  /** Everything that was heard. */
  text: string;
};

const EVENT = "say-it-fill";
// A fill not taken in this time (the page failed to load) is dropped.
const FRESH_MS = 2 * 60_000;
let pending: (SayItFill & { at: number }) | null = null;

export function sendSayItFill(fill: SayItFill) {
  pending = { ...fill, at: Date.now() };
  window.dispatchEvent(new Event(EVENT));
}

/** The waiting fill for one of `forms`, removed so it opens only once. */
export function takeSayItFill(forms: readonly SayItFormKey[]): SayItFill | null {
  if (!pending || !forms.includes(pending.form)) return null;
  const fill = pending;
  pending = null;
  if (Date.now() - fill.at > FRESH_MS) return null;
  const { at: _at, ...rest } = fill;
  return rest;
}

/**
 * Open a page's form from Say it: `onFill` runs for a fill of one of
 * `forms`, sent before the page opened or while it is open, once `ready`
 * (its lists have loaded).
 */
export function useSayItFill(forms: readonly SayItFormKey[], onFill: (fill: SayItFill) => void, ready = true) {
  const onFillRef = useRef(onFill);
  onFillRef.current = onFill;
  const [sent, setSent] = useState(0);
  useEffect(() => {
    const listener = () => setSent((count) => count + 1);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const fill = takeSayItFill(forms);
    if (fill) onFillRef.current(fill);
  }, [sent, ready]);
}

/** Today, or yesterday, as YYYY-MM-DD on this device. */
export function spokenDate(word: unknown): string {
  const date = new Date();
  if (word === "yesterday") date.setDate(date.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The note a record filled in by Say it carries, as Say it's own readings do. */
export const spokenNote = (text: string) => `Logged by voice: "${text.trim().slice(0, 500)}"`;

/** A note box's text with the spoken note added. */
export const withSpokenNote = (notes: string, text: string) => [notes.trim(), spokenNote(text)].filter(Boolean).join("\n");

/** The one item on the page's list that `said` names, or null to choose. */
export function matchSpokenItem<T extends SpokenNameItem>(said: string | undefined, items: T[]): T | null {
  if (!said?.trim()) return null;
  const { match, choices } = matchSpokenName(said, items);
  return match ?? (choices.length === 1 ? choices[0] : null);
}
