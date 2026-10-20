// Which weekly review answers fail the week.
// Run: pnpm --filter @workspace/api-zod run test:kitchen-weekly
import assert from 'node:assert/strict';
import {
  kitchenWeeklyAttentionAnswer, kitchenWeeklyNeedsAttention, kitchenWeeklyResult,
} from '../src/kitchen-weekly.ts';

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error]); } };

// A week where every answer is the good one, as a careful manager would fill it in.
const goodWeek = {
  training: 'yes', personalHygiene: 'yes', cleaning: 'yes', crossContamination: 'yes', pestControl: 'yes',
  wasteControl: 'yes', maintenance: 'yes', stockControl: 'yes', temperatureControl: 'yes', recordsComplete: 'yes',
  safeMethodsReviewed: 'yes', allergensUpdated: 'yes', methodsOrEquipmentChanged: 'no', newSuppliersReviewed: 'na',
  cleaningScheduleNeedsUpdate: 'no', cleaningScheduleCompleted: 'yes', newStaffTrained: 'na',
  staffRefresherRequired: 'no', additionalChecksRequired: 'no', complaintsReceived: 'no',
  complaintsInvestigated: 'na', extraChecksCompleted: 'yes', proveitChecksCompleted: 'yes',
};

test('"No" to complaints, schedule update, refresher training and the other change questions passes', () => {
  assert.equal(kitchenWeeklyResult(goodWeek), 'pass');
});

test('"No" to a good-practice question still fails', () => {
  assert.equal(kitchenWeeklyResult({ ...goodWeek, temperatureControl: 'no' }), 'fail');
  assert.equal(kitchenWeeklyResult({ ...goodWeek, complaintsInvestigated: 'no' }), 'fail');
});

test('"Yes" to a question asking whether something still needs doing fails', () => {
  assert.equal(kitchenWeeklyResult({ ...goodWeek, cleaningScheduleNeedsUpdate: 'yes' }), 'fail');
  assert.equal(kitchenWeeklyResult({ ...goodWeek, staffRefresherRequired: 'yes' }), 'fail');
});

test('a change recorded with a passing follow-up passes', () => {
  assert.equal(kitchenWeeklyResult({ ...goodWeek, complaintsReceived: 'yes', complaintsInvestigated: 'yes' }), 'pass');
  assert.equal(kitchenWeeklyResult({ ...goodWeek, methodsOrEquipmentChanged: 'yes' }), 'pass');
  assert.equal(kitchenWeeklyResult({ ...goodWeek, additionalChecksRequired: 'yes' }), 'pass');
});

test('N/A and unanswered questions never fail', () => {
  assert.equal(kitchenWeeklyResult({}), 'pass');
  assert.equal(kitchenWeeklyResult({ temperatureControl: 'na', staffRefresherRequired: 'na' }), 'pass');
  assert.equal(kitchenWeeklyNeedsAttention('training', ''), false);
});

test('attention answer per question', () => {
  assert.equal(kitchenWeeklyAttentionAnswer('training'), 'no');
  assert.equal(kitchenWeeklyAttentionAnswer('staffRefresherRequired'), 'yes');
  assert.equal(kitchenWeeklyAttentionAnswer('complaintsReceived'), null);
  // A question added later defaults to the good-practice rule.
  assert.equal(kitchenWeeklyAttentionAnswer('someNewQuestion'), 'no');
});

for (const [status, name, error] of results) {
  console.log(`${status} - ${name}`);
  if (error) console.error(error);
}
if (results.some(([status]) => status === 'FAIL')) process.exit(1);
