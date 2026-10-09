export type KitchenTemplateConfig = object | null | undefined;

export type ColdUnit = {
  name: string;
  type: "fridge" | "freezer";
};

export function parseJsonArray<T>(raw: string | undefined | null, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

export function parseStringArray(raw: string | undefined | null): string[] {
  return parseJsonArray<string>(raw);
}

export function parseColdUnits(config: KitchenTemplateConfig): ColdUnit[] {
  const c = config as {
    food_cold_units?: string | null;
    food_num_fridges?: string | null;
    food_num_freezers?: string | null;
  } | null | undefined;
  if (c?.food_cold_units) return parseJsonArray<ColdUnit>(c.food_cold_units);
  const nf = Number(c?.food_num_fridges || "2");
  const nz = Number(c?.food_num_freezers || "2");
  return [
    ...Array.from({ length: nf }, (_, i) => ({ name: `Fridge ${i + 1}`, type: "fridge" as const })),
    ...Array.from({ length: nz }, (_, i) => ({ name: `Freezer ${i + 1}`, type: "freezer" as const })),
  ];
}

export function isKitchenTemplateReady(
  config: KitchenTemplateConfig,
  clientConfig: KitchenTemplateConfig,
  configLoading: boolean,
  clientConfigLoading: boolean,
): boolean {
  return !!config && !!clientConfig && !configLoading && !clientConfigLoading;
}

export function shouldDisplayKitchenSection(
  enabledByTemplate: boolean,
  hasHistoricalRows: boolean,
): boolean {
  return enabledByTemplate || hasHistoricalRows;
}

export function stampedLimit(recordLimit: unknown, currentLimit: string): string {
  return typeof recordLimit === "string" && recordLimit.length > 0
    ? recordLimit
    : currentLimit;
}

export function daysBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let day = Date.parse(`${from}T00:00:00Z`);
    day <= Date.parse(`${to}T00:00:00Z`);
    day += 86_400_000
  ) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  return dates;
}

export type FoodSafetyCompleteness = {
  missingDates: string[];
  draftDates: string[];
};

export function classifyFoodSafetyCompleteness(
  from: string,
  to: string,
  data: FoodSafetyCompleteness,
): { recorded: Set<string>; drafts: string[]; gaps: string[] } {
  const missing = new Set(data.missingDates);
  const drafts = new Set(data.draftDates);
  const recorded = new Set(
    daysBetween(from, to).filter((date) => !missing.has(date) && !drafts.has(date)),
  );
  return {
    recorded,
    drafts: data.draftDates,
    gaps: data.missingDates,
  };
}

export function foodSafetyCompletenessPath(
  from: string,
  to: string,
  siteId: number | null,
): string {
  const siteQuery = siteId == null ? "" : `&siteId=${siteId}`;
  return `/food-safety/missing-dates?from=${from}&to=${to}${siteQuery}`;
}