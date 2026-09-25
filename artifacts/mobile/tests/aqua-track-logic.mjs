import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = [
  await readFile(new URL('../components/aqua-track-logic.ts', import.meta.url), 'utf8'),
  await readFile(new URL('../components/aqua-track-types.ts', import.meta.url), 'utf8'),
].join('\n');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  aquaTrackAccess,
  aquaTrackSiteQuery,
  hasSelectedAquaSite,
  localDateString,
  localTimeString,
  sessionsForDate,
  isRealCalendarDate,
  isLocalTime,
  poolCheckSuggestedResult,
  canSubmitPoolCheckResult,
  isPoolResultAcknowledged,
  validateOptionalNumber,
  validateOptionalInteger,
  SESSION_TYPES,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

const services = (...granted) => (service) => granted.includes(service);
assert.deepEqual(aquaTrackAccess(services('pooltrack')), {
  pool: true,
  sessions: false,
  any: true,
});
assert.deepEqual(aquaTrackAccess(services('swimtrack')), {
  pool: false,
  sessions: true,
  any: true,
});
assert.deepEqual(aquaTrackAccess(services('aquatrack')), {
  pool: true,
  sessions: true,
  any: true,
});
assert.deepEqual(aquaTrackAccess(services()), {
  pool: false,
  sessions: false,
  any: false,
});
assert.deepEqual(SESSION_TYPES.map((type) => type.value), [
  'public_swim',
  'lane_swim',
  'club_session',
  'lessons',
  'private_hire',
  'aquafit',
  'other',
]);

assert.equal(aquaTrackSiteQuery(null), '');
assert.equal(aquaTrackSiteQuery(27), '?siteId=27');
const availableSites = [{ id: 27 }, { id: 34 }];
assert.equal(hasSelectedAquaSite(null, availableSites), false);
assert.equal(hasSelectedAquaSite(27, availableSites), true);
assert.equal(hasSelectedAquaSite(19, availableSites), false);
assert.equal(hasSelectedAquaSite(27, undefined), false);
const local = new Date(2026, 8, 23, 7, 4);
assert.equal(localDateString(local), '2026-09-23');
assert.equal(localTimeString(local), '07:04');
assert.equal(isRealCalendarDate('2024-02-29'), true);
assert.equal(isRealCalendarDate('2026-02-29'), false);
assert.equal(isRealCalendarDate('2026-13-01'), false);
assert.equal(isRealCalendarDate('0000-01-01'), false);
assert.equal(isLocalTime('23:59'), true);
assert.equal(isLocalTime('24:00'), false);

const safeReadings = {
  ph: 7.4,
  freeChlorine: 2,
  combinedChlorine: 0.1,
  turbidity: 'clear',
  waterTemperature: 29,
};
const emptyReadings = {
  ph: null,
  freeChlorine: null,
  combinedChlorine: null,
  turbidity: null,
  waterTemperature: null,
};
assert.equal(poolCheckSuggestedResult(emptyReadings), null);
assert.equal(canSubmitPoolCheckResult(null, null), false);
assert.equal(canSubmitPoolCheckResult(null, 'pass'), true);
assert.equal(canSubmitPoolCheckResult(null, 'fail'), true);
assert.equal(canSubmitPoolCheckResult('fail', null), false);
assert.equal(canSubmitPoolCheckResult('fail', 'fail'), true);
assert.equal(canSubmitPoolCheckResult('pass', null), true);
assert.equal(isPoolResultAcknowledged(null), false);
assert.equal(isPoolResultAcknowledged('pass'), true);
assert.equal(isPoolResultAcknowledged('fail'), true);
assert.equal(poolCheckSuggestedResult(safeReadings), 'pass');
assert.equal(poolCheckSuggestedResult({
  ph: 7.2,
  freeChlorine: 1,
  combinedChlorine: 0.499,
  turbidity: 'slightly_hazy',
  waterTemperature: 30,
}), 'pass');
assert.equal(poolCheckSuggestedResult({ ...emptyReadings, turbidity: 'clear' }), 'pass');
for (const failedReadings of [
  { ...safeReadings, ph: 7.61 },
  { ...safeReadings, freeChlorine: 0.99 },
  { ...safeReadings, combinedChlorine: 0.5 },
  { ...safeReadings, turbidity: 'hazy' },
  { ...safeReadings, turbidity: 'cloudy' },
  { ...safeReadings, waterTemperature: 30.1 },
]) {
  assert.equal(poolCheckSuggestedResult(failedReadings), 'fail');
}
assert.deepEqual(validateOptionalNumber('14.01', 'pH', 0, 14), {
  value: null,
  error: 'pH must be between 0 and 14.',
});
assert.deepEqual(validateOptionalNumber('NaN', 'pH', 0, 14), {
  value: null,
  error: 'pH must be a finite number.',
});
assert.deepEqual(validateOptionalNumber('Infinity', 'pH', 0, 14), {
  value: null,
  error: 'pH must be a finite number.',
});
assert.deepEqual(validateOptionalNumber('7.4', 'pH', 0, 14), {
  value: 7.4,
  error: null,
});
assert.deepEqual(validateOptionalInteger('1.2', 'Max bathers').error !== null, true);

const sessions = [
  { id: 1, session_date: '2026-09-23' },
  { id: 2, session_date: '2026-09-22T23:00:00.000Z' },
  { id: 3, session_date: '2026-09-23T08:30:00.000Z' },
];
assert.deepEqual(sessionsForDate(sessions, '2026-09-23'), [sessions[0], sessions[2]]);
console.log('AquaTrack entitlement, scope, and local-date tests passed.');