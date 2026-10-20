import type { Entitlements, ServiceKey } from "./services";

export const DAILY_CHECKLIST_TYPES = {
  am: ["kitchen_opening", "premises_opening"],
  pm: ["kitchen_closing", "premises_closing"],
} as const;

export type DailyChecklistPeriod = keyof typeof DAILY_CHECKLIST_TYPES;
export type DailyChecklistType = (typeof DAILY_CHECKLIST_TYPES)[DailyChecklistPeriod][number];

const STANDALONE_SERVICE: Record<DailyChecklistPeriod, ServiceKey> = {
  am: "dailytrack_am",
  pm: "dailytrack_pm",
};

export function serviceForDailyChecklistType(type: DailyChecklistType): "kitchentrack" | "premisestrack" {
  return type.startsWith("kitchen_") ? "kitchentrack" : "premisestrack";
}

function includesService(services: Entitlements, service: ServiceKey): boolean {
  return services === "all" || services.includes(service);
}

export function canAccessDailyChecklistType(
  services: Entitlements,
  period: DailyChecklistPeriod,
  type: DailyChecklistType,
): boolean {
  return includesService(services, STANDALONE_SERVICE[period])
    || includesService(services, serviceForDailyChecklistType(type));
}

export function accessibleDailyChecklistTypes(
  services: Entitlements,
  period: DailyChecklistPeriod,
): DailyChecklistType[] {
  return DAILY_CHECKLIST_TYPES[period].filter((type) =>
    canAccessDailyChecklistType(services, period, type),
  );
}
export const DAILY_TRACK_REQUIREMENTS = [
  "kitchen_opening", "premises_opening", "kitchen_closing", "premises_closing", "signoff",
] as const;

export type DailyTrackRequirement = (typeof DAILY_TRACK_REQUIREMENTS)[number];

/**
 * What each site is expected to complete per day, given the client's services:
 * the AM and PM checklists it can open, plus the manager sign-off whenever a PM
 * checklist is expected (the sign-off sits on the PM page). The status page's
 * day grid and month calendar count only these.
 */
export function dailyTrackRequirements(services: Entitlements): DailyTrackRequirement[] {
  const am = accessibleDailyChecklistTypes(services, "am");
  const pm = accessibleDailyChecklistTypes(services, "pm");
  return [...am, ...pm, ...(pm.length > 0 ? ["signoff" as const] : [])];
}
