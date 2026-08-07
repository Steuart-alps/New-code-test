import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import {
  INCIDENT_TYPES, INCIDENT_SEVERITIES,
} from "@workspace/db/schema";
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
  "structural", "equipment", "hvac", "it_comms",
  "safety_hazard", "cleaning", "general",
] as const;

export const DEFAULT_FIXTRACK_ISSUE_TYPES = [
  "electrical", "plumbing", "gas", "structural", "equipment",
  "hvac", "it_comms", "safety_hazard", "cleaning", "general",
] as const;

export const DEFAULT_PREMISES_INSPECTION_TYPES = [
  "routine", "hazard", "fault", "housekeeping", "signage",
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
  "Other",
] as const;

/**
 * The whitelist of customisable option-list keys and their default values.
 * The key here is the "short" name; the actual app_settings key is prefixed
 * with `form_options.` (see settingKey).
 */
export const FORM_OPTION_DEFAULTS: Record<string, readonly string[]> = {
  incident_types:            INCIDENT_TYPES,
  incident_severities:      INCIDENT_SEVERITIES,
  fixtrack_issue_types:      DEFAULT_FIXTRACK_ISSUE_TYPES,
  fixtrack_trades:           DEFAULT_FIXTRACK_TRADES,
  premises_inspection_types: DEFAULT_PREMISES_INSPECTION_TYPES,
  traintrack_types:          DEFAULT_TRAINTRACK_TYPES,
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

/**
 * Load the effective list for one option key for a client: the saved custom
 * list if present and valid, otherwise the hardcoded default.
 */
export async function getEffectiveOptionList(clientId: number, key: FormOptionKey): Promise<string[]> {
  const rows = await db.select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), eq(appSettingsTable.key, settingKey(key))))
    .limit(1);
  const raw = rows[0]?.value;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const check = validateOptionList(parsed);
      if (check.ok) return check.value;
    } catch { /* fall through to default */ }
  }
  return [...FORM_OPTION_DEFAULTS[key]];
}
