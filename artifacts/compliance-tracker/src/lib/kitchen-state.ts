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
// ── Unsaved diary edits ───────────────────────────────────────────────────────
// The diary form remembers what it last loaded from (or saved to) the server
// for one date/site scope. Edits are "dirty" when the form no longer matches
// that snapshot; server responses never decide dirtiness on their own.

/** Stable text form of the editable diary values, for comparing with what was
 *  loaded. Key order is fixed by the caller's object literal. */
export function kitchenDiarySnapshot(values: Record<string, unknown>): string {
  return JSON.stringify(values);
}

export function kitchenDiaryScopeKey(siteId: number | null, date: string): string {
  return `${siteId ?? "all"}:${date}`;
}

/** Identifies the server version of a diary day: a different id or a later
 *  update is new server data; no record yet is "new". */
export function kitchenDiaryRecordKey(
  record: { id: number; updatedAt?: string | null } | null | undefined,
): string {
  return record ? `${record.id}:${record.updatedAt ?? ""}` : "new";
}

export type KitchenDiaryLoaded = { scope: string; recordKey: string; snapshot: string };

export function isKitchenDiaryDirty(
  loaded: KitchenDiaryLoaded | null,
  scope: string,
  currentSnapshot: string,
): boolean {
  return !!loaded && loaded.scope === scope && loaded.snapshot !== currentSnapshot;
}

/** What to do when the selected scope's record or template (re)arrives:
 *  - "hydrate": load it into the form (new scope, or nothing unsaved);
 *  - "skip": the form already shows this server version;
 *  - "keep-edits": newer server data arrived while the form has unsaved
 *    edits, so the edits stay and the save is checked against the version
 *    they were made on. */
export function kitchenDiaryHydrationAction(
  loaded: KitchenDiaryLoaded | null,
  scope: string,
  recordKey: string,
  dirty: boolean,
): "hydrate" | "skip" | "keep-edits" {
  if (!loaded || loaded.scope !== scope) return "hydrate";
  if (loaded.recordKey === recordKey) return "skip";
  return dirty ? "keep-edits" : "hydrate";
}

/** A date or site change with unsaved edits (or a save still in flight) needs
 *  a deliberate discard; otherwise it switches straight away. */
export function requestKitchenDiaryScopeChange(
  currentScope: string,
  nextScope: string,
  dirty: boolean,
  saving: boolean,
): "ignore" | "switch" | "confirm" {
  if (currentScope === nextScope) return "ignore";
  return dirty || saving ? "confirm" : "switch";
}
