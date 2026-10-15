import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// KitchenTrack probe calibration and weekly review on the phone
// (components/kitchen-extras-logic.ts): the payloads match the website's
// "Submit & Sign" (pages/kitchen-probe.tsx, kitchen-weekly.tsx) and the
// API's schema (routes/kitchen-weekly.ts), checked before anything is saved
// on the device.
const source = await readFile(new URL('../components/kitchen-extras-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  HOUSE_RULES, REVIEW_QUESTIONS, WEEKLY_QUESTION_COUNT,
  addDays, buildProbeCheckPayload, buildWeeklyReviewPayload, defaultProbeRows, displayDate, emptyProbeRow,
  isCalendarDate, pendingEntryFor, probeNamesFromConfig, probeOverallResult, readingWithinTolerance,
  weekCommencing, weeklyAnsweredCount, weeklyNoAnswers,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

const today = '2026-10-15';
const at = '2026-10-15T09:30:00.000Z';

// Dates and weeks (website: week starts on Monday).
assert.equal(isCalendarDate('2026-02-29'), false);
assert.equal(addDays('2026-10-15', -7), '2026-10-08');
assert.equal(addDays('2026-03-01', -1), '2026-02-28');
assert.equal(weekCommencing('2026-10-15'), '2026-10-12', 'Thursday -> Monday');
assert.equal(weekCommencing('2026-10-12'), '2026-10-12', 'Monday stays');
assert.equal(weekCommencing('2026-10-18'), '2026-10-12', 'Sunday belongs to the week before');
assert.equal(weekCommencing('2026-01-01'), '2025-12-29', 'across a year end');
assert.equal(displayDate('2026-10-12T00:00:00.000Z'), '12/10/2026');
assert.equal(displayDate(null), '');

// Probe names from the account's food safety settings, read as the website does.
assert.deepEqual(probeNamesFromConfig('["Probe 1"," ","Blue probe",3]'), ['Probe 1', 'Blue probe']);
assert.deepEqual(probeNamesFromConfig('not json'), []);
assert.deepEqual(probeNamesFromConfig(''), []);
assert.deepEqual(defaultProbeRows(['A', 'B']).map((row) => row.name), ['A', 'B']);
assert.deepEqual(defaultProbeRows([]), [emptyProbeRow()]);

// Overall result: the website's auto-compute from the accuracy answers.
const row = (patch) => ({ ...emptyProbeRow('Probe 1'), ...patch });
assert.equal(probeOverallResult([row({})]), '', 'nothing answered yet');
assert.equal(probeOverallResult([row({ accurateIce: true }), row({ accurateBoiling: true })]), 'pass');
assert.equal(probeOverallResult([row({ accurateIce: true, accurateBoiling: false })]), 'fail');
assert.equal(readingWithinTolerance('0.4', 0), true);
assert.equal(readingWithinTolerance('-1.2', 0), false);
assert.equal(readingWithinTolerance('99,1', 100), true, 'a decimal comma is read as a point');
assert.equal(readingWithinTolerance('98.9', 100), false);
assert.equal(readingWithinTolerance('', 0), null);
assert.equal(readingWithinTolerance('abc', 100), null);

// Probe payload: the API's fields; blank probe rows are dropped, unanswered
// accuracy is left out (as the website's JSON does), free-text performer.
const probeDraft = {
  checkDate: '2026-10-14',
  probes: [
    row({ serialNo: ' SN1 ', iceTemp: ' 0.3 ', boilingTemp: '99.8', accurateIce: true, accurateBoiling: true }),
    row({ name: 'Blue probe', iceTemp: '1.6', accurateIce: false, notes: ' Replaced ' }),
    emptyProbeRow(),
  ],
  checkedBy: ' Chef ',
  signature: ' A Manager ',
  notes: '  ',
};
assert.deepEqual(buildProbeCheckPayload(probeDraft, today, at), {
  ok: true,
  payload: {
    checkDate: '2026-10-14',
    probes: [
      { name: 'Probe 1', serialNo: 'SN1', iceTemp: '0.3', boilingTemp: '99.8', accurateIce: true, accurateBoiling: true, notes: '' },
      { name: 'Blue probe', serialNo: '', iceTemp: '1.6', boilingTemp: '', accurateIce: false, notes: 'Replaced' },
    ],
    overallResult: 'fail',
    checkedBy: 'Chef',
    checkedByRosterId: null,
    signature: 'A Manager',
    notes: null,
    submittedAt: at,
  },
});
assert.equal(buildProbeCheckPayload({ ...probeDraft, probes: [row({ iceTemp: '0' })] }, today, at).payload.overallResult, null,
  'no accuracy answered: no result, as on the website');
assert.equal(buildProbeCheckPayload({ ...probeDraft, signature: ' ' }, today, at).ok, false, 'signature required to submit');
assert.equal(buildProbeCheckPayload({ ...probeDraft, probes: [emptyProbeRow()] }, today, at).ok, false, 'at least one probe');
assert.equal(buildProbeCheckPayload({ ...probeDraft, probes: [] }, today, at).ok, false);
assert.equal(buildProbeCheckPayload({ ...probeDraft, checkDate: '2026-10-16' }, today, at).ok, false, 'no future check date');
assert.equal(buildProbeCheckPayload({ ...probeDraft, checkDate: '2026-02-30' }, today, at).ok, false);

// Weekly review: the website's 10 house rules and 13 review questions.
assert.equal(HOUSE_RULES.length, 10);
assert.equal(REVIEW_QUESTIONS.length, 13);
assert.equal(WEEKLY_QUESTION_COUNT, 23);
assert.equal(new Set([...HOUSE_RULES, ...REVIEW_QUESTIONS].map((q) => q.key)).size, 23, 'keys are unique');
const websiteSource = await readFile(new URL('../../compliance-tracker/src/pages/kitchen-weekly.tsx', import.meta.url), 'utf8');
for (const q of [...HOUSE_RULES, ...REVIEW_QUESTIONS]) {
  assert.match(websiteSource, new RegExp(`key: "${q.key}"`), `${q.key} is a website question`);
}

const weeklyDraft = {
  weekCommencing: '2026-10-12',
  checks: { training: 'yes', cleaning: 'no', pestControl: 'na', complaintsReceived: undefined, notAQuestion: 'yes' },
  deviations: [{ rule: ' Cleaning ', action: ' Re-briefed staff ' }, { rule: ' ', action: '' }, { rule: '', action: 'Deep clean' }],
  issuesThreeTimes: 'no',
  actionTaken: '  ',
  managerSignature: ' A Manager ',
};
assert.deepEqual(buildWeeklyReviewPayload(weeklyDraft, today, at), {
  ok: true,
  payload: {
    weekCommencing: '2026-10-12',
    checks: { training: 'yes', cleaning: 'no', pestControl: 'na' },
    deviations: [{ rule: 'Cleaning', action: 'Re-briefed staff' }, { action: 'Deep clean' }],
    additional: { issuesThreeTimes: 'no' },
    managerSignature: 'A Manager',
    submittedAt: at,
  },
});
assert.deepEqual(buildWeeklyReviewPayload({ ...weeklyDraft, issuesThreeTimes: null, actionTaken: 'Retrained' }, today, at).payload.additional,
  { actionTaken: 'Retrained' });
assert.equal(buildWeeklyReviewPayload({ ...weeklyDraft, managerSignature: '' }, today, at).ok, false, 'manager signature required');
assert.equal(buildWeeklyReviewPayload({ ...weeklyDraft, weekCommencing: '2026-10-19' }, today, at).ok, false, 'no future week');
assert.deepEqual(weeklyNoAnswers(weeklyDraft.checks), ['Cleaning']);
assert.equal(weeklyAnsweredCount(weeklyDraft.checks), 3);

// One record per date: an unsent device copy for the date blocks a second;
// a refused copy does not (the outbox panel offers Retry or Remove).
const entries = [
  { state: 'queued', body: { checkDate: '2026-10-14' } },
  { state: 'sending', body: { weekCommencing: '2026-10-12' } },
  { state: 'failed', body: { checkDate: '2026-10-07' } },
];
assert.equal(pendingEntryFor(entries, 'checkDate', '2026-10-14'), entries[0]);
assert.equal(pendingEntryFor(entries, 'checkDate', '2026-10-13'), undefined);
assert.equal(pendingEntryFor(entries, 'weekCommencing', '2026-10-12'), entries[1]);
assert.equal(pendingEntryFor(entries, 'checkDate', '2026-10-07'), undefined);

console.log('KitchenTrack probe and weekly logic tests passed: weeks, probe names, overall result, website payloads, validation, pending entries.');
