export const CONTRACTOR_DBS_TYPES = ["Basic", "Standard", "Enhanced", "PVG Scheme", "None"] as const;

const LEGACY_TYPES: Record<string, (typeof CONTRACTOR_DBS_TYPES)[number]> = {
  "DBS Check (Basic)": "Basic",
  "DBS Check (Standard)": "Standard",
  "DBS Check (Enhanced)": "Enhanced",
  "PVG Scheme (Scotland)": "PVG Scheme",
};

export function normalizeContractorDbsType(value: unknown): unknown {
  return typeof value === "string" ? LEGACY_TYPES[value] ?? value : value;
}