import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { INCIDENT_TYPES } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * Per-client customisable form dropdown vocabularies.
 *
 * Each list is stored in the existing app_settings table under a
 * `form_options.<name>` key as a JSON string[]. When a client has not saved a
 * custom list the hardcoded default is used, so existing records with old
 * values continue to load and validate.
 *
 * These are business-preference lists only. Legislation-driven vocabularies
 * (fire safety, legionella, etc.) are deliberately NOT included.
 */

// Default trades (mirrors TRADE_OPTIONS in the web contractor form). Kept as
// plain values; gas subtrades are meaningful to the FixTrack auto-assign
// matching so removing them there is the client's choice.
export const DEFAULT_FIXTRACK_TRADES = [
  "electrical", "plumbing",
  "gas_kitchen", "gas_fireplace", "gas_heating",
  "structural", "equipment", "hvac",
  // Fire safety trades (October 2026). Several are linked to FireTrack's
  // contractor visits (CONTRACTOR_VISIT_TYPES in lib/contractorVisits.ts).
  "fire_alarm", "emergency_lighting", "fire_extinguishers",
  "kitchen_fire_suppression", "sprinkler_systems", "aov_smoke_vents",
  "dry_wet_risers", "fire_doors", "fire_shutters_curtains", "fire_dampers",
  "fire_stopping", "kitchen_extract_cleaning", "fire_risk_assessor",
  // Security trades (October 2026).
  "intruder_alarm", "cctv", "access_control",
  // Specialist services (October 2026), linked to the tracks' contractor visits.
  "legionella_water_hygiene", "pest_control", "pat_testing", "loler_puwer_inspection",
  "lev_testing", "asbestos", "tree_surgeon_arborist", "pool_spa_maintenance", "waste_collection",
  "it_comms",
  "safety_hazard", "cleaning", "general",
] as const;

export const DEFAULT_FIXTRACK_ISSUE_TYPES = [
  "electrical", "plumbing", "gas", "structural", "equipment",
  "hvac", "it_comms", "safety_hazard", "cleaning", "general",
] as const;

export const DEFAULT_PREMISES_INSPECTION_TYPES = [
  "routine", "hazard", "fault", "housekeeping", "signage",
] as const;

// Pest activity vocabularies (mirror the pest-track web dropdowns). These are
// plain labels — they don't drive any typed calculation. Values are the stable
// codes stored in the DB; the web maps them to friendly labels where present.
export const DEFAULT_PEST_TYPES = [
  "rodent", "insect", "bird", "other",
] as const;

export const DEFAULT_PEST_EVIDENCE_TYPES = [
  "live_sighting", "droppings", "damage", "nest", "tracks", "other",
] as const;

// Bike fleet type — a pure display vocabulary chosen when registering a bike.
// (Bike check types pre_hire/post_return are system-set, and service types
// annual/interim/adhoc drive next-service scheduling, so neither is included.)
export const DEFAULT_BIKE_TYPES = [
  "road", "mountain", "hybrid", "ebike", "kids", "cargo", "other",
] as const;

export const DEFAULT_TRAINTRACK_TYPES = [
  "Fire Safety Awareness",
  "Food Hygiene (Level 2)",
  "Food Hygiene (Level 3)",
  "Manual Handling",
  "First Aid at Work",
  "Emergency First Aid at Work",
  "COSHH Awareness",
  "Health & Safety Induction",
  "Working at Height",
  "RIDDOR Awareness",
  "Asbestos Awareness",
  "Display Screen Equipment (DSE)",
  "Toolbox Talk",
  // DBS / PVG disclosure checks
  "DBS Check (Basic)",
  "DBS Check (Standard)",
  "DBS Check (Enhanced)",
  "PVG Scheme (Scotland)",
  // Chainsaw NPTC / LANTRA certificates
  "Chainsaw (NPTC CS30 — Maintenance & Cross-cutting)",
  "Chainsaw (NPTC CS31 — Felling Small Trees)",
  "Chainsaw (NPTC CS32 — Felling Medium Trees)",
  "Chainsaw (NPTC CS38 — From Rope & Harness)",
  "Other",
] as const;

/**
 * The whitelist of customisable option-list keys and their default values.
 * The key here is the "short" name; the actual app_settings key is prefixed
 * with `form_options.` (see settingKey).
 */
export const FORM_OPTION_DEFAULTS: Record<string, readonly string[]> = {
  incident_types:            INCIDENT_TYPES,
  fixtrack_issue_types:      DEFAULT_FIXTRACK_ISSUE_TYPES,
  fixtrack_trades:           DEFAULT_FIXTRACK_TRADES,
  premises_inspection_types: DEFAULT_PREMISES_INSPECTION_TYPES,
  traintrack_types:          DEFAULT_TRAINTRACK_TYPES,
  pest_types:                DEFAULT_PEST_TYPES,
  pest_evidence_types:       DEFAULT_PEST_EVIDENCE_TYPES,
  bike_types:                DEFAULT_BIKE_TYPES,
};

/**
 * Defaults added after businesses could already have saved their own list.
 * A saved list that names one of these neither as active nor as disabled was
 * saved before it existed, so it is offered as active rather than treated as
 * removed. Once the business saves the list again the choice is theirs.
 */
export const DEFAULTS_ADDED_LATER: Partial<Record<string, readonly string[]>> = {
  fixtrack_trades: [
    "fire_alarm", "emergency_lighting", "fire_extinguishers",
    "kitchen_fire_suppression", "sprinkler_systems", "aov_smoke_vents",
    "dry_wet_risers", "fire_doors", "fire_shutters_curtains", "fire_dampers",
    "fire_stopping", "kitchen_extract_cleaning", "fire_risk_assessor",
    "intruder_alarm", "cctv", "access_control",
    "legionella_water_hygiene", "pest_control", "pat_testing", "loler_puwer_inspection",
    "lev_testing", "asbestos", "tree_surgeon_arborist", "pool_spa_maintenance", "waste_collection",
  ],
};

export type FormOptionKey = keyof typeof FORM_OPTION_DEFAULTS;

export const FORM_OPTION_KEYS = Object.keys(FORM_OPTION_DEFAULTS) as FormOptionKey[];

export function isFormOptionKey(key: string): key is FormOptionKey {
  return Object.prototype.hasOwnProperty.call(FORM_OPTION_DEFAULTS, key);
}

/** app_settings row key for a given option list. */
export function settingKey(key: FormOptionKey): string {
  return `form_options.${key}`;
}

/**
 * Validate a candidate option list. Returns the cleaned array on success or a
 * string error message on failure.
 */
export const MAX_OPTIONS = 50;
export const MAX_OPTION_LENGTH = 60;

export function validateOptionList(input: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "items must be an array" };
  if (input.length === 0) return { ok: false, error: "items must not be empty" };
  if (input.length > MAX_OPTIONS) return { ok: false, error: `too many items (max ${MAX_OPTIONS})` };
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") return { ok: false, error: "items must be strings" };
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "items must not be blank" };
    if (trimmed.length > MAX_OPTION_LENGTH) return { ok: false, error: `item too long (max ${MAX_OPTION_LENGTH} chars)` };
    const dupeKey = trimmed.toLowerCase();
    if (seen.has(dupeKey)) return { ok: false, error: `duplicate item: ${trimmed}` };
    seen.add(dupeKey);
    cleaned.push(trimmed);
  }
  return { ok: true, value: cleaned };
}

export interface StoredOptionState {
  active: string[];
  disabled: string[];
}

function validateDisabledList(input: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "disabled must be an array" };
  if (input.length > MAX_OPTIONS) return { ok: false, error: `too many disabled items (max ${MAX_OPTIONS})` };
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") return { ok: false, error: "disabled items must be strings" };
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "disabled items must not be blank" };
    if (trimmed.length > MAX_OPTION_LENGTH) return { ok: false, error: `disabled item too long (max ${MAX_OPTION_LENGTH} chars)` };
    const dupeKey = trimmed.toLowerCase();
    if (seen.has(dupeKey)) return { ok: false, error: `duplicate disabled item: ${trimmed}` };
    seen.add(dupeKey);
    cleaned.push(trimmed);
  }
  return { ok: true, value: cleaned };
}

/** Parse both the current object format and the original active-array format. */
export function parseStoredOptionState(
  input: unknown,
  defaults: readonly string[],
  addedLater: readonly string[] = [],
): { ok: true; value: StoredOptionState } | { ok: false; error: string } {
  const has = (list: readonly string[], item: string) =>
    list.some((candidate) => candidate.toLowerCase() === item.toLowerCase());
  // Defaults the saved list has never seen join the end of the active list.
  const withAddedLater = (active: string[], disabled: string[]) => [
    ...active,
    ...addedLater.filter((item) => !has(active, item) && !has(disabled, item)),
  ].slice(0, Math.max(active.length, MAX_OPTIONS));

  if (Array.isArray(input)) {
    const active = validateOptionList(input);
    if (!active.ok) return active;
    const disabled = defaults.filter((item) => !has(active.value, item) && !has(addedLater, item));
    return { ok: true, value: { active: withAddedLater(active.value, disabled), disabled } };
  }

  if (!input || typeof input !== "object") {
    return { ok: false, error: "stored option state must be an array or object" };
  }
  const state = input as { active?: unknown; disabled?: unknown };
  const active = validateOptionList(state.active);
  if (!active.ok) return active;
  // Lists saved before the disabled history was capped can hold more than
  // the limit; keep the most recent entries rather than rejecting the list.
  const disabled = validateDisabledList(
    Array.isArray(state.disabled) ? state.disabled.slice(-MAX_OPTIONS) : state.disabled ?? [],
  );
  if (!disabled.ok) return disabled;

  const activeKeys = new Set(active.value.map((item) => item.toLowerCase()));
  if (disabled.value.some((item) => activeKeys.has(item.toLowerCase()))) {
    return { ok: false, error: "an option cannot be active and disabled" };
  }
  return { ok: true, value: { active: withAddedLater(active.value, disabled.value), disabled: disabled.value } };
}

export function serialiseOptionState(state: StoredOptionState): string {
  return JSON.stringify(state);
}

/**
 * Load the active and disabled options for one key for a client: the saved
 * custom list if present and valid, otherwise the hardcoded default.
 */
export async function getEffectiveOptionState(clientId: number, key: FormOptionKey): Promise<StoredOptionState> {
  const rows = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, settingKey(key))))
    .limit(1);
  const raw = rows[0]?.value;
  if (raw) {
    try {
      const check = parseStoredOptionState(JSON.parse(raw), FORM_OPTION_DEFAULTS[key], DEFAULTS_ADDED_LATER[key]);
      if (check.ok) return check.value;
    } catch { /* fall through to default */ }
  }
  return { active: [...FORM_OPTION_DEFAULTS[key]], disabled: [] };
}

/** The active options only: what a new record may use. */
export async function getEffectiveOptionList(clientId: number, key: FormOptionKey): Promise<string[]> {
  return (await getEffectiveOptionState(clientId, key)).active;
}
