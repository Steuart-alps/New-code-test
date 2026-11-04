// Country starting points for KitchenTrack temperature limits.
// Run: pnpm --filter @workspace/api-zod run test:kitchen-temperature-guidance
import assert from 'node:assert/strict';
import {
  assessKitchenTemperatures, kitchenTemperatureRulesSchema, parseKitchenTemperatureRules, DEFAULT_KITCHEN_TEMPERATURE_RULES,
  FOOD_JURISDICTIONS, KITCHEN_TEMPERATURE_GUIDANCE, isFoodJurisdiction, kitchenTemperatureGuidance, kitchenTemperatureGuidanceRules,
} from '../src/kitchen-temperature.ts';

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error]); } };
const UK = ['scotland', 'england_wales', 'northern_ireland'];

test('the country list matches the worldwide plan, UK ids unchanged', () => {
  assert.deepEqual([...FOOD_JURISDICTIONS], [
    'scotland', 'england_wales', 'northern_ireland', 'ireland', 'australia', 'new_zealand', 'canada', 'united_states', 'other',
  ]);
  assert.deepEqual(Object.keys(KITCHEN_TEMPERATURE_GUIDANCE).sort(), [...FOOD_JURISDICTIONS].sort());
  assert.equal(isFoodJurisdiction('ireland'), true);
  assert.equal(isFoodJurisdiction('republic_of_ireland'), false);
  assert.equal(isFoodJurisdiction(null), false);
});

test('every preset is a valid, complete rule set with no item rules', () => {
  for (const id of FOOD_JURISDICTIONS) {
    const guidance = KITCHEN_TEMPERATURE_GUIDANCE[id];
    assert.equal(guidance.id, id);
    assert.deepEqual(kitchenTemperatureRulesSchema.parse(guidance.rules), guidance.rules, id);
    assert.deepEqual(guidance.rules.items, { cooking: [], sousVide: [] }, id);
  }
});

test('UK presets keep the values the app has always used', () => {
  assert.deepEqual(KITCHEN_TEMPERATURE_GUIDANCE.england_wales.rules, { ...DEFAULT_KITCHEN_TEMPERATURE_RULES, reheating: { min: 75, max: null } });
  assert.deepEqual(KITCHEN_TEMPERATURE_GUIDANCE.northern_ireland.rules, KITCHEN_TEMPERATURE_GUIDANCE.england_wales.rules);
  assert.deepEqual(KITCHEN_TEMPERATURE_GUIDANCE.scotland.rules, DEFAULT_KITCHEN_TEMPERATURE_RULES);
  for (const id of UK) {
    const { labels } = KITCHEN_TEMPERATURE_GUIDANCE[id];
    assert.equal(labels.cooking, '75°C or above (core)');
    assert.equal(labels.cooling, '8°C within 90 minutes');
    assert.equal(labels.hotHolding, 'Above 63°C');
    assert.equal(labels.reheating, id === 'scotland' ? 'Above 82°C' : 'Above 75°C');
  }
});

test('unsaved rules follow the country; missing or unknown values read as Scotland', () => {
  assert.equal(parseKitchenTemperatureRules(null, 'england_wales').reheating.min, 75);
  assert.equal(parseKitchenTemperatureRules(null, 'northern_ireland').reheating.min, 75);
  assert.equal(parseKitchenTemperatureRules(null, 'scotland').reheating.min, 82);
  assert.equal(parseKitchenTemperatureRules(null).reheating.min, 82);
  assert.equal(parseKitchenTemperatureRules(null, 'atlantis').reheating.min, 82);
  assert.equal(kitchenTemperatureGuidance('atlantis').id, 'scotland');
  const ireland = parseKitchenTemperatureRules(null, 'ireland');
  assert.deepEqual(ireland, KITCHEN_TEMPERATURE_GUIDANCE.ireland.rules);
  assert.equal(parseKitchenTemperatureRules(null, 'united_states').hotHolding.min, 57);
  assert.equal(parseKitchenTemperatureRules(null, 'canada').fridge.max, 4);
});

test('saved rules win over the country preset', () => {
  const saved = JSON.stringify({ ...DEFAULT_KITCHEN_TEMPERATURE_RULES, reheating: { min: 90, max: null } });
  assert.equal(parseKitchenTemperatureRules(saved, 'ireland').reheating.min, 90);
});

test('a preset copy can be edited without changing the guidance', () => {
  const copy = kitchenTemperatureGuidanceRules('australia');
  copy.hotHolding.min = 99; copy.items.cooking.push({ item: 'x', min: 1, holdSeconds: null });
  assert.equal(KITCHEN_TEMPERATURE_GUIDANCE.australia.rules.hotHolding.min, 60);
  assert.deepEqual(KITCHEN_TEMPERATURE_GUIDANCE.australia.rules.items.cooking, []);
});

test('each label states its preset number, and fits a diary record (200 chars)', () => {
  for (const id of FOOD_JURISDICTIONS) {
    const { labels, rules } = KITCHEN_TEMPERATURE_GUIDANCE[id];
    assert.ok(labels.cooking.includes(`${rules.cooking.min}°C`), `${id} cooking: ${labels.cooking}`);
    assert.ok(labels.reheating.includes(`${rules.reheating.min}°C`), `${id} reheating: ${labels.reheating}`);
    assert.ok(labels.hotHolding.includes(`${rules.hotHolding.min}°C`), `${id} hot holding: ${labels.hotHolding}`);
    assert.ok(labels.cooling.includes(`${rules.cooling.max}°C`), `${id} cooling: ${labels.cooling}`);
    for (const label of Object.values(labels)) assert.ok(label.length <= 200, `${id}: ${label}`);
  }
});

test('countries outside the UK are marked unreviewed starting points with a source', () => {
  for (const id of FOOD_JURISDICTIONS) {
    const guidance = KITCHEN_TEMPERATURE_GUIDANCE[id];
    assert.equal(guidance.reviewed, UK.includes(id), id);
    if (id !== 'other') assert.match(guidance.source?.url ?? '', /^https:\/\//, id);
  }
  assert.equal(KITCHEN_TEMPERATURE_GUIDANCE.other.source, null);
  // Two-stage cooling cannot be checked by the diary; the notes say so.
  for (const id of ['australia', 'new_zealand', 'canada', 'united_states']) {
    assert.ok(KITCHEN_TEMPERATURE_GUIDANCE[id].notes.some(note => /two cooling stages/.test(note)), id);
  }
});

test('the same reading passes or fails depending on the country', () => {
  const day = { id: 1, recordDate: '2026-10-16', reheating: [{ item: 'Soup', coreTemp: '72' }], hotHolding: [{ item: 'Curry', coreTemp: '61' }] };
  const fails = (id) => assessKitchenTemperatures(null, day, parseKitchenTemperatureRules(null, id)).map(f => f.section).sort();
  assert.deepEqual(fails('england_wales'), ['hotHolding', 'reheating']);
  assert.deepEqual(fails('ireland'), ['hotHolding']);
  assert.deepEqual(fails('australia'), []);
  assert.deepEqual(fails('united_states'), ['reheating']);
});

for (const [status, name, error] of results) console.log(`${status} ${name}${error ? `\n   ${error.message}` : ''}`);
const failed = results.filter(([status]) => status === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
