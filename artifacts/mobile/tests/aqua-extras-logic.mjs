import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// AquaTrack surveillance, first-aid and incident forms on the phone
// (components/aqua-extras-logic.ts): payloads match the website's forms
// (pages/aqua-track.tsx) field for field, every value is checked before the
// record is saved on the device, and the photo rule that picks outbox or
// direct sending.
const source = await readFile(new URL('../components/aqua-extras-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  buildSurveillancePayload, buildFirstAidPayload, buildIncidentPayload, firstAidResult, allFirstAidItemsOk,
  aquaRecordRoute, isOpenIncident, incidentTypeLabel, FIRST_AID_ITEMS, INCIDENT_TYPES, INCIDENT_SEVERITIES,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

// Surveillance: the website's body, including its result from the scan.
const surveillance = { checkDate: '2026-10-15', checkTime: '10:15', batherCount: '12', scanCompleted: true, observations: ' Clear ', checkedBy: '' };
assert.deepEqual(buildSurveillancePayload(surveillance, 7), {
  ok: true,
  payload: {
    siteId: 7, checkDate: '2026-10-15', checkTime: '10:15', batherCount: 12, scanCompleted: true,
    observations: 'Clear', checkedBy: null, result: 'pass',
  },
});
const missed = buildSurveillancePayload({ ...surveillance, scanCompleted: false, checkTime: '', batherCount: '' }, 7);
assert.equal(missed.payload.result, 'fail', 'a scan not completed is a fail');
assert.equal(missed.payload.checkTime, null);
assert.equal(missed.payload.batherCount, null);
for (const [field, value] of [['checkDate', '2026-02-30'], ['checkDate', '15/10/2026'], ['checkTime', '25:00'], ['checkTime', '9:5'],
  ['batherCount', '-1'], ['batherCount', '2.5'], ['batherCount', 'ten'], ['checkedBy', 'x'.repeat(201)], ['observations', 'x'.repeat(2001)]]) {
  assert.equal(buildSurveillancePayload({ ...surveillance, [field]: value }, 7).ok, false, `${field}=${value.slice(0, 12)}`);
}

// First aid: all seven website items, any one not ready fails the check.
assert.deepEqual(FIRST_AID_ITEMS.map((item) => item.key),
  ['aedOk', 'firstAidKitOk', 'rescuePoleOk', 'throwBagOk', 'spineBoardOk', 'ringBuoyOk', 'oxygenKitOk']);
const items = allFirstAidItemsOk();
assert.equal(firstAidResult(items), 'pass');
assert.equal(firstAidResult({ ...items, oxygenKitOk: false }), 'fail');
assert.deepEqual(buildFirstAidPayload({ checkDate: '2026-10-15', items: { ...items, throwBagOk: false }, checkedBy: ' Sam ', defectsFound: 'Frayed rope', notes: '' }, 7), {
  ok: true,
  payload: {
    siteId: 7, checkDate: '2026-10-15', checkedBy: 'Sam', defectsFound: 'Frayed rope', notes: null,
    aedOk: true, firstAidKitOk: true, rescuePoleOk: true, throwBagOk: false, spineBoardOk: true, ringBuoyOk: true, oxygenKitOk: true,
  },
});
assert.equal(buildFirstAidPayload({ checkDate: '2026-13-01', items, checkedBy: '', defectsFound: '', notes: '' }, 7).ok, false);

// Incidents: the website's types and severities; description required.
assert.deepEqual(INCIDENT_TYPES.map((type) => type.value),
  ['near_miss', 'minor_injury', 'major_injury', 'drowning_rescue', 'pool_evacuation', 'medical', 'other']);
assert.deepEqual(INCIDENT_SEVERITIES.map((item) => item.value), ['low', 'medium', 'high', 'critical']);
assert.equal(incidentTypeLabel('drowning_rescue'), 'Drowning / rescue');
const incident = {
  incidentDate: '2026-10-15', incidentTime: '', incidentType: 'near_miss', severity: 'low', personsInvolved: '1 adult bather',
  description: ' Slipped on poolside ', actionTaken: '', reportedTo: '', reportedDate: '', outcome: '', notes: '',
};
assert.deepEqual(buildIncidentPayload(incident, 7), {
  ok: true,
  payload: {
    siteId: 7, incidentDate: '2026-10-15', incidentTime: null, incidentType: 'near_miss', severity: 'low',
    personsInvolved: '1 adult bather', description: 'Slipped on poolside', actionTaken: null, reportedTo: null,
    reportedDate: null, outcome: null, notes: null,
  },
});
for (const [field, value] of [['description', '   '], ['incidentDate', ''], ['incidentTime', '12:60'], ['reportedDate', '2026-02-29'],
  ['incidentType', 'shark'], ['severity', 'extreme'], ['personsInvolved', 'x'.repeat(201)]]) {
  assert.equal(buildIncidentPayload({ ...incident, [field]: value }, 7).ok, false, `${field}=${value.slice(0, 12)}`);
}
assert.equal(isOpenIncident({ outcome: null }), true);
assert.equal(isOpenIncident({ outcome: ' ' }), true);
assert.equal(isOpenIncident({ outcome: 'Discharged' }), false);

// Without required photos records go through the outbox (work offline);
// required photos need a connection; an unknown requirement queues.
assert.equal(aquaRecordRoute({ required: false, loadFailed: false }), 'outbox');
assert.equal(aquaRecordRoute({ required: true, loadFailed: false }), 'direct');
assert.equal(aquaRecordRoute({ required: false, loadFailed: true }), 'outbox');
assert.equal(aquaRecordRoute({ required: true, loadFailed: true }), 'outbox');

console.log('AquaTrack extras logic tests passed: website payloads, device-side validation, photo route.');
