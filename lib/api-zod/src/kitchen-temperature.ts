import { z } from 'zod';

const celsius = z.number().finite().min(-100).max(250).nullable();
const range = z.object({
  min: celsius,
  max: celsius,
}).strict().refine(v => (v.min !== null || v.max !== null)
  && (v.min === null || v.max === null || v.min <= v.max), 'Supply an ordered numeric temperature range');

const holdSeconds = z.number().int().min(1).max(86_400).nullable();
const holdMinutes = z.number().int().min(1).max(1440).nullable();
const itemName = z.string().trim().min(1).max(80);
/** A named item (e.g. "Duck breast") whose site plan sets its own minimum core
 *  temperature and hold time. Both fields replace the section's for that item;
 *  null means "no numeric control" for it. Matched on the trimmed, case-folded
 *  item name recorded in the diary row. */
const cookingItemRule = z.object({ item: itemName, min: celsius, holdSeconds }).strict();
const sousVideItemRule = z.object({ item: itemName, min: celsius, holdMinutes }).strict();
const itemKey = (item: unknown) => typeof item === 'string' ? item.trim().toLowerCase() : '';

export const kitchenTemperatureRulesSchema = z.object({
  fridge: range, freezer: range, chilledDelivery: range, frozenDelivery: range,
  cooking: range, cooling: range, reheating: range, hotHolding: range, sousVide: range,
  coolingMinutes: z.number().int().min(1).max(1440),
  /** Minimum time at the cooking core temperature; null = no hold control.
   *  Rules saved before hold controls existed read as null. */
  cookingHoldSeconds: holdSeconds.default(null),
  sousVideHoldMinutes: holdMinutes.default(null),
  items: z.object({
    cooking: z.array(cookingItemRule).max(50),
    sousVide: z.array(sousVideItemRule).max(50),
  }).strict().default({ cooking: [], sousVide: [] }),
}).strict().superRefine((rules, ctx) => {
  for (const section of ['cooking', 'sousVide'] as const) {
    const seen = new Set<string>();
    rules.items[section].forEach((entry, index) => {
      if (seen.has(itemKey(entry.item))) {
        ctx.addIssue({ code: 'custom', path: ['items', section, index, 'item'], message: 'Each item can only have one rule' });
      }
      seen.add(itemKey(entry.item));
    });
  }
});
export type KitchenTemperatureRules = z.infer<typeof kitchenTemperatureRulesSchema>;
export const DEFAULT_KITCHEN_TEMPERATURE_RULES: KitchenTemperatureRules = {
  fridge: { min: 0, max: 5 }, freezer: { min: null, max: -18 },
  chilledDelivery: { min: null, max: 8 }, frozenDelivery: { min: null, max: -15 },
  cooking: { min: 75, max: null }, cooling: { min: null, max: 8 },
  reheating: { min: 82, max: null }, hotHolding: { min: 63, max: null },
  sousVide: { min: 75, max: null }, coolingMinutes: 90,
  cookingHoldSeconds: null, sousVideHoldMinutes: null, items: { cooking: [], sousVide: [] },
};
export function parseKitchenTemperatureRules(raw?: string | null, jurisdiction?: string | null): KitchenTemperatureRules {
  if (!raw) return kitchenTemperatureRulesSchema.parse({
    ...DEFAULT_KITCHEN_TEMPERATURE_RULES,
    reheating: { min: jurisdiction === 'england_wales' ? 75 : 82, max: null },
  });
  return kitchenTemperatureRulesSchema.parse(JSON.parse(raw));
}
export function temperatureRangeLabel(rule: { min: number | null; max: number | null }) {
  return `${rule.min === null ? '' : `≥ ${rule.min}°C`}${rule.min !== null && rule.max !== null ? ' and ' : ''}${rule.max === null ? '' : `≤ ${rule.max}°C`}`;
}
export interface KitchenTemperatureFailure {
  section: string; rowIndex: number; field: string; label: string;
  value: number; limit: { min: number | null; max: number | null };
  unit: '°C' | 'minutes' | 'seconds'; actionTaken: string;
}
/** "6°C", "45 minutes", "8 seconds". */
export function kitchenFailureValue(failure: Pick<KitchenTemperatureFailure, 'value' | 'unit'>) {
  return failure.unit === '°C' ? `${failure.value}°C` : `${failure.value} ${failure.unit}`;
}
/** The minimum hold time that applies to an item in a section, if any. An
 *  item rule replaces the section value, including with "no control". */
export function kitchenHoldRequirement(
  rules: KitchenTemperatureRules, section: string, item: unknown,
): { field: 'holdSeconds' | 'holdMinutes'; unit: 'seconds' | 'minutes'; limit: number } | null {
  if (section === 'hotTemperature') {
    const entry = rules.items.cooking.find(candidate => itemKey(candidate.item) === itemKey(item));
    const limit = entry ? entry.holdSeconds : rules.cookingHoldSeconds;
    return limit === null ? null : { field: 'holdSeconds', unit: 'seconds', limit };
  }
  if (section === 'sousVide') {
    const entry = rules.items.sousVide.find(candidate => itemKey(candidate.item) === itemKey(item));
    const limit = entry ? entry.holdMinutes : rules.sousVideHoldMinutes;
    return limit === null ? null : { field: 'holdMinutes', unit: 'minutes', limit };
  }
  return null;
}
type Diary = Record<string, unknown>;
type Row = Record<string, unknown>;
const sections = ['coldFood', 'deliveries', 'hotTemperature', 'cooling', 'reheating', 'hotHolding', 'sousVide'] as const;
const rowsOf = (record: Diary | null, section: string): Row[] =>
  Array.isArray(record?.[section]) ? record![section] as Row[] : [];

/** Only new/changed observations are evaluated; old failures remain historical evidence. */
export function assessKitchenTemperatures(
  before: Diary | null, after: Diary, rules: KitchenTemperatureRules,
  coldUnits: { name: string; type: string }[] = [],
): KitchenTemperatureFailure[] {
  const failures: KitchenTemperatureFailure[] = [];
  const freshCorrectives = before?.correctives !== after.correctives
    ? String(after.correctives ?? '').trim() : '';
  for (const section of sections) {
    const previous = rowsOf(before, section);
    rowsOf(after, section).forEach((row, index) => {
      const old = previous[index] ?? {};
      const fields = section === 'coldFood' ? ['tempAm', 'tempPm']
        : section === 'deliveries' ? ['tempChilled', 'tempFrozen']
          : section === 'sousVide' ? ['coreTemp', 'waterTemp'] : ['coreTemp'];
      const label = String(row.unit ?? row.item ?? row.supplier ?? `${section} ${index + 1}`);
      const override = section === 'hotTemperature'
        ? rules.items.cooking.find(entry => itemKey(entry.item) === itemKey(row.item))
        : section === 'sousVide' ? rules.items.sousVide.find(entry => itemKey(entry.item) === itemKey(row.item)) : undefined;
      const actionTaken = [
        row.correctiveAction !== old.correctiveAction ? row.correctiveAction : '',
        row.correctiveActions !== old.correctiveActions ? row.correctiveActions : '', freshCorrectives,
      ]
        .find(value => typeof value === 'string' && value.trim()) as string | undefined;
      const changed = (field: string) => !before || old[field] !== row[field]
        || ['unit', 'item', 'supplier', 'timeOfCheck', 'timeStart', 'timeFinish', 'timeStarted', 'timeFinished']
          .some(key => old[key] !== row[key]);
      for (const field of fields) {
        const raw = row[field];
        if (raw === null || raw === undefined || String(raw).trim() === '' || !changed(field)) continue;
        if (!/^-?\d+(?:\.\d+)?$/.test(String(raw).trim()) || !Number.isFinite(Number(raw))) {
          throw new Error(`${label} · ${field}: enter a numeric temperature in °C, or leave an unmeasured reading blank.`);
        }
        const type = coldUnits.find(unit => unit.name === row.unit)?.type
          ?? (/freezer/i.test(String(row.unit)) ? 'freezer' : 'fridge');
        const rule = section === 'coldFood' ? rules[type === 'freezer' ? 'freezer' : 'fridge']
          : section === 'deliveries' ? rules[field === 'tempChilled' ? 'chilledDelivery' : 'frozenDelivery']
            : override ? { min: override.min, max: (section === 'hotTemperature' ? rules.cooking : rules.sousVide).max }
              : section === 'hotTemperature' ? rules.cooking : section === 'cooling' ? rules.cooling
                : section === 'reheating' ? rules.reheating : section === 'hotHolding' ? rules.hotHolding : rules.sousVide;
        const value = Number(raw);
        if ((rule.min !== null && value < rule.min) || (rule.max !== null && value > rule.max)) {
          failures.push({ section, rowIndex: index, field, label, value, limit: { ...rule }, unit: '°C', actionTaken: actionTaken?.trim() ?? '' });
        }
      }
      const hold = kitchenHoldRequirement(rules, section, row.item);
      if (hold) {
        const raw = String(row[hold.field] ?? '').trim();
        if (raw && changed(hold.field)) {
          if (!/^\d+$/.test(raw)) throw new Error(`${label}: enter the hold time as a whole number of ${hold.unit}.`);
          const value = Number(raw);
          if (value < hold.limit) failures.push({
            section, rowIndex: index, field: hold.field, label, value,
            limit: { min: hold.limit, max: null }, unit: hold.unit, actionTaken: actionTaken?.trim() ?? '',
          });
        } else if (!raw && String(row.coreTemp ?? '').trim() && changed('coreTemp')) {
          throw new Error(`${label}: record how long the core temperature was held — at least ${hold.limit} ${hold.unit} is required.`);
        }
      }
      if (section === 'cooling' && String(row.coreTemp ?? '').trim() && changed('coreTemp')) {
        const time = (value: unknown) => {
          if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
          const [hour, minute] = value.split(':').map(Number);
          return hour * 60 + minute;
        };
        const start = time(row.timeStart), finish = time(row.timeFinish);
        if (start === null || finish === null) throw new Error(`${label}: cooling needs valid start and finish times (HH:mm).`);
        const minutes = (finish - start + 1440) % 1440;
        if (minutes > rules.coolingMinutes) failures.push({
          section, rowIndex: index, field: 'coolingMinutes', label, value: minutes,
          limit: { min: null, max: rules.coolingMinutes }, unit: 'minutes', actionTaken: actionTaken?.trim() ?? '',
        });
      }
    });
  }
  return failures;
}