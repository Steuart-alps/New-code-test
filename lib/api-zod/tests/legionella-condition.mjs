// The shared LegionellaTrack condition questions (sediment, biofilm, lid,
// screens) used by the API and the LegionellaTrack page.
// Run: pnpm --filter @workspace/api-zod run test:legionella-condition
import assert from 'node:assert/strict';
import {
  LEGIONELLA_CONDITION_QUESTIONS, legionellaConditionQuestions, legionellaFindingFailures,
  legionellaFindingLines, legionellaFindingsError,
} from '../src/legionella-condition.ts';

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error]); } };

const cleanTank = {
  sediment: 'none', biofilm: 'none', waterSurface: 'clear', debris: 'none', corrosion: 'none',
  lid: 'yes', screens: 'yes', insulation: 'yes',
};

test('inspections, cleans and flushes ask questions; temperature checks do not', () => {
  for (const type of ['cold_tank_inspection', 'calorifier_inspection', 'cold_tank_clean', 'calorifier_clean', 'shower_clean', 'outlet_flush']) {
    assert.ok(legionellaConditionQuestions(type).length > 0, type);
  }
  for (const type of ['calorifier_temp', 'hot_sentinel_temp', 'cold_tank_temp', 'tmv_service', 'toString', '']) {
    assert.equal(legionellaConditionQuestions(type).length, 0, type);
  }
});

test('the tank inspection asks about sediment and biofilm', () => {
  const keys = LEGIONELLA_CONDITION_QUESTIONS.cold_tank_inspection.map(q => q.key);
  assert.ok(keys.includes('sediment'));
  assert.ok(keys.includes('biofilm'));
  assert.ok(LEGIONELLA_CONDITION_QUESTIONS.calorifier_inspection.some(q => q.key === 'sediment'));
});

test('every question has unique keys and option values', () => {
  for (const [type, questions] of Object.entries(LEGIONELLA_CONDITION_QUESTIONS)) {
    assert.equal(new Set(questions.map(q => q.key)).size, questions.length, type);
    for (const q of questions) assert.equal(new Set(q.options.map(o => o.value)).size, q.options.length, `${type}.${q.key}`);
  }
});

test('a complete set of answers is accepted', () => {
  assert.equal(legionellaFindingsError('cold_tank_inspection', cleanTank), null);
  assert.equal(legionellaFindingsError('outlet_flush', { water: 'cleared' }), null);
});

test('missing, unknown or misplaced answers are refused', () => {
  const { lid: _lid, ...noLid } = cleanTank;
  assert.match(legionellaFindingsError('cold_tank_inspection', noLid), /Lid fitted/);
  assert.match(legionellaFindingsError('cold_tank_inspection', { ...cleanTank, sediment: 'loads' }), /Sediment/);
  assert.match(legionellaFindingsError('cold_tank_inspection', { ...cleanTank, colour: 'blue' }), /Unknown/);
  assert.match(legionellaFindingsError('hot_sentinel_temp', {}), /no condition questions/);
  assert.match(legionellaFindingsError('cold_tank_inspection', null), /Answer/);
  assert.match(legionellaFindingsError('cold_tank_inspection', ['none']), /Answer/);
});

test('heavy sediment, biofilm, an open lid or missing screens need action', () => {
  assert.deepEqual(legionellaFindingFailures('cold_tank_inspection', cleanTank), []);
  assert.deepEqual(legionellaFindingFailures('cold_tank_inspection', { ...cleanTank, sediment: 'slight' }), []);
  assert.deepEqual(legionellaFindingFailures('cold_tank_inspection', { ...cleanTank, sediment: 'heavy', biofilm: 'found' }), [
    'Sediment or debris on the tank floor: A lot',
    'Slime (biofilm) on the tank walls or at the water line: Found',
  ]);
  assert.equal(legionellaFindingFailures('cold_tank_inspection', { ...cleanTank, lid: 'no' }).length, 1);
  assert.equal(legionellaFindingFailures('cold_tank_inspection', { ...cleanTank, screens: 'no' }).length, 1);
  assert.equal(legionellaFindingFailures('calorifier_inspection', { drained: 'no' }).length, 1);
  assert.equal(legionellaFindingFailures('outlet_flush', { water: 'not_clear' }).length, 1);
});

test('what was found before a clean is evidence, not a failure; an unfinished clean is', () => {
  assert.deepEqual(legionellaFindingFailures('cold_tank_clean', { sediment: 'heavy', biofilm: 'found', completed: 'yes' }), []);
  assert.equal(legionellaFindingFailures('cold_tank_clean', { sediment: 'none', biofilm: 'none', completed: 'no' }).length, 1);
  assert.deepEqual(legionellaFindingFailures('shower_clean', { scale: 'heavy', biofilm: 'found', completed: 'yes' }), []);
});

test('answers read back in question order', () => {
  assert.deepEqual(legionellaFindingLines('outlet_flush', { water: 'cleared' }), [
    'Water when the outlet was first run: Discoloured or with debris, then ran clear',
  ]);
  assert.deepEqual(legionellaFindingLines('calorifier_temp', { water: 'cleared' }), []);
  assert.deepEqual(legionellaFindingLines('outlet_flush', null), []);
});

let failed = 0;
for (const [status, name, error] of results) {
  console.log(`${status} - ${name}`);
  if (error) { failed++; console.error(error); }
}
if (failed) process.exit(1);
