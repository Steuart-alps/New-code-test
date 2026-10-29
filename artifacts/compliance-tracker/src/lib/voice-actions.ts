// "Say it" on every track page: anything that isn't a reading Say it can log
// (fridge, core temperature, call point, water outlet) can be raised as an
// action on the track ("pool gate latch is broken, urgent") or reported in
// FixTrack. Rule based, so it runs in the browser with no AI cost. Like the
// readings, it is only a suggestion the person checks before tapping Save.

export type ActionSeverity = "monitor" | "action_required" | "urgent";

export type SayItTrack = {
  /** track_actions.module (api-server routes/track-actions.ts). */
  key: string;
  label: string;
  /** The business needs any one of these services. */
  services: string[];
  /** Pages that belong to the track. */
  paths: string[];
  /** Shown in the Say it box as an example of what to say. */
  example: string;
  /** Words that point to this track when the page doesn't say. */
  words?: RegExp;
};

// Labels and services match api-server lib/trackModules.ts.
export const SAY_IT_TRACKS: readonly SayItTrack[] = [
  { key: "kitchen", label: "KitchenTrack", services: ["kitchentrack"], paths: ["/kitchen", "/food-safety"],
    example: "dishwasher isn't reaching temperature",
    words: /\b(fridge|freezer|food|kitchen|oven|dishwasher|probe|chiller|hob|fryer|extractor)\b/ },
  { key: "fire", label: "FireTrack", services: ["firetrack"], paths: ["/fire-safety"],
    example: "fire door on the first floor is wedged open",
    words: /\b(fire|extinguisher|call point|smoke|emergency light|evacuation|sprinkler|alarm panel)\b/ },
  { key: "legionella", label: "LegionellaTrack", services: ["legionellatrack"], paths: ["/legionella", "/water-safety"],
    example: "shower head in room 5 needs descaling",
    words: /\b(legionella|tap|outlet|calorifier|water tank|shower head|descal\w*|tmv)\b/ },
  { key: "pool", label: "AquaTrack (water tests)", services: ["aquatrack", "pooltrack"], paths: ["/aqua-track", "/pool-track"],
    example: "pool gate latch is broken, urgent",
    words: /\b(pool|chlorine|ph|plant room|backwash)\b/ },
  { key: "swim", label: "AquaTrack (sessions & safety)", services: ["aquatrack", "swimtrack"], paths: ["/swim-track"],
    example: "lifeguard chair needs a new step",
    words: /\b(lifeguard|swimmer|swim)\b/ },
  { key: "hot_tub", label: "TubTrack", services: ["hottubtrack"], paths: ["/hot-tub"],
    example: "hot tub cover strap is torn",
    words: /\b(hot tub|spa|jacuzzi|tub)\b/ },
  { key: "pat", label: "PATtrack", services: ["pattrack"], paths: ["/pat-track"],
    example: "kettle cable in the staff room is frayed",
    words: /\b(pat|plug|cable|socket|appliance|kettle|extension lead|lead|toaster|heater)\b/ },
  { key: "pest", label: "PestTrack", services: ["pesttrack"], paths: ["/pest-track"],
    example: "mouse droppings in the dry store, urgent",
    words: /\b(pest|mouse|mice|rat|rats|rodent|droppings|insect|flies|fly|wasp|wasps|cockroach\w*|ants|bait)\b/ },
  { key: "fix", label: "FixTrack", services: ["fixtrack"], paths: ["/fix-track"],
    example: "light out in the back corridor" },
  { key: "premises", label: "PremisesTrack", services: ["premisestrack"], paths: ["/premises-track"],
    example: "loose handrail on the main stairs" },
  { key: "room", label: "RoomTrack", services: ["roomtrack"], paths: ["/room-track"],
    example: "room 12 shower is leaking",
    words: /\b(bedroom|room \d+)\b/ },
  { key: "doc", label: "DocTrack", services: ["doctrack", "safetrack"], paths: ["/doc-track", "/safe-track", "/documents"],
    example: "fire risk assessment needs reviewing",
    words: /\b(risk assessment|policy|document|procedure|method statement)\b/ },
  { key: "train", label: "TrainTrack", services: ["traintrack"], paths: ["/train-track", "/staff-training", "/my-training"],
    example: "new starter needs manual handling training",
    words: /\b(training|trained|induction|refresher|course)\b/ },
  { key: "tree", label: "TreeTrack", services: ["treetrack"], paths: ["/tree-track"],
    example: "large branch hanging over the car park, urgent",
    words: /\b(tree|trees|branch|branches|bough)\b/ },
  { key: "bike", label: "BikeTrack", services: ["biketrack"], paths: ["/bike-track"],
    example: "bike 4 needs new brake pads",
    words: /\b(bike|bikes|bicycle|cycle|ebike)\b/ },
  { key: "green", label: "GreenTrack", services: ["greentrack"], paths: ["/green-track"],
    example: "fairway mower has a hydraulic leak",
    words: /\b(mower|tractor|greens|fairway|bunker|course machine|strimmer|sprayer)\b/ },
  { key: "coshh", label: "COSHHTrack", services: ["coshhtrack"], paths: ["/coshh-track", "/coshh"],
    example: "bleach stored on the wrong shelf",
    words: /\b(coshh|chemical|chemicals|bleach|substance|substances|safety data sheet)\b/ },
  { key: "incident", label: "IncidentTrack", services: ["incidenttrack"], paths: ["/incidents"],
    example: "wet floor sign missing by the kitchen door" },
  { key: "daily_am", label: "DailyTrack AM", services: ["dailytrack_am", "kitchentrack", "premisestrack"], paths: ["/daily-track-am", "/daily/am"],
    example: "back door lock is sticking" },
  { key: "daily_pm", label: "DailyTrack PM", services: ["dailytrack_pm", "kitchentrack", "premisestrack"], paths: ["/daily-track-pm", "/daily/pm"],
    example: "car park light left on overnight" },
];

const byKey = new Map(SAY_IT_TRACKS.map((track) => [track.key, track]));
export const sayItTrack = (key: string | null | undefined) => (key ? byKey.get(key) : undefined);

/** The track a page belongs to ("/aqua-track?tab=x" -> "pool"), or null. */
export function trackForPath(path: string): string | null {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const found = SAY_IT_TRACKS.find((track) => track.paths.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`)));
  return found?.key ?? null;
}

/** Tracks the person can raise an action on. KitchenTrack actions are for
 *  Owners and Consultants only, the same as its actions list. */
export function actionTracks(hasService: (key: string) => boolean, role: string | null | undefined): SayItTrack[] {
  if (!role || role === "client_viewer") return [];
  const kitchenManager = role === "client_admin" || role === "consultant";
  return SAY_IT_TRACKS.filter((track) => track.services.some(hasService) && (track.key !== "kitchen" || kitchenManager));
}

/** The track a phrase talks about, from the tracks offered, or null. */
export function guessTrack(text: string, tracks: readonly SayItTrack[]): string | null {
  const said = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  return tracks.find((track) => track.words?.test(said))?.key ?? null;
}

const PROBLEM_WORDS = /\b(broken|broke|break|leak\w*|damaged?|missing|faulty|fault|not working|doesn'?t work|isn'?t working|won'?t|blocked|cracked|loose|frayed|torn|stuck|sticking|wedged|trip hazard|hazard|unsafe|dangerous|danger|needs?|need to|replace|repair|fix|report|problem|issue|spill\w*|overflow\w*|smell\w*|droppings|out of order|failed|fail|expired|dirty|mould|mold|slippery|wet floor|flooded|flood|no hot water|no power|tripped|sparking|burnt|burned)\b/i;

/** Whether a phrase sounds like something to fix or follow up. */
export function looksLikeProblem(text: string): boolean {
  return PROBLEM_WORDS.test(text);
}

const URGENT_WORDS = /\b(urgent\w*|emergency|immediately|right away|asap|straight away|dangerous|danger|unsafe|critical|serious|flood\w*|sparking|injur\w*)\b/i;
const MONITOR_WORDS = /\b(monitor|keep an eye|watch|low priority|not urgent|when you get a chance|at some point|minor)\b/i;

// Said to Say it rather than about the problem: "report that", "raise an action for".
const LEADING = /^(?:(?:um+|er+|erm|ok(?:ay)?|right|so|please|can you|could you|i want to|i'd like to|i need to|we need to)[\s,]+)*(?:(?:report|raise|log|add|create|record|note)(?:\s+(?:an?|the|new))?(?:\s+(?:action|issue|problem|fault|job|defect))?(?:\s+(?:that|for|about|on))?[\s,:]+|(?:action|issue|problem|fault|defect)[\s,:]+)?/i;
const TRAILING = /[\s,.;:-]*(?:(?:it'?s|this is|that'?s|mark it(?: as)?|make it|priority)?\s*(?:urgent(?:ly)?|very urgent|an emergency|not urgent|low priority|high priority|critical)\s*)+[.!]*$/i;

/**
 * Turn a spoken problem into an action: a title to show the person and how
 * urgent it sounds. "Report that the pool gate latch is broken, urgent" ->
 * { title: "Pool gate latch is broken", severity: "urgent" }.
 */
export function readSpokenAction(text: string): { title: string; severity: ActionSeverity } {
  const said = text.trim().replace(/\s+/g, " ");
  const severity: ActionSeverity = URGENT_WORDS.test(said) && !/\bnot urgent\b/i.test(said) ? "urgent"
    : MONITOR_WORDS.test(said) ? "monitor" : "action_required";
  let title = said.replace(LEADING, "").replace(TRAILING, "").replace(/[\s,;:-]+$/, "").trim();
  if (!title) title = said;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return { title: title.slice(0, 500), severity };
}
