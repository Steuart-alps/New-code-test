import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// GreenTrack machine records on the phone (components/green-records-logic.ts):
// defect, fuel, service and PUWER payloads match the website's dialogs
// (pages/green-track.tsx), bad input is caught before anything is saved on
// the device, manager-only records follow the API's roles, and photo-required
// records take the connected (staged photo) route.
const source = await readFile(new URL('../components/green-records-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  buildDefectPayload, buildFuelPayload, buildServicePayload, buildPuwerPayload, puwerResult,
  canRecordGreenTab, greenSendRoute, isCalendarDate, normalizeGreenMachines, normalizeGreenRecords,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

assert.equal(isCalendarDate('2026-10-15'), true);
for (const bad of ['2026-02-29', '2026-13-01', '15/10/2026', '']) assert.equal(isCalendarDate(bad), false, bad);

// Defects: the website's create fields; new reports are always open (the API
// ignores status on create), blank text becomes null.
const defect = { reportDate: '2026-10-15', reportedBy: ' Operator ', severity: 'major', outOfService: true, description: ' Cracked guard ', notes: ' ' };
assert.deepEqual(buildDefectPayload(defect, 4), {
  ok: true,
  payload: { machineId: 4, reportDate: '2026-10-15', reportedBy: 'Operator', description: 'Cracked guard', severity: 'major', outOfService: true, notes: null },
});
assert.equal('status' in buildDefectPayload(defect, 4).payload, false);
assert.equal(buildDefectPayload(defect, null).ok, false, 'a machine is required');
assert.equal(buildDefectPayload({ ...defect, description: '  ' }, 4).ok, false, 'a description is required');
assert.equal(buildDefectPayload({ ...defect, severity: 'urgent' }, 4).ok, false);
assert.equal(buildDefectPayload({ ...defect, reportDate: '2026-02-30' }, 4).ok, false);

// Fuel: numbers as the website parses them, cost in whole pence.
const fuel = { logDate: '2026-10-15', fuelType: 'diesel', quantityLitres: '25.5', engineHours: '512', costPounds: '31.50', filledBy: 'Operator', notes: '' };
assert.deepEqual(buildFuelPayload(fuel, 4), {
  ok: true,
  payload: { machineId: 4, logDate: '2026-10-15', fuelType: 'diesel', quantityLitres: 25.5, engineHours: 512, costPence: 3150, filledBy: 'Operator', notes: null },
});
const blanks = buildFuelPayload({ ...fuel, quantityLitres: '', engineHours: ' ', costPounds: '' }, 4).payload;
assert.deepEqual([blanks.quantityLitres, blanks.engineHours, blanks.costPence], [null, null, null], 'optional numbers may be blank');
assert.equal(buildFuelPayload({ ...fuel, costPounds: '0.1' }, 4).payload.costPence, 10);
for (const bad of [{ quantityLitres: 'lots' }, { quantityLitres: '10000' }, { engineHours: '5.5' }, { engineHours: '-3' }, { costPounds: '£5' }, { fuelType: 'gas' }]) {
  assert.equal(buildFuelPayload({ ...fuel, ...bad }, 4).ok, false, JSON.stringify(bad));
}

// Service records.
const service = {
  serviceDate: '2026-10-15', serviceType: 'scheduled', hoursAtService: '450', nextServiceHours: '550', nextServiceDate: '2027-04-15',
  workPerformed: 'Oil change', servicedBy: 'Mechanic', costPounds: '120', notes: '',
};
assert.deepEqual(buildServicePayload(service, 4), {
  ok: true,
  payload: {
    machineId: 4, serviceDate: '2026-10-15', serviceType: 'scheduled', hoursAtService: 450, nextServiceHours: 550,
    nextServiceDate: '2027-04-15', workPerformed: 'Oil change', servicedBy: 'Mechanic', costPence: 12000, notes: null,
  },
});
assert.equal(buildServicePayload({ ...service, nextServiceDate: '' }, 4).payload.nextServiceDate, null);
assert.equal(buildServicePayload({ ...service, nextServiceDate: 'soon' }, 4).ok, false);
assert.equal(buildServicePayload({ ...service, hoursAtService: '4h' }, 4).ok, false);
assert.equal(buildServicePayload({ ...service, serviceType: 'weekly' }, 4).ok, false);

// PUWER: the website's result (advisory when safe with observations).
const puwer = {
  inspectionDate: '2026-10-15', nextInspectionDate: '2027-10-15', inspectionType: 'thorough_examination', inspectorName: 'Inspector',
  inspectorCompany: 'Safe Co', certRef: 'PUWER-1', safeToOperate: true, defectsFound: '', notes: '',
};
assert.deepEqual(buildPuwerPayload(puwer, 4), {
  ok: true,
  payload: {
    machineId: 4, inspectionDate: '2026-10-15', nextInspectionDate: '2027-10-15', inspectionType: 'thorough_examination',
    inspectorName: 'Inspector', inspectorCompany: 'Safe Co', certRef: 'PUWER-1', safeToOperate: true, defectsFound: null, result: 'pass', notes: null,
  },
});
assert.equal(puwerResult(true, 'Worn tyre'), 'advisory');
assert.equal(puwerResult(false, ''), 'fail');
assert.equal(buildPuwerPayload({ ...puwer, safeToOperate: false, defectsFound: 'Brakes' }, 4).payload.result, 'fail');
assert.equal(buildPuwerPayload({ ...puwer, inspectionType: 'visual' }, 4).ok, false);
assert.equal(buildPuwerPayload({ ...puwer, nextInspectionDate: '2027-02-30' }, 4).ok, false);

// Roles: service records and PUWER inspections are manager records (the API
// requires an admin); viewers record nothing.
for (const tab of ['defect', 'fuel', 'service', 'puwer']) {
  assert.equal(canRecordGreenTab('client_admin', tab), true, tab);
  assert.equal(canRecordGreenTab('consultant', tab), true, tab);
  assert.equal(canRecordGreenTab('client_viewer', tab), false, tab);
  assert.equal(canRecordGreenTab(null, tab), false, tab);
}
assert.equal(canRecordGreenTab('client_staff', 'defect'), true);
assert.equal(canRecordGreenTab('client_staff', 'fuel'), true);
assert.equal(canRecordGreenTab('client_staff', 'service'), false);
assert.equal(canRecordGreenTab('client_staff', 'puwer'), false);

// Send route for defects and service records: required photos need signal.
const evidence = (over) => ({ enabled: true, loading: false, loadFailed: false, required: false, ...over });
assert.equal(greenSendRoute(evidence({ required: true })), 'photos');
assert.equal(greenSendRoute(evidence({})), 'outbox', 'no photo rule: saved offline through the outbox');
assert.equal(greenSendRoute(evidence({ loading: true })), 'wait');
assert.equal(greenSendRoute(evidence({ loadFailed: true, required: false })), 'outbox', 'requirements unknown offline: the outbox keeps the record');
assert.equal(greenSendRoute(evidence({ enabled: false })), 'outbox');

// Machines: active only; snake_case rows from the API.
assert.deepEqual(normalizeGreenMachines([
  { id: 1, name: 'Mower', type: 'ride_on', active: true, site_name: 'Course' },
  { id: 2, name: 'Old blower', type: 'blower', active: false },
  { id: 'x', name: 'Broken' },
]), [{ id: 1, name: 'Mower', type: 'ride_on', siteName: 'Course' }]);
assert.deepEqual(normalizeGreenMachines({ error: 'nope' }), []);

// Recent rows.
const [defectRow] = normalizeGreenRecords('defect', [{
  id: 9, machine_id: 1, machine_name: 'Mower', report_date: '2026-10-15T00:00:00.000Z', description: 'Cracked guard',
  severity: 'critical', out_of_service: true, status: 'open', reported_by: 'Operator',
}]);
assert.deepEqual(defectRow, {
  id: 9, machineId: 1, machineName: 'Mower', date: '2026-10-15', title: 'Cracked guard',
  detail: 'Critical · Out of service · Operator', flag: { label: 'Open', tone: 'danger' },
});
const [fuelRow] = normalizeGreenRecords('fuel', [{ id: 3, machine_id: 1, log_date: '2026-10-15', fuel_type: 'hyd_oil', quantity_litres: '5.00', engine_hours: 512 }]);
assert.equal(fuelRow.title, 'Hydraulic oil');
assert.equal(fuelRow.detail, '5 L · 512 h');
const [puwerRow] = normalizeGreenRecords('puwer', [{ id: 4, machine_id: 1, inspection_date: '2026-10-15', inspection_type: 'loler_examination', safe_to_operate: false }]);
assert.deepEqual(puwerRow.flag, { label: 'Not safe', tone: 'danger' });
const [serviceRow] = normalizeGreenRecords('service', [{ id: 5, machine_id: 1, machine_name: 'Mower', service_date: '2026-10-01', service_type: 'annual', work_performed: 'Blades', serviced_by: 'Dealer', next_service_date: '2027-10-01' }]);

// The same lists as camelCase rows (the API's list endpoints have returned
// both): every field still reads.
assert.deepEqual(normalizeGreenMachines([
  { id: 1, clientId: 1, siteId: 3, name: 'Mower', type: 'ride_on', serialNo: 'S1', regNo: null, active: true, siteName: 'Course' },
  { id: 2, name: 'Old blower', type: 'blower', active: false, siteName: null },
]), [{ id: 1, name: 'Mower', type: 'ride_on', siteName: 'Course' }], 'camelCase machines');
assert.deepEqual(normalizeGreenRecords('defect', [{
  id: 9, machineId: 1, machineName: 'Mower', reportDate: '2026-10-15T00:00:00.000Z', description: 'Cracked guard',
  severity: 'critical', outOfService: true, status: 'open', reportedBy: 'Operator', reportedByRosterId: null,
}]), [defectRow], 'camelCase defects');
assert.deepEqual(normalizeGreenRecords('fuel', [{ id: 3, machineId: 1, logDate: '2026-10-15', fuelType: 'hyd_oil', quantityLitres: '5.00', engineHours: 512 }]),
  [fuelRow], 'camelCase fuel logs');
assert.deepEqual(normalizeGreenRecords('puwer', [{ id: 4, machineId: 1, inspectionDate: '2026-10-15', inspectionType: 'loler_examination', safeToOperate: false }]),
  [puwerRow], 'camelCase PUWER inspections');
assert.deepEqual(normalizeGreenRecords('service', [{ id: 5, machineId: 1, machineName: 'Mower', serviceDate: '2026-10-01', serviceType: 'annual', workPerformed: 'Blades', servicedBy: 'Dealer', nextServiceDate: '2027-10-01' }]),
  [serviceRow], 'camelCase service records');
assert.deepEqual(serviceRow, {
  id: 5, machineId: 1, machineName: 'Mower', date: '2026-10-01', title: 'Annual service',
  detail: 'Blades · Dealer', flag: { label: 'Next 2027-10-01', tone: 'muted' },
});

console.log('GreenTrack machine record tests passed: website payloads, input checks, manager-only records, photo route, list rows.');
