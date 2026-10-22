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

// ─── Picking a named item by voice ───────────────────────────────────────────
// "Fairway mower one", "the number 3 greens mower please": spoken names are
// matched against a list (machines, call points, outlets) without any AI.

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const FILLER = new Set([
  "the", "a", "an", "um", "umm", "uh", "er", "erm", "please", "number", "no", "open", "start", "starting",
  "check", "checks", "pre", "prestart", "preuse", "use", "for", "on", "my", "this", "machine", "its", "it's",
]);

/**
 * A spoken or written name reduced to comparable words: lower case, number
 * words as digits ("twenty one" → "21", "first" → "1"), letters and digits
 * split ("mower1" → "mower 1", "1st" → "1"), filler words and punctuation
 * dropped.
 */
export function normaliseSpokenName(text: string): string {
  const raw = text.toLowerCase()
    .replace(/(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const word = raw[i];
    if (word in TENS) {
      const next = raw[i + 1];
      if (next && next in UNITS && UNITS[next] > 0 && UNITS[next] < 10) { out.push(String(TENS[word] + UNITS[next])); i++; }
      else out.push(String(TENS[word]));
    } else if (word in UNITS && !(word === "oh" && !/^\d/.test(out.at(-1) ?? ""))) {
      out.push(String(UNITS[word]));
    } else if (!FILLER.has(word)) {
      out.push(word.replace(/'/g, ""));
    }
  }
  return out.join(" ");
}

const isNumber = (word: string) => /^\d+$/.test(word);
const singular = (word: string) => (word.length > 3 ? word.replace(/(?:es|s)$/, "") : word);

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function sameWord(a: string, b: string): boolean {
  if (a === b || singular(a) === singular(b)) return true;
  return a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b);
}

/** How well `spoken` names `name`, from 0 (not at all) to 1 (the same). */
export function spokenNameScore(spoken: string, name: string): number {
  const said = normaliseSpokenName(spoken).split(" ").filter(Boolean);
  const target = normaliseSpokenName(name).split(" ").filter(Boolean);
  if (!said.length || !target.length) return 0;
  if (said.join(" ") === target.join(" ")) return 1;
  const saidNumbers = said.filter(isNumber), targetNumbers = target.filter(isNumber);
  // A number names one machine of several: "mower 2" is never "mower 1".
  if (saidNumbers.some(n => targetNumbers.length && !targetNumbers.includes(n))) return 0;
  if (targetNumbers.some(n => saidNumbers.length && !saidNumbers.includes(n))) return 0;
  let penalty = 0;
  if (targetNumbers.length && !saidNumbers.length) penalty = 0.3;
  else if (saidNumbers.length && !targetNumbers.length) penalty = 0.1;
  const saidWords = said.filter(w => !isNumber(w)), targetWords = target.filter(w => !isNumber(w));
  const covered = targetWords.filter(t => saidWords.some(s => sameWord(s, t))).length;
  const relevant = saidWords.filter(s => targetWords.some(t => sameWord(s, t))).length;
  const coverage = targetWords.length ? covered / targetWords.length : 1;
  const precision = saidWords.length ? relevant / saidWords.length : 1;
  if (!covered && targetWords.length) return 0;
  return Math.max(0, Math.round((0.7 * coverage + 0.3 * precision - penalty) * 1000) / 1000);
}

export interface SpokenNameItem { id: number | string; name: string; aliases?: Array<string | null | undefined> }

/**
 * Picks the item a spoken phrase names. `match` is set when one item clearly
 * fits; otherwise `choices` holds the likely items (best first, only those nearly as good as the best) to tap.
 */
export function matchSpokenName<T extends SpokenNameItem>(spoken: string, items: T[]): { match: T | null; choices: T[] } {
  const scored = items
    .map(item => ({
      item,
      score: Math.max(spokenNameScore(spoken, item.name), ...(item.aliases ?? []).filter((a): a is string => !!a).map(a => spokenNameScore(spoken, a))),
    }))
    .filter(s => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  const [top, next] = scored;
  if (!top) return { match: null, choices: [] };
  const clear = (top.score === 1 && (!next || next.score < 1)
    || top.score >= 0.75 && (!next || next.score <= top.score - 0.15)
    || top.score >= 0.6 && !next);
  // Only offer items nearly as good as the best: "fairway mower" offers both
  // fairway mowers, not every mower.
  const choices = scored.filter(s => s.score >= top.score - 0.15).slice(0, 6).map(s => s.item);
  return { match: clear ? top.item : null, choices };
}
