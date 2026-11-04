// "Say it": read one spoken reading ("fridge 1 is showing 4 degrees",
// "chicken core temp 78", "testing call point 1", "hot tap ladies toilet 55
// degrees") and work out the track, the item and the value. Rule based, so
// it runs in the browser with no AI cost. The result is only ever a
// suggestion: the person checks it on a card and taps Save, because these
// are legal records and speech can be misheard.

export type ColdUnitOption = { name: string; type: "fridge" | "freezer" };
export type CallPointOption = { id: number; name: string; location?: string | null };
export type OutletOption = { id: number; name: string; location?: string | null; type: string };

/** What the person's tracks hold at the chosen site. A missing list means the
 *  track is not switched on, so nothing is matched to it. */
export type VoiceCatalogue = {
  coldUnits?: ColdUnitOption[];
  /** Cooking / hot holding items from the kitchen template and item rules. */
  kitchenItems?: string[];
  callPoints?: CallPointOption[];
  outlets?: OutletOption[];
};

export type KitchenCoreSection = "hotTemperature" | "reheating" | "hotHolding";

export type VoiceReading =
  | { kind: "cold_unit"; matches: ColdUnitOption[]; spokenItem: string; temperature: number | null; slot: "am" | "pm" | null }
  | { kind: "kitchen_core"; section: KitchenCoreSection; item: string; temperature: number | null; holdSeconds: number | null }
  | { kind: "fire_alarm"; matches: CallPointOption[]; spokenItem: string; result: "pass" | "fail" | null }
  | { kind: "water_outlet"; matches: OutletOption[]; spokenItem: string; temperature: number | null; water: "hot" | "cold" | null }
  | { kind: "unknown"; reason: string };

// ── Words to numbers ──────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  zero: 0, nought: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Read a run of number words starting at `i`: "seventy eight", "one hundred
 *  and five", "minus eighteen", "four point five". Returns the value and how
 *  many tokens it used, or null when tokens[i] is not a number. */
function readNumber(tokens: string[], i: number): { value: number; used: number } | null {
  let j = i;
  let sign = 1;
  if ((tokens[j] === "minus" || tokens[j] === "negative") && j + 1 < tokens.length) { sign = -1; j++; }
  const start = j;
  let whole: number | null = null;
  if (/^-?\d+(?:\.\d+)?$/.test(tokens[j] ?? "")) {
    whole = Number(tokens[j]);
    j++;
  } else {
    // Up to 99 ("seventy eight", "eighteen"), optionally "N hundred [and]
    // M". Two numbers in a row ("fridge one four") stay two numbers. "oh"
    // only counts inside a decimal ("four point oh"), never on its own.
    const belowHundred = (k: number): { value: number; next: number } | null => {
      const t = tokens[k];
      if (t in TENS) {
        const unit = tokens[k + 1];
        if (unit && unit !== "oh" && unit in UNITS && UNITS[unit] > 0 && UNITS[unit] < 10) return { value: TENS[t] + UNITS[unit], next: k + 2 };
        return { value: TENS[t], next: k + 1 };
      }
      if (t in UNITS && t !== "oh") return { value: UNITS[t], next: k + 1 };
      return null;
    };
    const first = belowHundred(j);
    if (first) {
      whole = first.value;
      j = first.next;
      if (tokens[j] === "hundred" && first.value > 0 && first.value < 10) {
        whole = first.value * 100;
        j++;
        const andAt = tokens[j] === "and" ? j + 1 : j;
        const rest = belowHundred(andAt);
        if (rest) { whole += rest.value; j = rest.next; }
      }
    }
  }
  if (whole === null || j === start) return null;
  // Decimals: "four point five", "4 point 5".
  if (tokens[j] === "point" && j + 1 < tokens.length) {
    const digits: string[] = [];
    let k = j + 1;
    while (k < tokens.length) {
      const t = tokens[k];
      if (/^\d+$/.test(t)) { digits.push(t); k++; }
      else if (t in UNITS && UNITS[t] < 10) { digits.push(String(UNITS[t])); k++; }
      else break;
    }
    if (digits.length) {
      whole = Number(`${Math.trunc(whole)}.${digits.join("")}`);
      j = k;
    }
  }
  if (tokens[j] === "and" && tokens[j + 1] === "a" && tokens[j + 2] === "half") { whole += 0.5; j += 3; }
  return { value: sign * whole, used: j - i };
}

// ── Normalising what was heard ────────────────────────────────────────────────

/** A token is a word, or a number written with digits. */
export type SpokenToken = { text: string; value: number | null };

/**
 * Lower-case, split "4oC" / "4°C" / "CP3" / "fridge1" apart, mark degrees,
 * and turn number words into numbers. "Fridge one is showing four degrees"
 * becomes fridge 1 is showing 4 degrees.
 */
export function tokeniseSpeech(text: string): SpokenToken[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    // Degrees written or recognised as symbols: 4°C, 4 ºc, 4oC, 4 deg c, 4c.
    .replace(/(\d)\s*(?:°|º)\s*c?\b/g, "$1 degrees ")
    .replace(/(\d)\s*o\s*c\b/g, "$1 degrees ")
    .replace(/(\d)\s*c\b/g, "$1 degrees ")
    .replace(/\bdeg(?:s|rees?)?\b(?:\s+(?:celsius|centigrade|c)\b)?/g, " degrees ")
    .replace(/\b(?:celsius|centigrade)\b/g, " degrees ")
    // Minus written as a sign before a number.
    .replace(/(^|\s)[-−–](\d)/g, "$1minus $2")
    // Split letters from digits: cp3 -> cp 3, fridge1 -> fridge 1.
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    // Possessives and plurals don't change what was meant.
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/(\D)\.|\.(\D|$)/g, "$1 $2");
  const words = cleaned.split(/\s+/).filter(Boolean);
  const tokens: SpokenToken[] = [];
  for (let i = 0; i < words.length;) {
    const number = readNumber(words, i);
    if (number) {
      tokens.push({ text: String(number.value), value: number.value });
      i += number.used;
    } else {
      tokens.push({ text: stem(words[i]), value: null });
      i++;
    }
  }
  return tokens;
}

/** "ladies" -> "lady", "toilets" -> "toilet", so plurals match names. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// Words that never identify an item.
const FILLER = new Set([
  "the", "a", "an", "is", "it", "its", "at", "of", "on", "in", "to", "for", "was", "were", "be", "been", "being",
  "reading", "read", "showing", "show", "shows", "says", "say", "currently", "now", "just", "about", "around",
  "temp", "temperature", "degree", "degrees", "number", "no", "and", "um", "er", "erm", "uh", "please", "ok",
  "testing", "tested", "test", "check", "checked", "checking", "today", "this", "that", "there", "here", "my",
  "with", "by", "from", "we", "i", "i'm", "im", "have", "has", "had", "got", "of", "out", "after", "minute",
]);

const tokensOf = (text: string) => tokeniseSpeech(text);
const textOf = (tokens: SpokenToken[]) => tokens.map((t) => t.text).join(" ");

/** Where `name`'s tokens appear one after another in `spoken`, or -1. */
function findSequence(spoken: SpokenToken[], name: SpokenToken[]): number {
  if (!name.length || name.length > spoken.length) return -1;
  outer: for (let i = 0; i + name.length <= spoken.length; i++) {
    for (let k = 0; k < name.length; k++) if (spoken[i + k].text !== name[k].text) continue outer;
    return i;
  }
  return -1;
}

const meaningful = (tokens: SpokenToken[], extraIgnore: Set<string> = new Set()) =>
  tokens.filter((t) => t.value === null && !FILLER.has(t.text) && !extraIgnore.has(t.text)).map((t) => t.text);

/** The first number in a name ("CP3" -> 3, "Fridge 2" -> 2), if any. */
function nameNumber(name: string): number | null {
  return tokensOf(name).find((t) => t.value !== null)?.value ?? null;
}

/**
 * Choose the items a spoken phrase names. A name heard word for word wins.
 * Otherwise items score by how many of their words were heard; a number
 * spoken next to the keyword (fridge 3, call point 1, outlet 4) must match
 * the item's own number exactly. Returns the best items (several when tied).
 */
function matchItems<T>(
  spoken: SpokenToken[],
  items: T[],
  label: (item: T) => string[],
  options: { spokenNumber: number | null; ignore?: Set<string> },
): { matches: T[]; used: Set<number> } {
  const used = new Set<number>();
  // 1. Exact names, longest first ("walk in fridge 2" before "fridge 2").
  const exact: Array<{ item: T; at: number; length: number }> = [];
  for (const item of items) {
    for (const text of label(item)) {
      const name = tokensOf(text);
      const at = findSequence(spoken, name);
      if (at >= 0 && name.length > 0) { exact.push({ item, at, length: name.length }); break; }
    }
  }
  if (exact.length) {
    const longest = Math.max(...exact.map((e) => e.length));
    const best = exact.filter((e) => e.length === longest);
    for (const e of best) for (let k = 0; k < e.length; k++) used.add(e.at + k);
    return { matches: best.map((e) => e.item), used };
  }
  // 2. Word overlap, with the spoken number as a hard rule.
  const heard = new Set(meaningful(spoken, options.ignore));
  let bestScore = 0;
  let best: T[] = [];
  for (const item of items) {
    const number = nameNumber(label(item)[0] ?? "");
    if (options.spokenNumber !== null && number !== options.spokenNumber) continue;
    const words = new Set(label(item).flatMap((text) => meaningful(tokensOf(text), options.ignore)));
    let score = 0;
    for (const word of words) if (heard.has(word)) score++;
    // A spoken number that matches is worth a word.
    if (options.spokenNumber !== null) score++;
    if (score > bestScore) { bestScore = score; best = [item]; }
    else if (score === bestScore && score > 0) best.push(item);
  }
  return { matches: bestScore > 0 ? best : [], used };
}

/** The number spoken straight after one of `keywords` (fridge 1, call point 3). */
function numberAfter(spoken: SpokenToken[], keywords: string[][]): { value: number; index: number } | null {
  for (const keyword of keywords) {
    const at = findSequence(spoken, keyword.map((text) => ({ text, value: null })));
    if (at < 0) continue;
    let i = at + keyword.length;
    while (spoken[i] && (spoken[i].text === "number" || spoken[i].text === "no")) i++;
    // "fridge 3 degrees" is a reading, not fridge number 3.
    if (spoken[i + 1]?.text === "degree") continue;
    if (spoken[i]?.value !== null && spoken[i]?.value !== undefined) return { value: spoken[i].value as number, index: i };
  }
  return null;
}

/** The reading: a number said with "degrees", else the last number left over. */
function temperatureFrom(spoken: SpokenToken[], skip: Set<number>): number | null {
  for (let i = 0; i < spoken.length; i++) {
    if (skip.has(i) || spoken[i].value === null) continue;
    if (spoken[i + 1]?.text === "degree" || spoken[i + 1]?.text === "degrees") return spoken[i].value;
  }
  for (let i = spoken.length - 1; i >= 0; i--) {
    if (!skip.has(i) && spoken[i].value !== null) return spoken[i].value;
  }
  return null;
}

/** Hold times: "held for 30 seconds", "2 minutes". Returns seconds. */
function holdFrom(spoken: SpokenToken[], skip: Set<number>): number | null {
  for (let i = 0; i < spoken.length - 1; i++) {
    const value = spoken[i].value;
    if (value === null) continue;
    const unit = spoken[i + 1].text;
    if (/^(second|sec)$/.test(unit)) { skip.add(i); return Math.round(value); }
    if (/^(minute|min)$/.test(unit)) { skip.add(i); return Math.round(value * 60); }
  }
  return null;
}

const has = (text: string, pattern: RegExp) => pattern.test(` ${text} `);

const FIRE_WORDS = /\s(call point|callpoint|cp|break glass|manual call point|mcp|fire alarm|alarm test|alarm)\s/;
const COLD_WORDS = /\s(fridge|freezer|chiller|cold room|walk in|cool room|refrigerator|reach in|undercounter)\s/;
const WATER_WORDS = /\s(tap|outlet|sentinel|basin|sink|shower|bath|calorifier|tmv|mixing valve|hot water|cold water|cistern|little used|flush|wash hand)\s/;
const CORE_WORDS = /\s(core|cook|cooked|cooking|reheat|reheated|reheating|hot hold|hot holding|holding|held|bain marie|hot cupboard|hotplate|probe|probed|served|serving)\s/;
const REHEAT_WORDS = /\s(reheat|reheated|reheating)\s/;
const HOLD_WORDS = /\s(hot hold|hot holding|holding|bain marie|hot cupboard|hotplate|served|serving)\s/;
const FAIL_WORDS = /\s(fail|failed|failing|faulty|fault|not working|didn't sound|didnt sound|did not sound|no sound|broken|not sounding|not ok|not okay)\s/;
const PASS_WORDS = /\s(pass|passed|ok|okay|working|work|worked|sounded|sounding|good|fine|all clear|all good|satisfactory)\s/;

const titleCase = (text: string) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Read one spoken reading against the person's lists. Never throws; an
 * unclear phrase comes back as { kind: "unknown", reason } to show them.
 */
export function readSpokenReading(text: string, catalogue: VoiceCatalogue): VoiceReading {
  const spoken = tokensOf(text);
  const joined = textOf(spoken);
  if (!spoken.length) return { kind: "unknown", reason: "Nothing was heard. Tap the microphone and try again." };

  // FireTrack: "testing call point 1", "break glass 3 passed".
  if (has(joined, FIRE_WORDS)) {
    if (!catalogue.callPoints) return { kind: "unknown", reason: "FireTrack isn't switched on for this business." };
    const number = numberAfter(spoken, [["call", "point"], ["callpoint"], ["cp"], ["break", "glass"], ["mcp"], ["alarm"]]);
    const { matches } = matchItems(spoken, catalogue.callPoints, (p) => [p.name, ...(p.location ? [p.location] : [])],
      { spokenNumber: number?.value ?? null, ignore: new Set(["call", "point", "callpoint", "cp", "break", "glass", "fire", "alarm", "mcp", "manual"]) });
    const result = has(joined, FAIL_WORDS) ? "fail" : has(joined, PASS_WORDS) ? "pass" : null;
    return {
      kind: "fire_alarm", matches, result,
      spokenItem: number ? `call point ${number.value}` : text.trim(),
    };
  }

  // KitchenTrack fridges and freezers: "fridge 1 is showing 4 degrees".
  const coldExact = catalogue.coldUnits && matchItems(spoken, catalogue.coldUnits, (u) => [u.name], { spokenNumber: null });
  if (has(joined, COLD_WORDS) || (coldExact && coldExact.used.size > 0)) {
    if (!catalogue.coldUnits) return { kind: "unknown", reason: "KitchenTrack isn't switched on for this business." };
    const number = numberAfter(spoken, [["fridge"], ["freezer"], ["chiller"], ["unit"]]);
    let found = coldExact!;
    const skip = new Set<number>(number && !found.used.size ? [number.index] : []);
    if (!found.used.size) {
      const wantFreezer = has(joined, /\sfreezer\s/);
      const wantFridge = has(joined, /\s(fridge|chiller|refrigerator)\s/);
      const pool = catalogue.coldUnits.filter((u) => (wantFreezer ? u.type === "freezer" : wantFridge ? u.type === "fridge" : true));
      found = matchItems(spoken, pool, (u) => [u.name], { spokenNumber: number?.value ?? null });
      // "the fridge is 4 degrees" at a kitchen with one fridge.
      if (!found.matches.length && !number && pool.length === 1) found = { matches: pool, used: new Set() };
    }
    for (const i of found.used) skip.add(i);
    const slot = has(joined, /\s(am|morning|a m)\s/) ? "am" : has(joined, /\s(pm|afternoon|evening|night|p m)\s/) ? "pm" : null;
    const spokenItem = number ? `${spoken[number.index - 1]?.text ?? "unit"} ${number.value}` : found.matches[0]?.name ?? "";
    return { kind: "cold_unit", matches: found.matches, spokenItem, temperature: temperatureFrom(spoken, skip), slot };
  }

  // Legionella outlets: "hot tap ladies toilet 55 degrees", "outlet 3 cold 18".
  if (catalogue.outlets && (has(joined, WATER_WORDS) || matchItems(spoken, catalogue.outlets, (o) => [o.name], { spokenNumber: null }).used.size)) {
    const water = has(joined, /\shot\s/) ? "hot" : has(joined, /\scold\s/) ? "cold" : null;
    const number = numberAfter(spoken, [["outlet"], ["tap"], ["sentinel"], ["basin"], ["shower"], ["sink"]]);
    const pool = catalogue.outlets.filter((o) =>
      water === "hot" ? o.type === "hot" || o.type === "tmv" || o.type === "calorifier"
        : water === "cold" ? o.type === "cold" : true);
    const ignore = new Set(["tap", "outlet", "hot", "cold", "water", "sentinel", "flow"]);
    const found = matchItems(spoken, pool, (o) => [o.name, ...(o.location ? [o.location] : [])],
      { spokenNumber: number?.value ?? null, ignore });
    const skip = new Set<number>([...found.used, ...(number ? [number.index] : [])]);
    // Numbers inside the matched outlet's own name are not the reading.
    if (found.matches.length === 1) {
      const own = new Set(tokensOf(`${found.matches[0].name} ${found.matches[0].location ?? ""}`).filter((t) => t.value !== null).map((t) => t.value));
      spoken.forEach((t, i) => { if (t.value !== null && own.has(t.value) && spoken[i + 1]?.text !== "degrees") skip.add(i); });
    }
    return {
      kind: "water_outlet", matches: found.matches, water,
      spokenItem: text.trim(), temperature: temperatureFrom(spoken, skip),
    };
  }
  if (!catalogue.outlets && has(joined, WATER_WORDS) && !has(joined, CORE_WORDS)) {
    return { kind: "unknown", reason: "Legionella isn't switched on for this business." };
  }

  // KitchenTrack core temperatures: "chicken core temp 78", "reheated the soup to 80".
  if (has(joined, CORE_WORDS)) {
    if (!catalogue.kitchenItems) return { kind: "unknown", reason: "KitchenTrack isn't switched on for this business." };
    const section: KitchenCoreSection = has(joined, REHEAT_WORDS) ? "reheating" : has(joined, HOLD_WORDS) ? "hotHolding" : "hotTemperature";
    const skip = new Set<number>();
    const holdSeconds = holdFrom(spoken, skip);
    const temperature = temperatureFrom(spoken, skip);
    const known = matchItems(spoken, catalogue.kitchenItems, (item) => [item], { spokenNumber: null });
    const keyword = new Set(["core", "cook", "cooked", "cooking", "reheat", "reheated", "reheating", "hot", "hold", "holding",
      "held", "bain", "marie", "cupboard", "hotplate", "probe", "probed", "served", "serving", "second", "sec", "min", "temp",
      "temperature", "for", "until", "reached", "reach", "hit", "got", "up"]);
    const words = spoken.filter((t) => t.value === null && !FILLER.has(t.text) && !keyword.has(t.text)).map((t) => t.text);
    const item = known.used.size ? known.matches[0] : titleCase(words.join(" "));
    return { kind: "kitchen_core", section, item, temperature, holdSeconds };
  }

  return {
    kind: "unknown",
    reason: "I couldn't tell which check that was. Try \"fridge 1 is 4 degrees\", \"chicken core temp 78\", \"testing call point 1\" or \"hot tap ladies toilet 55 degrees\".",
  };
}

/** Whether `value` is inside a min/max range (either end may be missing). */
export function withinLimits(value: number, limits: { min?: number | null; max?: number | null } | null | undefined): boolean {
  if (!limits) return true;
  if (limits.min != null && value < limits.min) return false;
  if (limits.max != null && value > limits.max) return false;
  return true;
}

/** "≥ 75°C", "0°C to 5°C", "≤ 20°C". */
export function limitsLabel(limits: { min?: number | null; max?: number | null } | null | undefined): string {
  if (!limits || (limits.min == null && limits.max == null)) return "no limit set";
  if (limits.min != null && limits.max != null) return `${limits.min}°C to ${limits.max}°C`;
  return limits.min != null ? `${limits.min}°C or above` : `${limits.max}°C or below`;
}

/** AM before noon, PM after, the same as a fridge's QR label. */
export function defaultColdSlot(now: Date = new Date()): "am" | "pm" {
  return now.getHours() < 12 ? "am" : "pm";
}

/** The device's local date (YYYY-MM-DD), the diary day a reading belongs to. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Local time with its UTC offset ("2026-10-21T08:05:00+01:00"), so the
 *  server can check the reading's date matches the diary's. */
export function localTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}
