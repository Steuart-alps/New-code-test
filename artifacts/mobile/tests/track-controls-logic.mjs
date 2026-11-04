import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/track-controls-logic.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  cadenceLabel, controlsReadiness, fireControlFields, formatControlDate, historyByCheckType,
  initialControlsSite, monitoringPlanState, parseControlModule, parseSiteParam, reviewDateState,
  temperatureLimitLabel, waterControlFields,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

assert.equal(parseControlModule('fire'), 'fire');
assert.equal(parseControlModule(['water']), 'water');
assert.equal(parseControlModule('hot-tub'), null);
assert.equal(parseSiteParam('12'), 12);
for (const bad of ['0', '-1', '1.5', '12abc', '', undefined, '99999999999999999999']) assert.equal(parseSiteParam(bad), null, String(bad));

const sites = [{ id: 3 }, { id: 8 }];
assert.equal(initialControlsSite(sites, 8), 8);
assert.equal(initialControlsSite(sites, 42), 3, 'a site the user cannot see falls back to their first site');
assert.equal(initialControlsSite([], 8), null);

assert.equal(cadenceLabel(7), 'Weekly (every 7 days)');
assert.equal(cadenceLabel(183), 'Six-monthly (every 183 days)');
assert.equal(cadenceLabel(1), 'Daily (every 1 day)');
assert.equal(cadenceLabel(45), 'Every 45 days');
assert.equal(cadenceLabel(null), 'No approved frequency');
assert.equal(cadenceLabel(0), 'No approved frequency');

assert.equal(temperatureLimitLabel({ min: 60 }), 'At least 60°C');
assert.equal(temperatureLimitLabel({ max: 20 }), 'At most 20°C');
assert.equal(temperatureLimitLabel({ min: 50, max: 60 }), '50–60°C');
assert.equal(temperatureLimitLabel({}), null);
assert.equal(formatControlDate('2026-10-01'), '1 Oct 2026');
assert.equal(formatControlDate('2026-10-01T23:30:00.000Z'), '1 Oct 2026', 'a timestamp keeps its recorded date');
assert.equal(formatControlDate('not a date'), '—');

const today = '2026-10-10';
assert.equal(reviewDateState('2026-10-09', today), 'overdue');
assert.equal(reviewDateState('2026-10-10', today), 'due_soon');
assert.equal(reviewDateState('2026-11-09', today), 'due_soon');
assert.equal(reviewDateState('2026-11-10', today), 'ok');
assert.equal(reviewDateState(null, today), 'missing');

// The FRA assessment date is historical; only review dates can be overdue.
const fire = controlsReadiness(fireControlFields({
  riskAssessmentReference: 'FRA-1', riskAssessmentDate: '2020-01-01', nextReviewDate: '2026-09-30',
  responsiblePerson: '  ', maintenanceEvidenceReference: 'MAINT-1',
}), today);
assert.deepEqual(fire.missing, ['Responsible person'], 'blank text counts as missing');
assert.deepEqual(fire.overdueReviews, ['Next review date']);
assert.equal(fire.ready, false);
assert.equal(`${fire.recorded}/${fire.total}`, '4/5');

// Approved plan references fill gaps left by the older config profile fields.
const plan = { approved: true, profile: { writtenSchemeReference: 'WS-9', riskAssessmentReference: 'LRA-9', competentPerson: 'CP' } };
const water = controlsReadiness(waterControlFields({ riskAssessmentReviewDate: '2027-01-01' }, plan), today, monitoringPlanState(plan));
assert.equal(water.ready, true);
assert.equal(`${water.recorded}/${water.total}`, '5/5');
assert.equal(monitoringPlanState({ approved: false, profile: { reviewRequired: true } }), 'review_required');
assert.equal(monitoringPlanState(undefined), 'not_approved');
assert.deepEqual(controlsReadiness(waterControlFields(null), today, 'review_required').missing.at(-1), 'Approved monitoring plan');

const grouped = historyByCheckType([
  { id: 1, checkType: 'alarm', checkDate: '2026-10-01', result: 'pass' },
  { id: 4, checkType: 'alarm', checkDate: '2026-10-08', result: 'pass' },
  { id: 3, checkType: 'alarm', checkDate: '2026-10-08', result: 'fail' },
  { id: 2, checkType: 'alarm', checkDate: '2026-09-01', result: 'pass' },
  { id: 5, checkType: 'fire_doors', checkDate: '2026-07-01', result: 'pass' },
]);
assert.deepEqual(grouped.get('alarm').map((row) => row.id), [4, 3, 1]);
assert.deepEqual(grouped.get('fire_doors').map((row) => row.id), [5]);

console.log('Track controls logic tests passed.');
