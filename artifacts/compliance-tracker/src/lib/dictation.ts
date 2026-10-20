// Free voice dictation using the speech recognition built into Chrome, Edge
// and Safari (the Web Speech API). Nothing is sent to ComplyTrack's servers
// and there is no per-use charge; the browser itself turns speech into text
// (Chrome and Edge via Google/Microsoft, Safari via Apple). Firefox has no
// speech recognition, so the microphone buttons simply do not appear there.

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: SpeechRecognitionResultLike };
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isDictationSupported(): boolean {
  return getSpeechRecognition() !== null;
}

// English for now (the app is English only); keep the viewer's own English
// variant so US/Australian accents are recognised, otherwise British English.
export function dictationLanguage(): string {
  const lang = typeof navigator !== "undefined" ? navigator.language : "";
  return /^en(-|$)/i.test(lang) ? lang : "en-GB";
}

// Spoken punctuation. Recognisers in en-GB rarely add punctuation themselves,
// so people dictating a report can say "full stop", "new line" and so on.
const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  [/\s*\bnew paragraph\b\s*/gi, "\n\n"],
  [/\s*\bnew line\b\s*/gi, "\n"],
  [/\s*\bfull stop\b/gi, "."],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bexclamation mark\b/gi, "!"],
  [/\s*\bcolon\b/gi, ":"],
];

export function applySpokenPunctuation(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SPOKEN_PUNCTUATION) out = out.replace(pattern, replacement);
  // Tidy a space after punctuation that now runs into the next word.
  return out.replace(/([.,?!:])(?=[^\s\d.,?!:])/g, "$1 ").replace(/[ \t]+\n/g, "\n");
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// Capitalise the first letter of each sentence inside the dictated text.
const capitaliseSentences = (text: string) =>
  text.replace(/([.?!]\s+|\n\s*)([a-z])/g, (_m, gap: string, letter: string) => gap + letter.toUpperCase());

/**
 * Work out the box's new value when `spoken` is dictated with the cursor at
 * `start`..`end` of `current`. Adds a space before and after where needed and
 * starts a new sentence with a capital. Returns the new value and the cursor
 * position just after the inserted words. `maxLength` (when set) is respected.
 */
export function insertDictatedText(
  current: string,
  spoken: string,
  start: number = current.length,
  end: number = start,
  maxLength?: number,
): { value: string; cursor: number } {
  let words = capitaliseSentences(applySpokenPunctuation(spoken.trim()));
  const before = current.slice(0, start);
  const after = current.slice(end);
  if (!words) return { value: current, cursor: start };

  const trimmedBefore = before.replace(/\s+$/, "");
  if (trimmedBefore === "" || /[.?!]$/.test(trimmedBefore) || /\n\s*$/.test(before)) words = capitalise(words);
  if (before !== "" && !/\s$/.test(before) && !/^[.,?!:]/.test(words)) words = ` ${words}`;
  if (after !== "" && !/^\s/.test(after) && !/^[.,?!:]/.test(after)) words = `${words} `;

  if (maxLength !== undefined && maxLength >= 0) {
    const room = Math.max(0, maxLength - before.length - after.length);
    words = words.slice(0, room);
  }
  return { value: before + words + after, cursor: before.length + words.length };
}

/**
 * Split a spoken list ("bleach, oven cleaner and Milton fluid", or one item
 * per pause) into separate items. Splits on commas, full stops, new lines,
 * semicolons, "and", "then" and "next"; drops filler and duplicates.
 */
export function splitSpokenList(text: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  const parts = applySpokenPunctuation(text)
    .split(/[,;\n]|\.(?:\s|$)|\s+(?:and then|and|then|next|also)\s+/i);
  for (const part of parts) {
    const item = part
      .replace(/^\s*(?:and|then|next|also|um+|er+|erm)\b\s*/i, "")
      .replace(/[.\s]+$/, "")
      .trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(capitalise(item));
  }
  return items;
}

export function dictationErrorMessage(error: string): string | null {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.";
    case "audio-capture":
      return "No microphone was found. Check one is connected and not in use by another app.";
    case "network":
      return "Dictation needs an internet connection. Check your connection and try again.";
    case "language-not-supported":
      return "Dictation isn't available for your language in this browser.";
    // "no-speech" and "aborted" just mean nothing was said or it was stopped.
    default:
      return null;
  }
}
