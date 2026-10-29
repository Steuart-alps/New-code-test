/**
 * Compliance checks from a spreadsheet: the pure part of the "compliance-checks"
 * import (routes/csv-imports.ts planComplianceChecks).
 *
 * Businesses arrive with their own compliance checklist, usually one line per
 * contractor service: "Fire Alarm Maintenance | 6 monthly | 28/09/2026 |
 * 28/03/2027 | Acme Fire". Each line is matched to ComplyTrack's own
 * check where there is one (the starter checks and the checks the tracks show),
 * so it lands on the same record the track, the certificate reader and the
 * reminders already use, instead of a second copy with the business's wording.
 *
 * Everything here is pure so it can be unit tested without a database.
 */
import { normaliseKey } from "./csvImport";

/** What a "Time period" / "Frequency" cell says. */
export type RepeatReading =
  | { kind: "months"; months: number }
  /** Weekly, daily, fortnightly: a track checklist, not a compliance check. */
  | { kind: "under_a_month" }
  | { kind: "unknown" };

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18,
};

/**
 * Read a repeat interval written the way people write them: "Annual",
 * "6 monthly", "Six-monthly", "Quarterly", "5 years", "Every 3 years", "24".
 * A cell naming two different intervals ("6 monthly / annual") or a range
 * ("usually 2-5 years") is unknown: the business sets it on the check.
 */
export function parseRepeat(text: string | null | undefined): RepeatReading {
  const value = (text ?? "").toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
  if (!value) return { kind: "unknown" };
  if (/\b(daily|weekly|fortnightly|every day|every week|each day|each week|per week|per day|hourly|twice a week)\b/.test(value)) {
    return { kind: "under_a_month" };
  }
  if (/\d\s*(-|to)\s*\d/.test(value) || /\bvarious\b|\bvaries\b|\bvariable\b/.test(value)) return { kind: "unknown" };
  const found = new Set<number>();
  const number = (word: string) => (/^\d+$/.test(word) ? Number(word) : WORD_NUMBERS[word] ?? NaN);
  const NUM = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|eighteen)";
  for (const match of value.matchAll(new RegExp(`${NUM}[ -]?(years?|yearly|yrs?)\\b`, "g"))) found.add(number(match[1]) * 12);
  for (const match of value.matchAll(new RegExp(`${NUM}[ -]?(months?|monthly|mths?)\\b`, "g"))) found.add(number(match[1]));
  const withoutNumbered = value.replace(new RegExp(`${NUM}[ -]?(years?|yearly|yrs?|months?|monthly|mths?)\\b`, "g"), " ");
  if (/\b(annual|annually|yearly|every year|each year|per year|per annum|once a year|12 monthly)\b/.test(withoutNumbered)) found.add(12);
  if (/\b(half[ -]?yearly|bi-?annual|biannual|twice a year|six-?monthly)\b/.test(withoutNumbered)) found.add(6);
  if (/\b(quarterly|every quarter)\b/.test(withoutNumbered)) found.add(3);
  if (/\b(bi-?ennial|biennial|every other year)\b/.test(withoutNumbered)) found.add(24);
  if (/\b(monthly|every month|each month|per month|once a month)\b/.test(withoutNumbered)) found.add(1);
  if (/^\d+$/.test(value)) found.add(Number(value));
  const months = [...found].filter((n) => Number.isInteger(n) && n >= 1 && n <= 120);
  if (months.length === 1 && found.size === 1) return { kind: "months", months: months[0] };
  return { kind: "unknown" };
}

/**
 * Whole calendar months from one YYYY-MM-DD day to a later one, when the later
 * day is that many months on (give or take a few days), else null. Reads the
 * repeat from "last done 22/08/2024, due 22/08/2027" when the cell says
 * "Various".
 */
export function monthsBetween(from: string, to: string): number | null {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td - fd > 15) months++;
  else if (fd - td > 15) months--;
  if (months < 1 || months > 120) return null;
  const expected = Date.UTC(fy, fm - 1 + months, Math.min(fd, new Date(Date.UTC(fy, fm + months, 0)).getUTCDate()));
  const actual = Date.UTC(ty, tm - 1, td);
  return Math.abs(actual - expected) <= 7 * 86_400_000 ? months : null;
}

export interface KnownCheck {
  /** ComplyTrack's title for this check: the one its track shows, else the starter check's. */
  title: string;
  /** Other titles the same check may already have in a business (an older starter title). */
  alsoKnownAs: string[];
  /** Category for a new check (a starter category name). */
  category: string;
  /** Only with this service; without it the business's own wording is kept. */
  service?: string;
  /**
   * A shorter repeat than this is the in-house routine with the same name
   * (the monthly emergency lighting flick test, the weekly fire alarm test),
   * which the track records; the line is skipped with `inHouseHint`.
   */
  inHouseBelowMonths?: number;
  inHouseHint?: string;
}

interface Rule extends KnownCheck { test: (text: string) => boolean }

const has = (pattern: RegExp) => (text: string) => pattern.test(text);

const RULES: Rule[] = [
  // Gas and heating, oil first ("Heating plant (oil etc)").
  { test: has(/\boil\b|\boftec\b/), title: "Oil Boilers — Annual Service", alsoKnownAs: [], category: "Gas" },
  { test: (t) => /\bgas\b/.test(t) && /\b(catering|kitchen|cooker|cooking|commercial kitchen)\b/.test(t), title: "Gas Kitchen Equipment — Annual Service", alsoKnownAs: [], category: "Gas" },
  { test: (t) => /\bgas\b/.test(t) && /\b(fireplaces?|gas fires?|stoves?)\b/.test(t), title: "Gas Fireplaces — Annual Service", alsoKnownAs: [], category: "Gas" },
  { test: (t) => /\bboilers?\b/.test(t) || (/\bgas\b/.test(t) && /\b(heating|safety|service)\b/.test(t)), title: "Gas Boilers — Annual Service", alsoKnownAs: [], category: "Gas" },
  // Fire.
  { test: has(/fire risk assessment|\bfra\b/), title: "Fire Risk Assessment Review", alsoKnownAs: [], category: "Fire" },
  {
    test: (t) => /fire alarm/.test(t) && !/call ?points?|break ?glass|weekly/.test(t), title: "Fire Alarm Maintenance", alsoKnownAs: [], category: "Fire",
    inHouseBelowMonths: 6, inHouseHint: "The weekly fire alarm test is kept in FireTrack",
  },
  {
    test: has(/emergency light/), title: "Emergency Light Maintenance", alsoKnownAs: [], category: "Fire",
    inHouseBelowMonths: 12, inHouseHint: "The monthly emergency lighting test is kept in FireTrack",
  },
  {
    test: has(/extinguisher/), title: "Fire Extinguishers Maintenance", alsoKnownAs: [], category: "Fire",
    inHouseBelowMonths: 12, inHouseHint: "Routine extinguisher checks are kept in FireTrack",
  },
  { test: has(/suppression|ansul/), title: "Kitchen Fire Suppression Service", alsoKnownAs: [], category: "Fire" },
  { test: has(/(kitchen|canopy).*(extract|duct)|extract(ion)? (system|duct|clean)|\btr ?19\b|duct ?work clean/), title: "Kitchen Extract Cleaning (TR19 Grease)", alsoKnownAs: ["Kitchen Extraction Deep Clean"], category: "Fire" },
  { test: has(/\baov\b|smoke vent|automatic opening vent/), title: "AOV / Smoke Vent Service", alsoKnownAs: ["AOV — Automatic Opening Vents Service"], category: "Fire" },
  { test: has(/sprinkler/), title: "Sprinkler System Service", alsoKnownAs: [], category: "Fire" },
  { test: has(/chimney|flue sweep/), title: "Chimney Sweep", alsoKnownAs: [], category: "Fire" },
  // Electrical.
  { test: has(/\bpat\b|portable appliance/), title: "Electrical Appliance Testing (PAT)", alsoKnownAs: [], category: "Electrical" },
  { test: has(/\beicr\b|electrical installation|fixed wir|periodic inspection/), title: "Electrical Installation Condition Report (EICR)", alsoKnownAs: [], category: "Electrical" },
  { test: has(/\bev charg|electric vehicle charg/), title: "EV Charger Inspection", alsoKnownAs: [], category: "Electrical" },
  // Water.
  { test: has(/legionella.*(risk|assessment)|water.*risk assessment/), title: "Legionella Risk Assessment", alsoKnownAs: [], category: "Legionella" },
  { test: (t) => /\btanks?\b/.test(t) && /\b(clean|disinfect|disinfection|chlorinat)/.test(t), title: "Clean & Disinfect Water Tanks", alsoKnownAs: [], category: "Legionella" },
  { test: has(/water sampl|legionella sampl/), title: "Legionella Water Sampling", alsoKnownAs: [], category: "Legionella" },
  // Pressure systems.
  { test: has(/coffee|espresso/), title: "Coffee Machine — Written Scheme Examination", alsoKnownAs: [], category: "Pressure Systems" },
  { test: has(/compressor/), title: "Compressor — Written Scheme Examination", alsoKnownAs: [], category: "Pressure Systems" },
  // Lifting equipment: only when the line names one kind of equipment.
  { test: (t) => /front loader/.test(t) && !/vehicle lift|fork ?lift|passenger lift|goods lift|hoist/.test(t), title: "Front Loader — Thorough Examination", alsoKnownAs: [], category: "LOLER" },
  { test: (t) => /vehicle lift/.test(t) && !/front loader|fork ?lift|passenger lift|goods lift/.test(t), title: "Vehicle Lift — Thorough Examination", alsoKnownAs: [], category: "LOLER" },
  { test: (t) => /fork ?lift/.test(t) && !/front loader|vehicle lift|passenger lift|goods lift/.test(t), title: "Fork Lift Truck — Thorough Examination", alsoKnownAs: [], category: "LOLER" },
  { test: (t) => /passenger lift/.test(t) && !/goods lift|vehicle lift/.test(t), title: "Passenger Lift — Thorough Examination", alsoKnownAs: [], category: "LOLER" },
  { test: (t) => /goods lift/.test(t) && !/passenger lift|vehicle lift/.test(t), title: "Goods Lift — Thorough Examination", alsoKnownAs: [], category: "LOLER" },
  // Grounds: the GreenTrack sprayer test line.
  { test: has(/\bnsts\b|sprayer test/), title: "GreenTrack NSTS Sprayer Test", alsoKnownAs: [], category: "GreenTrack", service: "greentrack" },
  // Others with one obvious home.
  { test: has(/\btm ?44\b|air condition.*inspection/), title: "TM44 Air Conditioning Inspection", alsoKnownAs: [], category: "HVAC" },
  { test: has(/\blev\b|local exhaust ventilation/), title: "LEV Thorough Examination", alsoKnownAs: [], category: "Health & Safety", service: "coshhtrack" },
  { test: has(/tree (survey|safety|inspection)/), title: "Tree Safety Survey", alsoKnownAs: [], category: "Premises", service: "treetrack" },
  { test: has(/employers.? liability/), title: "Employers' Liability Insurance Certificate", alsoKnownAs: [], category: "Insurance" },
  { test: has(/waste transfer/), title: "Waste Transfer Note — Annual Renewal", alsoKnownAs: [], category: "Waste" },
  { test: has(/(health (and|&) safety|h ?& ?s) policy/), title: "Health and Safety Policy Review", alsoKnownAs: [], category: "Health & Safety" },
];

const searchText = (title: string) => normaliseKey(title).replace(/[’']/g, "'").replace(/[^a-z0-9&' ]+/g, " ").replace(/\s+/g, " ");

/**
 * ComplyTrack's own check for a spreadsheet line, or null when there is no
 * clear one (the line then becomes a check with the business's own wording).
 * `hasService` decides lines that belong to a track the business may not have.
 */
export function knownCheckFor(title: string, hasService: (service: string) => boolean = () => true): KnownCheck | null {
  const text = searchText(title);
  for (const { test, ...known } of RULES) {
    if (!test(text)) continue;
    if (known.service && !hasService(known.service)) return null;
    return known;
  }
  return null;
}

const CATEGORY_WORDS: Array<[RegExp, string]> = [
  [/\b(gas|boilers?|oil|heating)\b/, "Gas"],
  [/\b(fire|extinguishers?|emergency light\w*|smoke|sprinklers?|evacuation)\b/, "Fire"],
  [/\b(electrical|electric|eicr|pat|wiring)\b/, "Electrical"],
  [/\b(loler|lifts?|hoists?|loaders?|lifting|thorough examination)\b/, "LOLER"],
  [/\b(legionella|water|tanks?|tmvs?|calorifiers?|showers?)\b/, "Legionella"],
  [/\basbestos\b/, "Asbestos"],
  [/\b(pressure|compressors?|written scheme|autoclaves?|steam)\b/, "Pressure Systems"],
  [/\b(air conditioning|hvac|ventilation|tm44)\b/, "HVAC"],
  [/\b(insurance|insured)\b/, "Insurance"],
  [/\b(waste|skip)\b/, "Waste"],
  [/\b(sprayers?|nsts|mowers?|greenkeeping|tractors?)\b/, "GreenTrack"],
  [/\b(training|risk assessment|policy|first aid|coshh)\b/, "Health & Safety"],
];

/** A category for a line with no ComplyTrack match, from its words. */
export function categoryForTitle(title: string): string {
  const text = searchText(title);
  return CATEGORY_WORDS.find(([pattern]) => pattern.test(text))?.[1] ?? "Other";
}

/** A heading that starts a block of in-house routines ("In-house", "In house checks"). */
export const isInHouseHeading = (text: string) => /\bin[ -]?house\b/i.test(text);

/** Company names compared without "Ltd", "Limited", "&", punctuation and spacing. */
export function contractorKey(value: string | null | undefined): string {
  return normaliseKey(value)
    .replace(/&/g, " and ")
    .replace(/\b(ltd|limited|plc|llp|co|company|uk|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}
