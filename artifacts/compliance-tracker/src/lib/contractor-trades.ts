// Contractor trade specialisms. Values are the codes stored on contractors
// (DEFAULT_FIXTRACK_TRADES in api-server lib/formOptions.ts); a business can
// customise the list, and its own entries are shown as typed.

export type TradeGroup = "Building and services" | "Fire safety" | "Security" | "Specialist services" | "Other";

export const TRADE_GROUPS: readonly TradeGroup[] = ["Building and services", "Fire safety", "Security", "Specialist services", "Other"];

export const TRADE_OPTIONS: readonly { value: string; label: string; group: TradeGroup }[] = [
  { value: "electrical",    label: "Electrical", group: "Building and services" },
  { value: "plumbing",      label: "Plumbing", group: "Building and services" },
  // Gas is a single issue type but we record which kind of gas work
  // the contractor covers so managers can pick the right specialist.
  { value: "gas_kitchen",   label: "Gas — Kitchen (hobs, ovens, ranges)", group: "Building and services" },
  { value: "gas_fireplace", label: "Gas — Fireplace / Fires", group: "Building and services" },
  { value: "gas_heating",   label: "Gas — Heating Plant (boilers)", group: "Building and services" },
  { value: "structural",    label: "Structural", group: "Building and services" },
  { value: "equipment",     label: "Equipment", group: "Building and services" },
  { value: "hvac",          label: "HVAC (ventilation, air handling)", group: "Building and services" },
  { value: "it_comms",      label: "IT / Comms", group: "Building and services" },
  { value: "safety_hazard", label: "Safety Hazard", group: "Building and services" },
  { value: "cleaning",      label: "Cleaning", group: "Building and services" },
  { value: "general",       label: "General", group: "Building and services" },
  { value: "fire_alarm",               label: "Fire Alarm", group: "Fire safety" },
  { value: "emergency_lighting",       label: "Emergency Lighting", group: "Fire safety" },
  { value: "fire_extinguishers",       label: "Fire Extinguishers", group: "Fire safety" },
  { value: "kitchen_fire_suppression", label: "Kitchen Fire Suppression", group: "Fire safety" },
  { value: "sprinkler_systems",        label: "Sprinkler Systems", group: "Fire safety" },
  { value: "aov_smoke_vents",          label: "AOV / Smoke Vents", group: "Fire safety" },
  { value: "dry_wet_risers",           label: "Dry / Wet Risers", group: "Fire safety" },
  { value: "fire_doors",               label: "Fire Doors", group: "Fire safety" },
  { value: "fire_shutters_curtains",   label: "Fire Shutters / Curtains", group: "Fire safety" },
  { value: "fire_dampers",             label: "Fire Dampers", group: "Fire safety" },
  { value: "fire_stopping",            label: "Fire Stopping", group: "Fire safety" },
  { value: "kitchen_extract_cleaning", label: "Kitchen Extract Cleaning", group: "Fire safety" },
  { value: "fire_risk_assessor",       label: "Fire Risk Assessor", group: "Fire safety" },
  { value: "intruder_alarm", label: "Intruder Alarm", group: "Security" },
  { value: "cctv",           label: "CCTV", group: "Security" },
  { value: "access_control", label: "Access Control", group: "Security" },
  { value: "legionella_water_hygiene", label: "Legionella / Water Hygiene", group: "Specialist services" },
  { value: "pest_control",             label: "Pest Control", group: "Specialist services" },
  { value: "pat_testing",              label: "PAT Testing", group: "Specialist services" },
  { value: "loler_puwer_inspection",   label: "LOLER / PUWER Inspection", group: "Specialist services" },
  { value: "lev_testing",              label: "LEV Testing", group: "Specialist services" },
  { value: "asbestos",                 label: "Asbestos", group: "Specialist services" },
  { value: "tree_surgeon_arborist",    label: "Tree Surgeon / Arborist", group: "Specialist services" },
  { value: "pool_spa_maintenance",     label: "Pool / Spa Maintenance", group: "Specialist services" },
  { value: "waste_collection",         label: "Waste Collection", group: "Specialist services" },
];

const byValue = new Map(TRADE_OPTIONS.map(option => [option.value, option]));

const humanize = (value: string) =>
  value.split("_").map(word => word ? word[0].toUpperCase() + word.slice(1) : word).join(" ");

/** The label shown for a trade: the built-in label, else the stored text with a capital on each word. */
export function tradeLabel(value: string): string {
  return byValue.get(value)?.label ?? humanize(value);
}

export function tradeGroup(value: string): TradeGroup {
  return byValue.get(value)?.group ?? "Other";
}

/** Gas work (kitchen, fires, heating), which needs Gas Safe registration. */
export function isGasTrade(value: string): boolean {
  return value.startsWith("gas_") || value === "gas" || /\bgas\b/i.test(tradeLabel(value));
}
