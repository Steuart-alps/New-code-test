import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// FireTrack on the phone: weekly alarm tests name the call point and drills say
// whether night staff took part, as artifacts/api-server/src/routes/fire-safety.ts
// requires (400 "Say which call point was tested" otherwise).
const source = await readFile(new URL('../components/fire-check-logic.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  FIRE_TYPES, NIGHT_STAFF_OPTIONS, NO_CALL_POINT, CALL_POINT_REQUIRED, NIGHT_STAFF_REQUIRED,
  activeCallPoints, callPointsPath, fireDetailsBody, fireDetailsError, fireHistoryDetails, nextCallPoint, nightStaffLabel,
} = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

const label = (value) => FIRE_TYPES.find((type) => type.value === value)?.label;
assert.equal(label('emergency_lights'), 'Monthly emergency lighting flick test');
assert.equal(label('fire_drill'), 'Fire drill (6-monthly, with night staff)');
assert.deepEqual(NIGHT_STAFF_OPTIONS.map((option) => option.value), ['included', 'not_included', 'no_night_staff']);

// The list is per site; records with no site use siteId=none.
assert.equal(callPointsPath(7), '/api/fire-safety/call-points?siteId=7');
assert.equal(callPointsPath(null), '/api/fire-safety/call-points?siteId=none');

const rows = [
  { id: 1, siteId: 7, name: 'CP1 Reception', archivedAt: null, lastTestedDate: '2026-10-09' },
  { id: 2, siteId: 7, name: 'CP2 Kitchen', archivedAt: null, lastTestedDate: '2026-09-25' },
  { id: 3, siteId: 7, name: 'CP3 Old wing', archivedAt: '2026-08-01T00:00:00Z', lastTestedDate: null },
  { id: 4, siteId: 8, name: 'CP1 Annex', archivedAt: null, lastTestedDate: null },
];
const active = activeCallPoints(rows, 7);
assert.deepEqual(active.map((p) => p.id), [1, 2], 'archived points and other sites are left out');
assert.equal(nextCallPoint(active).id, 2, 'the point tested longest ago is suggested');
assert.equal(nextCallPoint([...active, { id: 5, siteId: 7, name: 'CP5 Store', lastTestedDate: null }]).id, 5,
  'a point never tested comes first');
assert.equal(nextCallPoint([
  { id: 9, siteId: null, name: 'B', lastTestedDate: null },
  { id: 8, siteId: null, name: 'A', lastTestedDate: null },
]).id, 8, 'ties go by name');
assert.equal(nextCallPoint([]), undefined);
assert.deepEqual(activeCallPoints(rows, null), [], 'no-site records only see points with no site');

// An older API (404) or an error body is no list, so the call point is typed in.
for (const data of [undefined, null, { error: 'Not found' }, 'text']) assert.deepEqual(activeCallPoints(data, 7), []);

// Alarm tests need a chosen or typed call point.
assert.equal(fireDetailsError('alarm', NO_CALL_POINT, null), CALL_POINT_REQUIRED);
assert.equal(CALL_POINT_REQUIRED, 'Say which call point was tested', 'same words as the API');
assert.equal(fireDetailsError('alarm', { callPointId: null, callPoint: '   ' }, null), CALL_POINT_REQUIRED);
assert.equal(fireDetailsError('alarm', { callPointId: 2, callPoint: 'CP2 Kitchen' }, null), null);
assert.equal(fireDetailsError('alarm', { callPointId: null, callPoint: 'Back door' }, null), null);
assert.deepEqual(fireDetailsBody('alarm', { callPointId: 2, callPoint: 'CP2 Kitchen' }, null), { callPointId: 2 },
  'a listed point is sent by id (the server copies its name)');
assert.deepEqual(fireDetailsBody('alarm', { callPointId: null, callPoint: ' Back door ' }, null), { callPoint: 'Back door' });

// Drills need the night staff answer.
assert.equal(fireDetailsError('fire_drill', NO_CALL_POINT, null), NIGHT_STAFF_REQUIRED);
assert.equal(fireDetailsError('fire_drill', NO_CALL_POINT, 'no_night_staff'), null);
assert.deepEqual(fireDetailsBody('fire_drill', NO_CALL_POINT, 'included'), { nightStaff: 'included' });

// Other checks send nothing extra and need nothing.
for (const type of ['emergency_lights', 'extinguishers', 'fire_doors']) {
  assert.equal(fireDetailsError(type, NO_CALL_POINT, null), null);
  assert.deepEqual(fireDetailsBody(type, { callPointId: 2, callPoint: 'CP2' }, 'included'), {});
}

// History rows show the call point and night staff answer, in either casing.
assert.deepEqual(fireHistoryDetails({ callPoint: 'CP2 Kitchen', nightStaff: null }), ['Call point: CP2 Kitchen']);
assert.deepEqual(fireHistoryDetails({ night_staff: 'not_included' }), ['Night staff did not take part']);
assert.deepEqual(fireHistoryDetails({ call_point: ' ', location: 'Reception' }), []);
assert.equal(nightStaffLabel('some_new_value'), 'some new value');

// The form wires these in (no mounted test for the shared check form yet).
const form = await readFile(new URL('../app/checks/[type].tsx', import.meta.url), 'utf8');
assert.match(form, /fireDetailsError\(checkType, callPointChoice, nightStaff\)/);
assert.match(form, /\.\.\.\(isFire \? fireDetailsBody\(checkType, callPointChoice, nightStaff\) : \{\}\)/);
assert.doesNotMatch(form, /const FIRE_TYPES =/, 'the form uses the shared labels');

console.log('fire check logic: ok');
