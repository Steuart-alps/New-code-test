export interface ColdUnit {
  name: string;
  type: 'fridge' | 'freezer';
}

export interface ColdReading {
  unit: string;
  tempAm: string;
  tempPm: string;
  correctiveAction: string;
}

export interface FoodSafetyColdConfig {
  food_cold_units?: string | null;
  food_num_fridges?: string | null;
  food_num_freezers?: string | null;
}

export function deviceLocalCalendarDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function configuredUnits(config?: FoodSafetyColdConfig): ColdUnit[] {
  if (config?.food_cold_units) {
    try {
      const units = JSON.parse(config.food_cold_units) as ColdUnit[];
      if (Array.isArray(units) && units.length > 0) return units;
    } catch {
      // Invalid saved configuration falls back to the configured unit counts.
    }
  }
  const fridgeCount = Math.max(0, Number(config?.food_num_fridges ?? 2) || 0);
  const freezerCount = Math.max(0, Number(config?.food_num_freezers ?? 2) || 0);
  return [
    ...Array.from({ length: fridgeCount }, (_, index) => ({
      name: `Fridge ${index + 1}`,
      type: 'fridge' as const,
    })),
    ...Array.from({ length: freezerCount }, (_, index) => ({
      name: `Freezer ${index + 1}`,
      type: 'freezer' as const,
    })),
  ];
}

export function hydrateColdReadings(
  units: readonly ColdUnit[],
  savedReadings?: readonly ColdReading[] | null,
): { coldFood: ColdReading[]; initialColdFood: ColdReading[] } {
  const saved = savedReadings ?? [];
  return {
    coldFood: units.map((unit) => saved.find((row) => row.unit === unit.name) ?? {
      unit: unit.name,
      tempAm: '',
      tempPm: '',
      correctiveAction: '',
    }),
    initialColdFood: saved.filter((row) => units.some((unit) => unit.name === row.unit)),
  };
}

export function buildKitchenTemperatureWrite(
  scope: { saveUrl(recordId: number | null): string },
  recordId: number | null | undefined,
  body: Record<string, unknown>,
): { url: string; options: { method: 'POST' | 'PUT'; body: string } } {
  if (recordId === undefined) throw new Error('Wait for the selected diary to load.');
  return {
    url: scope.saveUrl(recordId),
    options: {
      method: recordId === null ? 'POST' : 'PUT',
      body: JSON.stringify(body),
    },
  };
}

export const FOOD_SAFETY_QUERY_KEY = ['food-safety'] as const;

export function invalidateKitchenDashboard(queryClient: {
  invalidateQueries(options: { queryKey: readonly string[] }): Promise<unknown>;
}): Promise<unknown> {
  return queryClient.invalidateQueries({ queryKey: FOOD_SAFETY_QUERY_KEY });
}

export async function saveKitchenTemperatureDiary<T>(
  scope: { saveUrl(recordId: number | null): string },
  recordId: number | null | undefined,
  body: Record<string, unknown>,
  send: (url: string, options: { method: 'POST' | 'PUT'; body: string }) => Promise<T>,
  queryClient: { invalidateQueries(options: { queryKey: readonly string[] }): Promise<unknown> },
): Promise<T> {
  const request = buildKitchenTemperatureWrite(scope, recordId, body);
  const result = await send(request.url, request.options);
  await invalidateKitchenDashboard(queryClient);
  return result;
}