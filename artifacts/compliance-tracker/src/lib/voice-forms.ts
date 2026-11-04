// "Say it" for the tracks whose records are filled in on a form: what was
// heard is read into the form's fields ("pH 7.4 chlorine 1.5 water 29",
// "kettle in the staff room passed", "mouse droppings in the dry store") and
// the track's own form opens with them filled in, to check and save there.
// Rule based, so it runs in the browser with no AI cost. The item named (a
// hot tub, an appliance, a machine) is matched on the track's page, which
// already has its list.

import { looksLikeProblem, readSpokenAction } from "./voice-actions";
import { tokeniseSpeech, type SpokenToken } from "./voice-log";

export type SayItFormKey =
  | "pool-test" | "swim-surveillance" | "tub-test" | "pat-test" | "pest-activity" | "room-check" | "tree-inspection"
  | "bike" | "machine" | "training" | "incident" | "premises-inspection" | "fix-report";

export type SayItFormReading = {
  form: SayItFormKey;
  /** The track (track_actions.module) the form belongs to. */
  track: string;
  /** What is being recorded, for the card: "water test", "appliance test". */
  label: string;
  /** The page with the form. */
  path: string;
  /** The item said, matched on the page ("hot tub 2", "kettle staff room"). */
  item?: string;
  values: Record<string, string | number | boolean>;
  /** One line per field heard, for the card. */
  summary: string[];
};

// ── Reading helpers ───────────────────────────────────────────────────────────

/** Where the words of `phrase` start in `tokens`, at or after `from`, or -1. */
function find(tokens: SpokenToken[], phrase: string, from = 0): number {
  const want = phrase.split(" ");
  outer: for (let i = from; i + want.length <= tokens.length; i++) {
    for (let k = 0; k < want.length; k++) if (tokens[i + k].text !== want[k]) continue outer;
    return i;
  }
  return -1;
}

/** The number said straight after one of `keywords` (skipping "is", "at",
 *  "reading" and the like), with where it was. */
function numberAfter(tokens: SpokenToken[], keywords: string[], skip: Set<number> = new Set()): { value: number; index: number } | null {
  for (const keyword of keywords) {
    let at = find(tokens, keyword);
    while (at >= 0) {
      let i = at + keyword.split(" ").length;
      while (i < tokens.length && tokens[i].value === null && GAP.has(tokens[i].text)) i++;
      if (i < tokens.length && tokens[i].value !== null && !skip.has(i)) return { value: tokens[i].value as number, index: i };
      at = find(tokens, keyword, at + 1);
    }
  }
  return null;
}
const GAP = new Set(["is", "at", "of", "was", "reading", "read", "level", "showing", "now", "the", "a", "about", "around", "temp", "temperature", "degree", "degrees", "c", "mg", "per", "litre", "l", "ppm", "count", "number", "no", "on", "meter", "reads", "says"]);

const has = (tokens: SpokenToken[], ...phrases: string[]) => phrases.some((p) => find(tokens, p) >= 0);
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const clean = (text: string) => text.trim().replace(/\s+/g, " ").replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");

/** The words before the first of `stopWords` (the item named), without filler. */
function itemBefore(text: string, stopWords: RegExp): string {
  const said = ` ${text.toLowerCase().replace(/[^a-z0-9.'\s-]/g, " ")} `;
  const match = stopWords.exec(said);
  const before = match ? said.slice(0, match.index) : said;
  return clean(before.replace(/\b(?:the|a|an|um+|er+|erm|ok(?:ay)?|right|so|just|please|i|i've|we|we've|have|has|checked|tested|testing|test|check)\b/g, " "));
}

const PLACE_STOP = /^(and|but|with|has|had|have|is|was|were|are|it|its|it's|that|which|who|urgent\w*|today|again|this|dead|broken|leak\w*|loose|missing|needs?|not|hurt|slipped|fell|tripped|cut|hanging|split|cracked|damaged)$/;

/** "in the dry store", "behind the bar fridge": the place said, up to four
 *  words. "in", "at", "behind" and the like win over "on" ("slipped on the
 *  wet floor in the bar" is in the bar). */
function placeIn(text: string): string | undefined {
  const said = text.toLowerCase().replace(/[^a-z0-9'\s,.;-]/g, " ");
  for (const prepositions of [/\b(?:in|at|by|near|behind|under|underneath|beside|next to|outside|inside)\s+/g, /\bon\s+/g]) {
    for (const match of said.matchAll(prepositions)) {
      const rest = said.slice((match.index ?? 0) + match[0].length).split(/[,.;]/)[0].trim().split(/\s+/);
      const place: string[] = [];
      for (const word of rest) {
        if (place.length === 4 || PLACE_STOP.test(word)) break;
        if (place.length === 0 && /^(the|a|an|our|my)$/.test(word)) continue;
        place.push(word);
      }
      if (place.length) return clean(place.join(" "));
    }
  }
  return undefined;
}

const PASS = /\b(pass|passed|passes|ok|okay|good|fine|all good|satisfactory|safe)\b/i;
const FAIL = /\b(fail|failed|fails|failing|faulty|unsafe|not safe|condemned|broken|damaged|frayed)\b/i;

// ── Forms ─────────────────────────────────────────────────────────────────────

/** AquaTrack water test: "pH 7.4, free chlorine 1.5, combined 0.2, water 29". */
export function readPoolTest(text: string): SayItFormReading | null {
  const tokens = tokeniseSpeech(text.replace(/\bp\s*h\b/gi, "ph"));
  const values: SayItFormReading["values"] = {};
  const summary: string[] = [];
  const used = new Set<number>();
  const take = (keywords: string[]) => { const found = numberAfter(tokens, keywords, used); if (found) used.add(found.index); return found?.value; };
  const ph = take(["ph"]);
  if (ph !== undefined && ph >= 0 && ph <= 14) { values.ph = ph; summary.push(`pH ${fmt(ph)}`); }
  const combined = take(["combined chlorine", "combined"]);
  if (combined !== undefined) { values.combinedChlorine = combined; summary.push(`Combined chlorine ${fmt(combined)} mg/L`); }
  const free = take(["free chlorine", "chlorine", "free"]);
  if (free !== undefined) { values.freeChlorine = free; summary.push(`Free chlorine ${fmt(free)} mg/L`); }
  const air = take(["air temperature", "air temp", "air"]);
  if (air !== undefined) { values.airTemp = air; summary.push(`Air ${fmt(air)}°C`); }
  const water = take(["water temperature", "water temp", "pool temperature", "pool temp", "water", "temperature", "temp"]);
  if (water !== undefined) { values.waterTemp = water; summary.push(`Water ${fmt(water)}°C`); }
  const turbidity = has(tokens, "slightly hazy") ? "slightly_hazy" : has(tokens, "cloudy") ? "cloudy" : has(tokens, "hazy") ? "hazy"
    : has(tokens, "clear") ? "clear" : null;
  if (turbidity) { values.turbidity = turbidity; summary.push(`Water ${turbidity.replace("_", " ")}`); }
  const checkType = has(tokens, "opening", "open") ? "opening" : has(tokens, "closing", "close") ? "closing" : has(tokens, "weekly") ? "weekly" : null;
  if (!summary.length) return null;
  if (checkType) { values.checkType = checkType; summary.unshift(`${titleCase(checkType)} check`); }
  return { form: "pool-test", track: "pool", label: "water test", path: "/aqua-track", values, summary };
}

/** AquaTrack poolside surveillance: "surveillance scan done, 24 bathers". */
export function readSwimSurveillance(text: string): SayItFormReading | null {
  const tokens = tokeniseSpeech(text);
  if (!has(tokens, "bather", "swimmer", "surveillance", "scan", "lifeguard")) return null;
  const values: SayItFormReading["values"] = {};
  const summary: string[] = [];
  let bathers = numberAfter(tokens, ["bather count", "bather", "swimmer"]);
  if (!bathers) {
    const i = tokens.findIndex((t, k) => t.value !== null && /^(bather|swimmer|people|person|in)$/.test(tokens[k + 1]?.text ?? ""));
    if (i >= 0) bathers = { value: tokens[i].value as number, index: i };
  }
  if (bathers) { values.batherCount = Math.round(bathers.value); summary.push(`${Math.round(bathers.value)} bathers`); }
  const missed = /\b(missed|not done|not completed|didn'?t|did not|incomplete)\b/i.test(text);
  values.scanCompleted = !missed;
  summary.push(missed ? "Scan not completed" : "Scan completed");
  if (looksLikeProblem(text) || missed) values.observations = clean(text);
  return { form: "swim-surveillance", track: "swim", label: "surveillance check", path: "/aqua-track", values, summary };
}

/** TubTrack water chemistry: "hot tub 2, pH 7.4, chlorine 4, 38 degrees". */
export function readTubTest(text: string): SayItFormReading | null {
  const tokens = tokeniseSpeech(text.replace(/\bp\s*h\b/gi, "ph"));
  const values: SayItFormReading["values"] = {};
  const summary: string[] = [];
  const used = new Set<number>();
  const take = (keywords: string[]) => { const found = numberAfter(tokens, keywords, used); if (found) used.add(found.index); return found?.value; };
  const ph = take(["ph"]);
  if (ph !== undefined && ph >= 0 && ph <= 14) { values.ph = ph; summary.push(`pH ${fmt(ph)}`); }
  const sanitiser = take(["free chlorine", "chlorine", "bromine", "sanitiser", "sanitizer"]);
  if (sanitiser !== undefined) { values.sanitiser = sanitiser; summary.push(`Sanitiser ${fmt(sanitiser)} ppm`); }
  let temperature = take(["water temperature", "water temp", "temperature", "temp", "water"]);
  if (temperature === undefined) {
    const i = tokens.findIndex((t, k) => t.value !== null && !used.has(k) && /^degree/.test(tokens[k + 1]?.text ?? ""));
    if (i >= 0) temperature = tokens[i].value as number;
  }
  if (temperature !== undefined) { values.temperature = temperature; summary.push(`Water ${fmt(temperature)}°C`); }
  if (!summary.length) return null;
  const item = itemBefore(text, /\b(?:ph|p h|chlorine|bromine|sanitiser|sanitizer|free|temp|temperature|water|is|at|reading)\b|\d+(?:\.\d+)?\s*(?:degrees|°)/);
  if (item) summary.unshift(`Tub: "${item}"`);
  return { form: "tub-test", track: "hot_tub", label: "water chemistry test", path: "/hot-tub", item: item || undefined, values, summary };
}

/** PATtrack appliance test: "kettle in the staff room passed". */
export function readPatTest(text: string): SayItFormReading | null {
  const result = FAIL.test(text) ? "fail" : PASS.test(text) ? "pass" : null;
  if (!result) return null;
  const item = clean(text.toLowerCase()
    .replace(/\b(?:pat|tested|testing|test|has|have|it|the|a|an|um+|er+|i've|we've|just|and|is|was|it's|its|result)\b/g, " ")
    .replace(new RegExp(FAIL.source, "gi"), " ").replace(new RegExp(PASS.source, "gi"), " "));
  return {
    form: "pat-test", track: "pat", label: "appliance test", path: "/pat-track", item: item || undefined,
    values: { result }, summary: [...(item ? [`Appliance: "${item}"`] : []), result === "pass" ? "Pass" : "Fail"],
  };
}

const PEST_TYPES: Array<[RegExp, string, string]> = [
  [/\b(mouse|mice|rat|rats|rodent\w*|squirrel\w*)\b/i, "rodent", "Rodent"],
  [/\b(fly|flies|ant|ants|cockroach\w*|roach\w*|wasp\w*|insect\w*|moth\w*|beetle\w*|weevil\w*|bed ?bugs?|fleas?|silverfish)\b/i, "insect", "Insect"],
  [/\b(bird\w*|pigeon\w*|seagull\w*|gull\w*|sparrow\w*|starling\w*)\b/i, "bird", "Bird"],
];
const EVIDENCE: Array<[RegExp, string, string]> = [
  [/\bdroppings?\b|\bpoo\b/i, "droppings", "Droppings"],
  [/\b(nest\w*|harbourage|burrow\w*)\b/i, "nest", "Nest / harbourage"],
  [/\b(gnaw\w*|chew\w*|damage\w*|nibbled|holes?)\b/i, "damage", "Damage"],
  [/\b(tracks?|smear\w*|footprints?|runs?)\b/i, "tracks", "Tracks / smear marks"],
  [/\b(saw|seen|see|spotted|live|sighting|running|alive|dead)\b/i, "live_sighting", "Live sighting"],
];

/** PestTrack activity: "mouse droppings in the dry store". */
export function readPestActivity(text: string): SayItFormReading | null {
  const type = PEST_TYPES.find(([pattern]) => pattern.test(text));
  const evidence = EVIDENCE.find(([pattern]) => pattern.test(text));
  if (!type && !evidence) return null;
  const values: SayItFormReading["values"] = { notes: clean(text) };
  const summary: string[] = [];
  if (type) { values.pestType = type[1]; summary.push(type[2]); }
  if (evidence) { values.evidenceType = evidence[1]; summary.push(evidence[2]); }
  const location = placeIn(text);
  if (location) { values.location = titleCase(location); summary.push(`Location: ${titleCase(location)}`); }
  const severity = /\b(urgent\w*|infest\w*|lots|loads|everywhere|serious|high|many)\b/i.test(text) ? "high"
    : /\b(some|several|few|medium|again)\b/i.test(text) ? "medium" : null;
  if (severity) { values.severity = severity; summary.push(`Severity: ${severity}`); }
  return { form: "pest-activity", track: "pest", label: "pest activity", path: "/pest-track", values, summary };
}

/** RoomTrack housekeeping: "room 12 clean and tidy", "room 4 all done". */
export function readRoomCheck(text: string): SayItFormReading | null {
  const room = /\b(?:room|bedroom|suite|apartment|lodge|cabin)\s+(?:number\s+)?([a-z]?\d+[a-z]?)\b/i.exec(text)
    ?? /\b(?:room|bedroom|suite)\s+([a-z][a-z' -]{1,30}?)(?=\s+(?:is|clean|tidy|to|all|done|complete|needs?|has)\b|$)/i.exec(text);
  if (!room) return null;
  const all = /\b(all|everything|fully|completely)\b.*\b(done|good|complete|fine|ok|okay|clean|ticked)\b|\b(done|complete|completed|finished|to standard)\b/i.test(text);
  const clean_ = all || /\bclean(ed)?\b/i.test(text);
  const tidy = all || /\btid(y|ied)\b/i.test(text);
  const toStandard = all || /\b(to standard|standard|ready)\b/i.test(text);
  const values: SayItFormReading["values"] = { clean: clean_, tidy, toStandard };
  const summary = [`Room: "${room[0].trim()}"`, ...(clean_ ? ["Clean"] : []), ...(tidy ? ["Tidy"] : []), ...(toStandard ? ["To standard"] : [])];
  if (looksLikeProblem(text)) { values.notes = titleCase(clean(text)); summary.push(`Note: ${values.notes}`); }
  return { form: "room-check", track: "room", label: "housekeeping check", path: "/room-track", item: room[0].trim(), values, summary };
}

const TREE_FAULTS = /\b(dead\w*|rot\w*|decay\w*|split\w*|crack\w*|hanging|leaning|lean|snapped|broken|fallen|fungus|fungal|cavity|hollow|loose|damage\w*|diseased?|unstable|uprooted|storm damage)\b/i;

/** TreeTrack inspection: "tree T12 by the car park, dead branch hanging, urgent". */
export function readTreeInspection(text: string): SayItFormReading | null {
  if (!/\btrees?\b/i.test(text)) return null;
  const ref = /\btree\s+(?:number\s+|no\.?\s+|ref\s+)?([a-z]{0,3}\s?\d+[a-z]?)\b/i.exec(text);
  const values: SayItFormReading["values"] = { notes: titleCase(clean(text)) };
  const summary: string[] = [];
  if (ref) { values.treeRef = ref[1].replace(/\s+/g, "").toUpperCase(); summary.push(`Tree ${values.treeRef}`); }
  const location = placeIn(text);
  if (location) { values.location = titleCase(location); summary.push(`Location: ${titleCase(location)}`); }
  const fault = TREE_FAULTS.test(text) || /\b(fail|failed|action)\b/i.test(text);
  values.result = fault ? "fail" : "pass";
  summary.push(fault ? "Needs action" : "No concerns");
  if (fault) {
    const severity = /\b(urgent\w*|immediately|danger\w*|unsafe|emergency|hanging)\b/i.test(text) ? "urgent_action"
      : /\b(monitor|watch|keep an eye)\b/i.test(text) ? "monitor" : "action_required";
    values.actionSeverity = severity;
    summary.push(severity === "urgent_action" ? "Urgent action" : severity === "monitor" ? "Monitor" : "Action required");
  }
  if (/\bstorm\b/i.test(text)) { values.checkType = "post_storm"; summary.unshift("Post-storm check"); }
  return { form: "tree-inspection", track: "tree", label: "tree inspection", path: "/tree-track", values, summary };
}

/** BikeTrack: "bike 4" (hire it out or take it back), "service bike 4". */
export function readBike(text: string): SayItFormReading | null {
  const bike = /\b(?:e-?bike|bike|bicycle|cycle)\s+(?:number\s+|no\.?\s+)?([a-z]{0,3}\s?-?\d+[a-z]?)\b/i.exec(text);
  if (!bike) return null;
  const intent = /\b(servic\w*|repair\w*|maintenance|fix\w*|puncture|brakes?|chain)\b/i.test(text) ? "service"
    : /\b(back|returned|return\w*|in)\b/i.test(text) ? "return" : /\b(hire\w*|out|rent\w*|lend|book\w*)\b/i.test(text) ? "hire" : "open";
  const label = intent === "service" ? "service" : intent === "return" ? "return" : intent === "hire" ? "hire" : "hire or return";
  return {
    form: "bike", track: "bike", label, path: "/bike-track", item: bike[0].trim(), values: { intent, notes: clean(text) },
    summary: [`Bike: "${bike[0].trim()}"`, titleCase(label)],
  };
}

/** GreenTrack machines: "fairway mower 1 pre-use", "greens mower 20 litres",
 *  "tractor hours 1250", "fairway mower 2 hydraulic leak". */
export function readMachine(text: string): SayItFormReading | null {
  const tokens = tokeniseSpeech(text);
  const litres = numberAfter(tokens, ["fuel", "diesel", "petrol", "filled", "fill"])
    ?? (() => { const i = tokens.findIndex((t, k) => t.value !== null && /^(litre|liter|l)$/.test(tokens[k + 1]?.text ?? "")); return i >= 0 ? { value: tokens[i].value as number, index: i } : null; })();
  const hours = numberAfter(tokens, ["hour meter", "hours", "hour", "hrs"])
    ?? (() => { const i = tokens.findIndex((t, k) => t.value !== null && /^(hour|hr)$/.test(tokens[k + 1]?.text ?? "")); return i >= 0 ? { value: tokens[i].value as number, index: i } : null; })();
  const defect = !litres && !hours && looksLikeProblem(text);
  const preUse = /\b(pre ?-?use|pre ?-?start|daily check|start(ing)? check|walk ?round)\b/i.test(text);
  const machineWords = /\b(mower|tractor|machine|strimmer|sprayer|blower|utility|vehicle|buggy|gator|roller|aerator|scarifier|chainsaw|hedge ?cutter|excavator|digger|trailer|quad|atv|cart|unit)\b/i;
  if (!litres && !hours && !defect && !preUse && !machineWords.test(text)) return null;
  const intent = litres ? "fuel" : hours ? "hours" : defect ? "defect" : "pre-use";
  const values: SayItFormReading["values"] = { intent };
  const summary: string[] = [];
  if (litres) { values.litres = litres.value; summary.push(`Fuel: ${fmt(litres.value)} litres`); }
  else if (hours) { values.hours = hours.value; summary.push(`Hour meter: ${fmt(hours.value)}`); }
  else if (defect) { values.description = readSpokenAction(text).title; summary.push(`Defect: ${values.description}`); }
  else summary.push("Pre-use check");
  const item = itemBefore(text, /\b(?:pre ?-?use|pre ?-?start|daily|start|walk ?round|fuel|diesel|petrol|filled|fill|hour|hours|hrs|has|is|needs?|with|leak\w*|broken|damaged?|missing|faulty|not)\b|\d+(?:\.\d+)?\s*(?:litres?|liters?|l|hours?|hrs)\b/);
  if (item) summary.unshift(`Machine: "${item}"`);
  const label = intent === "fuel" ? "fuel log" : intent === "hours" ? "hour meter reading" : intent === "defect" ? "defect report" : "pre-use check";
  return { form: "machine", track: "green", label, path: "/green-track", item: item || undefined, values, summary };
}

/** TrainTrack: "Jane Smith completed fire marshal training today". */
export function readTraining(text: string): SayItFormReading | null {
  const match = /^(.*?)\s+(?:has\s+|have\s+)?(?:completed|done|did|passed|finished|attended|took|undertook|got)\s+(?:the\s+|a\s+|an\s+|her\s+|his\s+|their\s+)?(.+?)(?:\s+(?:training|course|certificate))?(?:\s+(?:today|yesterday|this morning|this week))?[.!]*$/i.exec(text.trim());
  if (!match) return null;
  const name = clean(match[1].replace(/^(?:um+|er+|so|ok(?:ay)?|right)\s+/i, ""));
  const course = clean(match[2]);
  if (!name || !course || name.split(" ").length > 5) return null;
  const date = /\byesterday\b/i.test(text) ? "yesterday" : "today";
  return {
    form: "training", track: "train", label: "training record", path: "/train-track",
    values: { staffName: name.replace(/\b[a-z]/g, (c) => c.toUpperCase()), trainingType: titleCase(course), date },
    summary: [`Staff: ${name.replace(/\b[a-z]/g, (c) => c.toUpperCase())}`, `Training: ${titleCase(course)}`, `Completed ${date}`],
  };
}

/** IncidentTrack: what happened, and where. */
export function readIncident(text: string): SayItFormReading | null {
  const said = clean(text);
  if (said.split(" ").length < 3) return null;
  const values: SayItFormReading["values"] = { description: titleCase(said) };
  const summary = [`What happened: ${titleCase(said)}`];
  const location = placeIn(said);
  if (location) { values.location = titleCase(location); summary.push(`Location: ${titleCase(location)}`); }
  return { form: "incident", track: "incident", label: "incident report", path: "/incidents", values, summary };
}

/** PremisesTrack inspection: "stairwell, loose handrail on the top flight". */
export function readPremisesInspection(text: string): SayItFormReading | null {
  const said = clean(text);
  if (said.split(" ").length < 2) return null;
  // "Stairwell, loose handrail": the words before a comma name the area.
  const lead = /^([^,]{2,60}),\s*(.+)$/.exec(said);
  const findings = lead ? lead[2] : said;
  const values: SayItFormReading["values"] = { findings: titleCase(findings) };
  const summary = [`Findings: ${titleCase(findings)}`];
  const area = lead?.[1] ?? placeIn(said);
  if (area) { values.area = titleCase(clean(area)); summary.unshift(`Area: ${values.area}`); }
  if (looksLikeProblem(findings)) { values.actionRequired = readSpokenAction(findings).title; summary.push("Action needed"); }
  return { form: "premises-inspection", track: "premises", label: "inspection", path: "/premises-track", values, summary };
}

/** FixTrack: a new report with the title said. */
export function readFixReport(text: string): SayItFormReading | null {
  const said = clean(text);
  if (!said) return null;
  const { title, severity } = readSpokenAction(said);
  const location = placeIn(said);
  return {
    form: "fix-report", track: "fix", label: "repair report", path: "/fix-track", values: { title, ...(location ? { location: titleCase(location) } : {}), urgent: severity === "urgent" },
    summary: [`Title: ${title}`, ...(location ? [`Location: ${titleCase(location)}`] : []), ...(severity === "urgent" ? ["Urgent"] : [])],
  };
}

const READERS: Record<string, Array<(text: string) => SayItFormReading | null>> = {
  pool: [readSwimSurveillance, readPoolTest],
  swim: [readSwimSurveillance, readPoolTest],
  hot_tub: [readTubTest],
  pat: [readPatTest],
  pest: [readPestActivity],
  room: [readRoomCheck],
  tree: [readTreeInspection],
  bike: [readBike],
  green: [readMachine],
  train: [readTraining],
  incident: [readIncident],
  premises: [readPremisesInspection],
  fix: [readFixReport],
};

/** What to suggest saying on each track's page. */
export const FORM_EXAMPLES: Record<string, string> = {
  pool: "pH 7.4, chlorine 1.5, water 29 degrees",
  swim: "surveillance scan done, 24 bathers",
  hot_tub: "hot tub 2, pH 7.4, chlorine 4, 38 degrees",
  pat: "kettle in the staff room passed",
  pest: "mouse droppings in the dry store",
  room: "room 12 all done",
  tree: "tree T12 by the car park, dead branch, urgent",
  bike: "bike 4 is back",
  green: "fairway mower 1 pre-use check",
  train: "Jane Smith completed fire marshal training",
  incident: "guest slipped on the wet floor in the bar",
  premises: "stairwell, loose handrail on the top flight",
  fix: "light out in the back corridor",
};

/** Tracks whose form takes any words (a report, not a reading). */
export const OPEN_FORM_TRACKS = new Set(["incident", "premises", "fix"]);

/** The tracks Say it can fill a form for. */
export const FORM_TRACKS = Object.keys(READERS);

/** Read a phrase into `track`'s form, or null when it isn't one. */
export function readSayItForm(text: string, track: string | null | undefined): SayItFormReading | null {
  if (!track || !text.trim()) return null;
  for (const read of READERS[track] ?? []) {
    const reading = read(text);
    if (reading) return reading;
  }
  return null;
}
