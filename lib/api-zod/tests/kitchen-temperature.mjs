// Hold-time controls and per-item rules in the shared KitchenTrack rule model.
// Run: pnpm --filter @workspace/api-zod run test:kitchen-temperature
import assert from 'node:assert/strict';
import {
  assessKitchenTemperatures, kitchenFailureValue, kitchenHoldRequirement,
  kitchenTemperatureRulesSchema, parseKitchenTemperatureRules, DEFAULT_KITCHEN_TEMPERATURE_RULES,
} from '../src/kitchen-temperature.ts';

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error]); } };

// Rules saved before hold controls existed (no hold fields, no items).
const legacy = { ...DEFAULT_KITCHEN_TEMPERATURE_RULES };
delete legacy.cookingHoldSeconds; delete legacy.sousVideHoldMinutes; delete legacy.items;
const rules = parseKitchenTemperatureRules(JSON.stringify({
  ...legacy, cookingHoldSeconds: 30, sousVideHoldMinutes: 60,
  items: {
    cooking: [{ item: 'Rare beef', min: 60, holdSeconds: 600 }, { item: 'Toast', min: null, holdSeconds: null }],
    sousVide: [{ item: 'Duck breast', min: 58, holdMinutes: 120 }],
  },
}));
const diary = (sections) => ({ id: 1, recordDate: '2026-10-09', ...sections });
const assess = (after, before = null) => assessKitchenTemperatures(before, diary(after), rules);

test('stored rules without hold fields still parse, with no hold control', () => {
  const parsed = parseKitchenTemperatureRules(JSON.stringify(legacy));
  assert.equal(parsed.cookingHoldSeconds, null);
  assert.equal(parsed.sousVideHoldMinutes, null);
  assert.deepEqual(parsed.items, { cooking: [], sousVide: [] });
  assert.deepEqual(assessKitchenTemperatures(null, diary({ hotTemperature: [{ item: 'Chicken', coreTemp: '80' }] }), parsed), []);
});

test('hold times must be whole positive numbers and item names unique', () => {
  for (const bad of [
    { ...legacy, cookingHoldSeconds: 0 }, { ...legacy, cookingHoldSeconds: 1.5 }, { ...legacy, sousVideHoldMinutes: 1441 },
    { ...legacy, items: { cooking: [{ item: ' ', min: 70, holdSeconds: 10 }], sousVide: [] } },
    { ...legacy, items: { cooking: [{ item: 'Beef', min: 60, holdSeconds: 10 }, { item: ' beef ', min: 65, holdSeconds: 5 }], sousVide: [] } },
    { ...legacy, items: { cooking: [{ item: 'Beef', min: 60 }], sousVide: [] } },
    { ...legacy, items: { cooking: [], sousVide: [], other: [] } },
  ]) assert.equal(kitchenTemperatureRulesSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('cooking: a measured core temperature needs a hold time', () => {
  assert.throws(() => assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '80' }] }), /record how long .* at least 30 seconds/);
  assert.deepEqual(assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '30' }] }), [], 'equal to the limit passes');
  assert.deepEqual(assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '' }] }), [], 'an unmeasured row is not judged');
});

test('cooking: a short hold is a failure needing a corrective action', () => {
  const [failure, ...rest] = assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '12' }] });
  assert.equal(rest.length, 0);
  assert.equal(failure.field, 'holdSeconds');
  assert.equal(failure.unit, 'seconds');
  assert.deepEqual(failure.limit, { min: 30, max: null });
  assert.equal(failure.actionTaken, '');
  assert.equal(kitchenFailureValue(failure), '12 seconds');
  const withAction = assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '12' }], correctives: 'Returned to the oven and re-probed' });
  assert.equal(withAction[0].actionTaken, 'Returned to the oven and re-probed');
});

test('hold times are whole numbers', () => {
  assert.throws(() => assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '2 mins' }] }), /whole number of seconds/);
  assert.throws(() => assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '-5' }] }), /whole number/);
});

test('an item rule replaces the section minimum and hold, matched case-insensitively', () => {
  const ok = assess({ hotTemperature: [{ item: '  rare BEEF ', coreTemp: '62', holdSeconds: '600' }] });
  assert.deepEqual(ok, [], 'section minimum of 75°C does not apply to the item');
  const failures = assess({ hotTemperature: [{ item: 'Rare beef', coreTemp: '58', holdSeconds: '300' }] });
  assert.deepEqual(failures.map(f => [f.field, f.limit.min]), [['coreTemp', 60], ['holdSeconds', 600]]);
  assert.deepEqual(kitchenHoldRequirement(rules, 'hotTemperature', 'rare beef'), { field: 'holdSeconds', unit: 'seconds', limit: 600 });
});

test('an item rule with no controls switches them off for that item only', () => {
  assert.deepEqual(assess({ hotTemperature: [{ item: 'Toast', coreTemp: '40' }] }), []);
  assert.equal(kitchenHoldRequirement(rules, 'hotTemperature', 'Toast'), null);
  assert.equal(assess({ hotTemperature: [{ item: 'Chicken', coreTemp: '40', holdSeconds: '30' }] })[0].field, 'coreTemp');
});

test('sous vide: hold minutes and item rules apply to core and bath temperatures', () => {
  assert.throws(() => assess({ sousVide: [{ item: 'Salmon', coreTemp: '76', waterTemp: '76' }] }), /at least 60 minutes/);
  assert.deepEqual(assess({ sousVide: [{ item: 'Salmon', coreTemp: '76', waterTemp: '76', holdMinutes: '60' }] }), []);
  assert.deepEqual(assess({ sousVide: [{ item: 'Duck breast', coreTemp: '58', waterTemp: '58.5', holdMinutes: '120' }] }), []);
  const short = assess({ sousVide: [{ item: 'Duck breast', coreTemp: '58', waterTemp: '58', holdMinutes: '90' }] });
  assert.deepEqual(short.map(f => [f.field, f.value, kitchenFailureValue(f)]), [['holdMinutes', 90, '90 minutes']]);
});

test('saved observations are not re-judged against a hold control added later', () => {
  const before = diary({ hotTemperature: [{ item: 'Chicken', coreTemp: '80' }], sousVide: [{ item: 'Salmon', coreTemp: '76', waterTemp: '76' }] });
  const after = { ...before, hotTemperature: [...before.hotTemperature, { item: 'Rice', coreTemp: '79', holdSeconds: '45' }] };
  assert.deepEqual(assessKitchenTemperatures(before, after, rules), []);
});

test('re-measuring a saved temperature asks for its hold time; editing only the hold judges the hold', () => {
  const before = diary({ hotTemperature: [{ item: 'Chicken', coreTemp: '80' }] });
  assert.throws(() => assessKitchenTemperatures(before, { ...before, hotTemperature: [{ item: 'Chicken', coreTemp: '82' }] }, rules), /record how long/);
  const held = diary({ hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '40' }] });
  const shortened = { ...held, hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '10' }] };
  assert.deepEqual(assessKitchenTemperatures(held, shortened, rules).map(f => f.field), ['holdSeconds']);
});

test('renaming a row to an item with its own rule judges it against that rule', () => {
  const before = diary({ hotTemperature: [{ item: 'Chicken', coreTemp: '80', holdSeconds: '30' }] });
  const after = { ...before, hotTemperature: [{ item: 'Rare beef', coreTemp: '80', holdSeconds: '30' }] };
  assert.deepEqual(assessKitchenTemperatures(before, after, rules).map(f => [f.field, f.limit.min]), [['holdSeconds', 600]]);
});

for (const [status, name, error] of results) console.log(`${status} ${name}${error ? `\n   ${error.stack}` : ''}`);
const failed = results.filter(([status]) => status === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
