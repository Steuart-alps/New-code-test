/**
 * How long a pop-up message (toast) stays on screen.
 *
 * A message that tells people what to do stays open until they close it, so
 * nobody has to read instructions against the clock. Other messages ("Saved",
 * "Couldn't save") close themselves after long enough to read them.
 */

/** Stays on screen until closed. */
export const UNTIL_CLOSED = Infinity;

/** Shortest and longest time a message that closes itself stays up. */
export const MIN_SHOWN_MS = 6000;
export const MAX_SHOWN_MS = 12000;

/** A message this long is worth reading properly, so it stays open. */
const LONG_MESSAGE_WORDS = 20;

// Words that start an instruction ("Open the record first", "Try again",
// "Choose a site"). Words that are also everyday nouns in the app's messages
// ("Check saved", "Record deleted", "Upload failed", "Save failed") are left
// out so a plain result doesn't stay up.
const INSTRUCTION_START = new RegExp(
  "^(?:add|ask|attach|choose|pick|select|enter|type|fill|open|close|drag|drop|try|use|print|go|set|turn|tap|click|press|make|include|"
  + "allow|refresh|reload|wait|contact|call|email|remove|move|give|put|find|change|install|scan|tick|untick|log in|sign in|"
  + "please|first|don't|do not|keep|stick|read|look|follow|connect|reconnect|retry|reopen|re-upload)\\b",
  "i",
);
const INSTRUCTION_ANYWHERE = /\b(?:you need to|you must|you can|you'll need to|you will need to|then (?:drag|try|open|upload|press|click|tap|add|choose|use|print)|ask (?:an|the|your) )/i;

/** Plain text of a toast's title or description, or null when it holds links or other elements. */
function plainText(value: unknown): string | null {
  if (value === undefined || value === null || value === false || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?:])\s+|\n+|\s+[—–-]\s+/).map((part) => part.trim().replace(/^[^\p{L}]+/u, "")).filter(Boolean);
}

/** True when the words tell the reader to do something. */
export function holdsInstructions(text: string): boolean {
  return sentences(text).some((sentence) => INSTRUCTION_START.test(sentence)) || INSTRUCTION_ANYWHERE.test(text);
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Milliseconds to show a toast with this title and description, or
 * UNTIL_CLOSED. `stay` forces either way; an explicit `duration` wins over
 * both.
 */
export function toastDuration({ title, description, action, stay, duration }: {
  title?: unknown;
  description?: unknown;
  action?: unknown;
  stay?: boolean;
  duration?: number;
}): number {
  if (typeof duration === "number") return duration;
  if (stay !== undefined) return stay ? UNTIL_CLOSED : shownFor(`${plainText(title) ?? ""} ${plainText(description) ?? ""}`);
  // A button to press, or a link inside the message, needs time to reach.
  if (action) return UNTIL_CLOSED;
  const titleText = plainText(title);
  const descriptionText = plainText(description);
  if (titleText === null || descriptionText === null) return UNTIL_CLOSED;
  const text = `${titleText}\n${descriptionText}`.trim();
  if (wordCount(text) >= LONG_MESSAGE_WORDS || holdsInstructions(text)) return UNTIL_CLOSED;
  return shownFor(text);
}

/** Long enough to read: about a third of a second a word, within the limits. */
function shownFor(text: string): number {
  return Math.min(MAX_SHOWN_MS, Math.max(MIN_SHOWN_MS, 3000 + wordCount(text) * 300));
}
