// "Walk round and speak": someone walks the premises saying each point as
// they reach it ("this is call point 1, by the front door", "outlet 3, plant
// room hose, little used"), and the spoken order becomes the list's order.
// Speech is turned into text by the browser's free dictation (lib/dictation);
// this file only reads that text, so there is no AI and no per-use cost.

import { applySpokenPunctuation } from "./dictation";

export type WalkRoundKind = "call_point" | "outlet";
/** Legionella outlet types (api-server routes/legionella.ts). */
export type WalkRoundOutletType = "hot" | "cold" | "tmv" | "calorifier" | "little_used";

export interface WalkRoundItem {
  /** The number said ("call point 3" → 3), or null when none was said. */
  ref: number | null;
  location: string;
  /** Outlets only: what was said about the outlet; empty when nothing was. */
  types: WalkRoundOutletType[];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const NUMBER = `(\\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")})`;
// "call point", "CP", "outlet", "point", "number"; recognisers also hear "cool point".
const MARKER = `(?:call ?point|cool point|cp|outlet|point|number)`;
// "point 2" inside "call point 2" is not a second start.
const STARTS = new RegExp(`(?<!\\b(?:call|cool))(?:^|\\s)(?=(?:this is|here is|here's)\\b|${MARKER}\\s*(?:number\\s*)?${NUMBER}\\b)`, "gi");
const LEAD_REF = new RegExp(`^${MARKER}\\s*(?:number\\s*)?${NUMBER}\\b`, "i");

const OUTLET_WORDS: Array<[RegExp, WalkRoundOutletType[]]> = [
  [/\b(?:little|rarely|seldom|infrequently|hardly)[- ]used\b|\bnot used (?:much|often)\b|\blittle use\b/gi, ["little_used"]],
  [/\b(?:hot (?:and|&) cold|cold (?:and|&) hot|both taps)\b/gi, ["hot", "cold"]],
  [/\b(?:tmv|t m v|thermostatic(?: mixing)?(?: valve)?|mixing valve|blended)\b/gi, ["tmv"]],
  [/\bcalorifiers?\b/gi, ["calorifier"]],
  [/\bhot(?: water| tap)?\b/gi, ["hot"]],
  [/\bcold(?: water| tap)?\b/gi, ["cold"]],
];

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function numberOf(word: string): number | null {
  const value = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word.toLowerCase()];
  return value && value > 0 ? value : null;
}

/** Tidy what is left of a phrase into a location: "in the kitchen" → "Kitchen". */
function tidyLocation(text: string): string {
  let out = text
    .replace(/\s*,\s*,+/g, ",")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .replace(/^(?:(?:and|then|next|also|um+|er+|erm|so|okay|ok|right|is|it's|it is|which is|that's|that is|located|situated)\b[\s,]*)+/i, "")
    .replace(/^(?:in|at|on) (?:the )?/i, "")
    .replace(/\s+(?:and|,)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  out = out.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "");
  return capitalise(out);
}

/**
 * Read a spoken (or typed) walk round into points, in the order said. A new
 * point starts at each pause (new line), "this is", or "call point N" /
 * "outlet N". For outlets, "sentinel", "hot and cold", "TMV", "calorifier"
 * and "little used" say what kind of outlet it is and are left out of the
 * location.
 */
export function readWalkRound(text: string, kind: WalkRoundKind): WalkRoundItem[] {
  const segments = applySpokenPunctuation(text)
    .replace(STARTS, "\n")
    .split(/\n/);
  const items: WalkRoundItem[] = [];
  for (const raw of segments) {
    let rest = raw.trim().replace(/^(?:(?:and|then|next|also|um+|er+|erm|so|okay|ok|right)\b[\s,]*)+/i, "");
    rest = rest.replace(/^(?:this is|here is|here's)\b[\s,]*/i, "");
    let ref: number | null = null;
    const lead = LEAD_REF.exec(rest);
    if (lead) {
      ref = numberOf(lead[1]);
      rest = rest.slice(lead[0].length);
    } else {
      rest = rest.replace(new RegExp(`^${MARKER}\\b`, "i"), "");
    }
    const types: WalkRoundOutletType[] = [];
    if (kind === "outlet") {
      for (const [pattern, found] of OUTLET_WORDS) {
        if (rest.search(pattern) === -1) continue;
        for (const type of found) if (!types.includes(type)) types.push(type);
        rest = rest.replace(pattern, " ");
      }
      rest = rest.replace(/\bsentinel(?: outlet)?s?\b/gi, " ").replace(/\boutlet\b/gi, " ").replace(/\b(?:and|&)\s*(?=,|$)/gi, " ");
      // A little-used outlet is flushed rather than temperature-checked.
      if (types.includes("little_used")) types.splice(0, types.length, "little_used");
    }
    const location = tidyLocation(rest);
    if (!location && ref === null) continue;
    items.push({ ref, location: location.slice(0, 200), types });
  }
  return items;
}

/**
 * Names for the points read from a walk round: the number said ("CP3"), or
 * the next free number after those already listed and said.
 */
export function nameWalkRoundItems(items: WalkRoundItem[], prefix: string, existingNames: string[] = []): string[] {
  const numberIn = (name: string) => {
    const match = new RegExp(`^${prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\d+)\\b`, "i").exec(name.trim());
    return match ? Number(match[1]) : 0;
  };
  let highest = Math.max(0, ...existingNames.map(numberIn), ...items.map(item => item.ref ?? 0));
  return items.map(item => `${prefix}${item.ref ?? ++highest}`);
}
