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
  // Nothing saved: the country's starting point (Scotland reheats to 82°C,
  // England/Wales and Northern Ireland to 75°C; see KITCHEN_TEMPERATURE_GUIDANCE).
  if (!raw) return kitchenTemperatureRulesSchema.parse(kitchenTemperatureGuidanceRules(jurisdiction));
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
/** The longest hold a diary row can record: 24 hours in seconds for cooking,
 *  72 hours in minutes for sous vide. Anything longer is a typing slip. */
export const KITCHEN_HOLD_ENTRY_MAX = { seconds: 86_400, minutes: 4_320 } as const;
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
      // Hold times are recorded numbers only: a duration is never read from
      // a label or note. A recorded time is checked even without a control.
      const holdField = section === 'hotTemperature' ? 'holdSeconds' : section === 'sousVide' ? 'holdMinutes' : null;
      const hold = kitchenHoldRequirement(rules, section, row.item);
      if (holdField) {
        const unit = holdField === 'holdSeconds' ? 'seconds' : 'minutes';
        const raw = String(row[holdField] ?? '').trim();
        if (raw && changed(holdField)) {
          if (!/^\d+$/.test(raw)) throw new Error(`${label}: enter the hold time as a whole number of ${unit}.`);
          const value = Number(raw);
          if (value > KITCHEN_HOLD_ENTRY_MAX[unit]) {
            throw new Error(`${label}: a hold time of ${value} ${unit} is too long — check the entry (at most ${KITCHEN_HOLD_ENTRY_MAX[unit]} ${unit}).`);
          }
          if (hold && value < hold.limit) failures.push({
            section, rowIndex: index, field: hold.field, label, value,
            limit: { min: hold.limit, max: null }, unit: hold.unit, actionTaken: actionTaken?.trim() ?? '',
          });
        } else if (hold && !raw && String(row.coreTemp ?? '').trim() && (changed('coreTemp') || changed(holdField))) {
          // Also when a recorded hold time is cleared: the evidence must stay.
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

// ── Country guidance ─────────────────────────────────────────────────────────

/**
 * Country starting points for KitchenTrack temperature limits. Each preset
 * is the regulator's published guidance squeezed into the app's rule model
 * (values in °C; one cooling stage). Managers can change every value.
 *
 * Only the UK presets have been used in the app so far. The others were
 * taken from the regulators' published guidance on 2026-10-16 and have not
 * been reviewed by a qualified person in that country (`reviewed: false`),
 * so the app must present them as a starting point to check, never as
 * certified compliance. See the worldwide plan's rule-pack approach.
 */
export const FOOD_JURISDICTIONS = [
  'scotland', 'england_wales', 'northern_ireland',
  'ireland', 'australia', 'new_zealand', 'canada', 'united_states', 'other',
] as const;
export type FoodJurisdiction = (typeof FOOD_JURISDICTIONS)[number];

export interface KitchenTemperatureGuidance {
  id: FoodJurisdiction;
  /** Country or nation shown in the selector. */
  name: string;
  /** Option group in the selector. */
  group: 'United Kingdom' | 'Other countries';
  authority: string;
  source: { title: string; url: string } | null;
  /** True once a qualified person in that country has checked the preset. */
  reviewed: boolean;
  /** Diary labels written on new records. */
  labels: { cooking: string; cooling: string; reheating: string; hotHolding: string };
  /** Where the preset simplifies or picks one value from several. */
  notes: string[];
  rules: KitchenTemperatureRules;
}

const noItems = (): KitchenTemperatureRules['items'] => ({ cooking: [], sousVide: [] });
const ukRules = (reheating: number): KitchenTemperatureRules => ({
  fridge: { min: 0, max: 5 }, freezer: { min: null, max: -18 },
  chilledDelivery: { min: null, max: 8 }, frozenDelivery: { min: null, max: -15 },
  cooking: { min: 75, max: null }, cooling: { min: null, max: 8 },
  reheating: { min: reheating, max: null }, hotHolding: { min: 63, max: null },
  sousVide: { min: 75, max: null }, coolingMinutes: 90,
  cookingHoldSeconds: null, sousVideHoldMinutes: null, items: noItems(),
});
const twoStageNote = (first: string) =>
  `The official rule has two cooling stages (${first}). The diary checks the final temperature and the total time only, so record the first stage in your own checks.`;

const UK_LABELS = { cooking: '75°C or above (core)', cooling: '8°C within 90 minutes', hotHolding: 'Above 63°C' };

export const KITCHEN_TEMPERATURE_GUIDANCE: Record<FoodJurisdiction, KitchenTemperatureGuidance> = {
  scotland: {
    id: 'scotland', name: 'Scotland', group: 'United Kingdom', authority: 'Food Standards Scotland (CookSafe)',
    source: { title: 'Guidance on temperature control legislation', url: 'https://www.foodstandards.gov.scot/sites/default/files/migration/downloads/Guidance_on_temperature_control_legislation.pdf' },
    reviewed: true,
    labels: { ...UK_LABELS, reheating: 'Above 82°C' },
    notes: ['Scotland expects reheated food to reach 82°C.'],
    rules: ukRules(82),
  },
  england_wales: {
    id: 'england_wales', name: 'England / Wales', group: 'United Kingdom', authority: 'Food Standards Agency (Safer food, better business)',
    source: { title: 'Safer food, better business', url: 'https://www.food.gov.uk/business-guidance/safer-food-better-business' },
    reviewed: true,
    labels: { ...UK_LABELS, reheating: 'Above 75°C' },
    notes: [],
    rules: ukRules(75),
  },
  northern_ireland: {
    id: 'northern_ireland', name: 'Northern Ireland', group: 'United Kingdom', authority: 'Food Standards Agency in Northern Ireland',
    source: { title: 'Safer food, better business', url: 'https://www.food.gov.uk/business-guidance/safer-food-better-business' },
    reviewed: true,
    labels: { ...UK_LABELS, reheating: 'Above 75°C' },
    notes: [],
    rules: ukRules(75),
  },
  ireland: {
    id: 'ireland', name: 'Ireland', group: 'Other countries', authority: 'Food Safety Authority of Ireland (Safe Catering)',
    source: { title: 'FSAI: Temperature control for caterers', url: 'https://www.fsai.ie/Business-Advice/Running-a-Food-Business/Caterers/Temperature-Control' },
    reviewed: false,
    labels: {
      cooking: '75°C or above (core)',
      cooling: 'In the fridge within 2 hours (below 10°C by 2½ hours at the latest)',
      reheating: '70°C or above (core), reheat once only',
      hotHolding: 'Above 63°C',
    },
    notes: [
      'FSAI asks for cooked food to be in the fridge within 2 hours. The diary uses its corrective-action limit: below 10°C within 2½ hours, otherwise serve at once or throw away.',
      'Chilled deliveries are set to 5°C or below, matching FSAI chilled storage.',
    ],
    rules: {
      fridge: { min: 0, max: 5 }, freezer: { min: null, max: -18 },
      chilledDelivery: { min: null, max: 5 }, frozenDelivery: { min: null, max: -15 },
      cooking: { min: 75, max: null }, cooling: { min: null, max: 10 },
      reheating: { min: 70, max: null }, hotHolding: { min: 63, max: null },
      sousVide: { min: 75, max: null }, coolingMinutes: 150,
      cookingHoldSeconds: null, sousVideHoldMinutes: null, items: noItems(),
    },
  },
  australia: {
    id: 'australia', name: 'Australia', group: 'Other countries', authority: 'Food Standards Australia New Zealand (Standard 3.2.2)',
    source: { title: 'FSANZ: Cooling and reheating food', url: 'https://www.foodstandards.gov.au/business/food-safety/cooling-and-reheating-food' },
    reviewed: false,
    labels: {
      cooking: '75°C or above (core)',
      cooling: '60°C to 21°C within 2 hours, then 5°C within 4 more hours',
      reheating: '60°C or above, reheated rapidly',
      hotHolding: '60°C or above',
    },
    notes: [
      twoStageNote('60°C to 21°C within 2 hours'),
      'The Standard sets 60°C for reheating food to hold hot. Many councils recommend 75°C; raise the limit if yours does.',
      'The Standard says frozen food must stay frozen; -18°C storage and -15°C deliveries are common practice, not set numbers.',
    ],
    rules: {
      fridge: { min: 0, max: 5 }, freezer: { min: null, max: -18 },
      chilledDelivery: { min: null, max: 5 }, frozenDelivery: { min: null, max: -15 },
      cooking: { min: 75, max: null }, cooling: { min: null, max: 5 },
      reheating: { min: 60, max: null }, hotHolding: { min: 60, max: null },
      sousVide: { min: 75, max: null }, coolingMinutes: 360,
      cookingHoldSeconds: null, sousVideHoldMinutes: null, items: noItems(),
    },
  },
  new_zealand: {
    id: 'new_zealand', name: 'New Zealand', group: 'Other countries', authority: 'Ministry for Primary Industries (Food Control Plan)',
    source: { title: 'MPI template Food Control Plan', url: 'https://www.mpi.govt.nz/dmsdocument/11800/direct' },
    reviewed: false,
    labels: {
      cooking: '75°C or above (core)',
      cooling: '60°C to 21°C within 2 hours, then 5°C within 4 more hours',
      reheating: '75°C or above (core)',
      hotHolding: '60°C or above',
    },
    notes: [
      twoStageNote('60°C to 21°C within 2 hours'),
      'Check these against the current version of your Food Control Plan or National Programme guidance.',
    ],
    rules: {
      fridge: { min: 0, max: 5 }, freezer: { min: null, max: -18 },
      chilledDelivery: { min: null, max: 5 }, frozenDelivery: { min: null, max: -15 },
      cooking: { min: 75, max: null }, cooling: { min: null, max: 5 },
      reheating: { min: 75, max: null }, hotHolding: { min: 60, max: null },
      sousVide: { min: 75, max: null }, coolingMinutes: 360,
      cookingHoldSeconds: null, sousVideHoldMinutes: null, items: noItems(),
    },
  },
  canada: {
    id: 'canada', name: 'Canada', group: 'Other countries', authority: 'Provincial food premises rules (Ontario Reg. 493/17 shown)',
    source: { title: 'Ontario Regulation 493/17: Food Premises', url: 'https://www.ontario.ca/laws/regulation/170493' },
    reviewed: false,
    labels: {
      cooking: '74°C or above (core)',
      cooling: '60°C to 20°C within 2 hours, then 4°C within 4 more hours',
      reheating: '74°C or above (core)',
      hotHolding: '60°C or above',
    },
    notes: [
      'Each province sets its own rules. These follow Ontario; check your province.',
      twoStageNote('60°C to 20°C within 2 hours'),
      'Whole poultry needs 82°C under Health Canada guidance; add an item rule for it.',
    ],
    rules: {
      fridge: { min: 0, max: 4 }, freezer: { min: null, max: -18 },
      chilledDelivery: { min: null, max: 4 }, frozenDelivery: { min: null, max: -15 },
      cooking: { min: 74, max: null }, cooling: { min: null, max: 4 },
      reheating: { min: 74, max: null }, hotHolding: { min: 60, max: null },
      sousVide: { min: 74, max: null }, coolingMinutes: 360,
      cookingHoldSeconds: null, sousVideHoldMinutes: null, items: noItems(),
    },
  },
  united_states: {
    id: 'united_states', name: 'United States', group: 'Other countries', authority: 'FDA Food Code 2022 (as adopted by your state)',
    source: { title: 'FDA Food Code 2022', url: 'https://www.fda.gov/food/fda-food-code/food-code-2022' },
    reviewed: false,
    labels: {
      cooking: '74°C (165°F) or above (core)',
      cooling: '57°C (135°F) to 21°C (70°F) within 2 hours, then 5°C (41°F) within 6 hours in total',
      reheating: '74°C (165°F) for 15 seconds, within 2 hours',
      hotHolding: '57°C (135°F) or above',
    },
    notes: [
      'The diary records in °C for now; °F is shown alongside in these labels.',
      twoStageNote('57°C/135°F to 21°C/70°F within 2 hours'),
      'Cooking uses the poultry temperature (74°C/165°F). Whole cuts and ground meat have lower Food Code temperatures; add item rules for them.',
      'States adopt different Food Code editions; check your state or county.',
    ],
    rules: {
      fridge: { min: 0, max: 5 }, freezer: { min: null, max: -18 },
      chilledDelivery: { min: null, max: 5 }, frozenDelivery: { min: null, max: -15 },
      cooking: { min: 74, max: null }, cooling: { min: null, max: 5 },
      reheating: { min: 74, max: null }, hotHolding: { min: 57, max: null },
      sousVide: { min: 74, max: null }, coolingMinutes: 360,
      cookingHoldSeconds: null, sousVideHoldMinutes: null, items: noItems(),
    },
  },
  other: {
    id: 'other', name: 'Other country (set your own)', group: 'Other countries', authority: 'Your local food authority',
    source: null,
    reviewed: false,
    labels: { ...UK_LABELS, reheating: 'Above 75°C' },
    notes: ['Starts from the England / Wales values. Replace them with your local food authority\'s limits.'],
    rules: ukRules(75),
  },
};

export function isFoodJurisdiction(value: unknown): value is FoodJurisdiction {
  return typeof value === 'string' && (FOOD_JURISDICTIONS as readonly string[]).includes(value);
}

/** The guidance for a stored jurisdiction; unknown or missing values read as
 *  Scotland, matching the app's original default. */
export function kitchenTemperatureGuidance(jurisdiction: string | null | undefined): KitchenTemperatureGuidance {
  return isFoodJurisdiction(jurisdiction) ? KITCHEN_TEMPERATURE_GUIDANCE[jurisdiction] : KITCHEN_TEMPERATURE_GUIDANCE.scotland;
}

/** A fresh copy of a country's preset rules, safe to edit. */
export function kitchenTemperatureGuidanceRules(jurisdiction: string | null | undefined): KitchenTemperatureRules {
  return JSON.parse(JSON.stringify(kitchenTemperatureGuidance(jurisdiction).rules)) as KitchenTemperatureRules;
}
