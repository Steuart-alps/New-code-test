// The shared NSTS sprayer test schedule used by the GreenTrack API and page.
// Run: pnpm --filter @workspace/api-zod run test:nsts-sprayer-tests
import assert from 'node:assert/strict';
import {
  addYearsIso, isNstsSprayerCategory, nstsFirstTestDueDate, nstsNextTestDate, nstsStatus,
} from '../src/nsts-sprayer-tests.ts';

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error]); } };

test('categories are recognised and anything else is not', () => {
  for (const key of ['boom_over_3m', 'air_assisted', 'boom_3m_or_less', 'other_application', 'knapsack_handheld']) {
    assert.equal(isNstsSprayerCategory(key), true, key);
  }
  assert.equal(isNstsSprayerCategory('toString'), false);
  assert.equal(isNstsSprayerCategory(''), false);
  assert.equal(isNstsSprayerCategory(null), false);
});

test('re-test every 3 years for wide booms and air-assisted sprayers', () => {
  assert.equal(nstsNextTestDate('boom_over_3m', '2026-04-15'), '2029-04-15');
  assert.equal(nstsNextTestDate('air_assisted', '2026-04-15'), '2029-04-15');
});

test('re-test every 6 years for booms of 3 m or less and other equipment', () => {
  assert.equal(nstsNextTestDate('boom_3m_or_less', '2026-04-15'), '2032-04-15');
  assert.equal(nstsNextTestDate('other_application', '2026-04-15'), '2032-04-15');
});

test('knapsacks get a yearly check; unknown categories get nothing', () => {
  assert.equal(nstsNextTestDate('knapsack_handheld', '2026-04-15'), '2027-04-15');
  assert.equal(nstsNextTestDate(null, '2026-04-15'), null);
  assert.equal(nstsNextTestDate('sprayer', '2026-04-15'), null);
});

test('29 February falls back to the 28th', () => {
  assert.equal(addYearsIso('2028-02-29', 3), '2031-02-28');
  assert.equal(addYearsIso('2028-02-29', 4), '2032-02-29');
  assert.equal(addYearsIso('not a date', 3), null);
});

test('first test before the machine is five years old', () => {
  assert.equal(nstsFirstTestDueDate('boom_over_3m', { purchaseDate: '2024-03-01' }), '2029-03-01');
  assert.equal(nstsFirstTestDueDate('boom_3m_or_less', { purchaseDate: null, year: 2022 }), '2027-01-01');
  assert.equal(nstsFirstTestDueDate('knapsack_handheld', { purchaseDate: '2026-05-10' }), '2027-05-10');
  assert.equal(nstsFirstTestDueDate('boom_over_3m', {}), null, 'no date known');
  assert.equal(nstsFirstTestDueDate(null, { purchaseDate: '2024-03-01' }), null);
});

test('status follows the latest test, else the first-test deadline', () => {
  const today = '2026-10-20';
  assert.deepEqual(nstsStatus('boom_over_3m', { year: 2019 }, null, today),
    { dueDate: '2024-01-01', basis: 'first_test', state: 'overdue' });
  assert.deepEqual(nstsStatus('boom_over_3m', { year: 2019 }, { inspectionDate: '2024-02-01' }, today),
    { dueDate: '2027-02-01', basis: 'latest_test', state: 'ok' });
  assert.deepEqual(nstsStatus('boom_over_3m', {}, { inspectionDate: '2023-11-30' }, today),
    { dueDate: '2026-11-30', basis: 'latest_test', state: 'due_soon' });
  assert.equal(nstsStatus('boom_over_3m', {}, { inspectionDate: '2025-10-01', nextInspectionDate: '2026-10-01' }, today).state,
    'overdue', 'a typed next date (yearly assurance test) wins');
  assert.deepEqual(nstsStatus('boom_over_3m', {}, null, today), { dueDate: null, basis: null, state: 'unknown' });
});

for (const [status, name, error] of results) {
  console.log(`${status} - ${name}`);
  if (error) console.error(error);
}
if (results.some(([status]) => status === 'FAIL')) process.exit(1);
