import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// BikeTrack on the phone (components/bike-track-logic.ts): the hire, return
// and service payloads match the website's forms (pages/bike-track.tsx),
// dates and money are checked before anything is saved on the device, and
// the fleet / hire site rules.
const source = await readFile(new URL('../components/bike-track-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  CHECK_ITEMS, activeHiresForSite, autoNextService, bikeSiteChoice, bikesForSite, buildHirePayload, buildReturnPayload,
  buildServicePayload, defaultDepositText, defaultExpectedReturn, emptyCheckItems, isConnectionFailure, isOverdueReturn,
  normalizeBikeHires, normalizeBikeServices, normalizeLatestServices, overallResult, pendingHireBikeIds, poundsToPence,
  serviceDue,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

// The website's twelve checklist items, all passing by default.
assert.deepEqual(CHECK_ITEMS.map((item) => item.key), [
  'brakesFront', 'brakesRear', 'tyreFront', 'tyreRear', 'chainGears', 'lightsFront', 'lightsRear',
  'frame', 'saddleSeatpost', 'handlebars', 'pedals', 'helmetProvided',
]);
const items = emptyCheckItems();
assert.equal(overallResult(items), 'pass');
assert.equal(overallResult({ ...items, pedals: 'na' }), 'pass', 'N/A does not fail the check');
assert.equal(overallResult({ ...items, brakesFront: 'fail' }), 'fail');

// Money: pounds as typed to pence; blank is none.
assert.equal(poundsToPence(''), null);
assert.equal(poundsToPence('20'), 2000);
assert.equal(poundsToPence(' 19.99 '), 1999);
assert.equal(poundsToPence('0.5'), 50);
for (const bad of ['-5', '20.001', '£20', 'twenty', '1e3']) assert.equal(poundsToPence(bad), 'invalid', bad);

// Hire: the website's body plus the chosen site; the pre-ride check is dated
// the hire date and carries the worked-out overall result.
const bike = { id: 4, siteId: 3, ref: 'BIKE-01', name: 'Blue', type: 'hybrid', status: 'available', active: true };
const hireDraft = {
  guestName: ' Alex Guest ', guestContact: '', hireDate: '2026-10-15', returnExpected: '2026-10-16', deposit: '20.00',
  check: { skip: false, items: { ...items, tyreRear: 'fail' }, performedBy: 'Porter', checkNotes: ' Soft tyre ' },
};
assert.deepEqual(buildHirePayload(hireDraft, bike, 3), {
  ok: true,
  payload: {
    bikeId: 4, guestName: 'Alex Guest', guestContact: null, hireDate: '2026-10-15', returnDateExpected: '2026-10-16',
    depositPence: 2000, siteId: 3,
    preHireCheck: {
      ...items, tyreRear: 'fail', performedBy: 'Porter', staffRosterId: null, checkDate: '2026-10-15',
      overallResult: 'fail', checkNotes: 'Soft tyre',
    },
  },
});
const skipped = buildHirePayload({ ...hireDraft, deposit: '', returnExpected: '', check: { ...hireDraft.check, skip: true } }, bike, null);
assert.equal(skipped.ok, true);
assert.equal('preHireCheck' in skipped.payload, false, 'a skipped check sends no check, as on the website');
assert.equal(skipped.payload.depositPence, null);
assert.equal(skipped.payload.returnDateExpected, null);
assert.equal(skipped.payload.siteId, null, 'an account without sites hires against no site');
assert.equal(buildHirePayload({ ...hireDraft, guestName: '  ' }, bike, 3).ok, false, 'guest name is required');
assert.equal(buildHirePayload({ ...hireDraft, hireDate: '2026-02-30' }, bike, 3).ok, false);
assert.equal(buildHirePayload({ ...hireDraft, returnExpected: 'tomorrow' }, bike, 3).ok, false);
assert.equal(buildHirePayload({ ...hireDraft, deposit: 'abc' }, bike, 3).ok, false);
for (const status of ['hired', 'maintenance', 'retired']) {
  assert.equal(buildHirePayload(hireDraft, { ...bike, status }, 3).ok, false, `a ${status} bike cannot be hired`);
}
assert.equal(buildHirePayload(hireDraft, { ...bike, active: false }, 3).ok, false);
assert.equal(buildHirePayload(hireDraft, undefined, 3).ok, false);

// Return (online-only): the website's body; deposit flag and post-return check.
const returnDraft = { returnDate: '2026-10-16', depositReturned: true, notes: '', check: { ...hireDraft.check, items } };
assert.deepEqual(buildReturnPayload(returnDraft), {
  ok: true,
  payload: {
    returnDateActual: '2026-10-16', depositReturned: true, notes: null,
    postReturnCheck: {
      ...items, performedBy: 'Porter', staffRosterId: null, checkDate: '2026-10-16', overallResult: 'pass', checkNotes: 'Soft tyre',
    },
  },
});
assert.equal('postReturnCheck' in buildReturnPayload({ ...returnDraft, check: { ...returnDraft.check, skip: true } }).payload, false);
assert.equal(buildReturnPayload({ ...returnDraft, returnDate: '16/10/2026' }).ok, false);

// Service: the website's body; next service follows annual / interim.
assert.equal(autoNextService('2026-10-15', 'annual'), '2027-10-15');
assert.equal(autoNextService('2026-10-15', 'interim'), '2027-04-15');
assert.equal(autoNextService('2026-10-15', 'adhoc'), '');
assert.equal(autoNextService('bad', 'annual'), '');
const serviceDraft = {
  bikeId: 4, serviceDate: '2026-10-15', serviceType: 'annual', nextServiceDate: '2027-10-15', cost: '45', servicedBy: ' Cycle Co ', notes: '',
};
assert.deepEqual(buildServicePayload(serviceDraft), {
  ok: true,
  payload: {
    serviceDate: '2026-10-15', serviceType: 'annual', servicedBy: 'Cycle Co', nextServiceDate: '2027-10-15',
    costPence: 4500, notes: null, bikeId: 4,
  },
});
assert.equal(buildServicePayload({ ...serviceDraft, bikeId: null }).ok, false, 'a bike must be chosen');
assert.equal(buildServicePayload({ ...serviceDraft, serviceType: 'major' }).ok, false);
assert.equal(buildServicePayload({ ...serviceDraft, nextServiceDate: 'soon' }).ok, false);
assert.equal(buildServicePayload({ ...serviceDraft, nextServiceDate: '' }).payload.nextServiceDate, null);
assert.equal(buildServicePayload({ ...serviceDraft, cost: '4,50' }).ok, false);

// Account defaults prefill the hire, as on the website.
assert.equal(defaultDepositText({ bike_default_deposit_pence: '2000' }), '20.00');
assert.equal(defaultDepositText({ bike_default_deposit_pence: '' }), '');
assert.equal(defaultDepositText(undefined), '');
assert.equal(defaultExpectedReturn({ bike_hire_duration_hours: '4' }, new Date(2026, 9, 15, 10)), '2026-10-15');
assert.equal(defaultExpectedReturn({ bike_hire_duration_hours: '4' }, new Date(2026, 9, 15, 22)), '2026-10-16');
assert.equal(defaultExpectedReturn({ bike_hire_duration_hours: '' }), '');

// Sites: one must be chosen when the account has sites.
const sites = [{ id: 3, name: 'Main' }, { id: 5, name: 'Lodge' }];
assert.deepEqual(bikeSiteChoice(null, undefined), { ready: false });
assert.deepEqual(bikeSiteChoice(null, []), { ready: true, siteId: null });
assert.deepEqual(bikeSiteChoice(null, sites), { ready: false });
assert.deepEqual(bikeSiteChoice(9, sites), { ready: false }, "a site outside the account's list is never used");
assert.deepEqual(bikeSiteChoice(5, sites), { ready: true, siteId: 5 });

// Fleet: active bikes at the site plus bikes without a site.
const bikes = [
  bike,
  { ...bike, id: 5, siteId: 5, ref: 'BIKE-02' },
  { ...bike, id: 6, siteId: null, ref: 'BIKE-03' },
  { ...bike, id: 7, siteId: 3, ref: 'BIKE-04', active: false },
];
assert.deepEqual(bikesForSite(bikes, 3).map((row) => row.id), [4, 6]);
assert.deepEqual(bikesForSite(bikes, null).map((row) => row.id), [4, 5, 6]);

// Hires: active ones at the site (the hire's site, else its bike's site).
const hires = [
  { id: 1, bike_id: 4, site_id: null, status: 'active', return_date_expected: '2026-10-14T00:00:00.000Z' },
  { id: 2, bike_id: 5, site_id: null, status: 'active', return_date_expected: null },
  { id: 3, bike_id: 6, site_id: 3, status: 'active', return_date_expected: '2026-10-15' },
  { id: 4, bike_id: 6, site_id: 5, status: 'active', return_date_expected: null },
  { id: 5, bike_id: 4, site_id: 3, status: 'returned', return_date_expected: null },
];
assert.deepEqual(activeHiresForSite(hires, bikes, 3).map((row) => row.id), [1, 3]);
assert.deepEqual(activeHiresForSite(hires, bikes, null).map((row) => row.id), [1, 2, 3, 4]);
assert.equal(isOverdueReturn(hires[0], '2026-10-15'), true, 'raw dates with a time still compare by day');
assert.equal(isOverdueReturn(hires[2], '2026-10-15'), false, 'due today is not overdue');
assert.equal(isOverdueReturn(hires[1], '2026-10-15'), false);

// Service due from the latest service.
assert.deepEqual(serviceDue({ bike_id: 4, service_date: '2025-10-01', next_service_date: '2026-10-01T00:00:00.000Z' }, '2026-10-15'),
  { date: '2026-10-01', overdue: true });
assert.deepEqual(serviceDue({ bike_id: 4, service_date: '2026-10-01', next_service_date: '2027-10-01' }, '2026-10-15'),
  { date: '2027-10-01', overdue: false });
assert.equal(serviceDue(undefined, '2026-10-15'), null);

// A hire waiting in the outbox marks its bike so it is not hired twice.
const pending = pendingHireBikeIds([
  { kind: 'bike-hire', state: 'queued', body: { bikeId: 4 } },
  { kind: 'bike-hire', state: 'sent', body: { bikeId: 5 } },
  { kind: 'bike-service', state: 'queued', body: { bikeId: 6 } },
  { kind: 'bike-hire', state: 'failed', body: { bikeId: 7 } },
]);
assert.deepEqual([...pending].sort(), [4, 7]);

// Returns are online-only: a request that never reached the server is told
// apart from a refusal.
assert.equal(isConnectionFailure(new TypeError('Network request failed')), true);
assert.equal(isConnectionFailure(Object.assign(new Error('Hire already returned'), { status: 409 })), false);

// List responses: GET /hires, /services and /services/latest have returned
// raw snake_case rows and camelCase rows; both read into the same shape.
const expectedHire = {
  id: 11, bike_id: 4, site_id: 3, guest_name: 'Alex Guest', guest_contact: '07700 900000',
  hire_date: '2026-10-14T00:00:00.000Z', return_date_expected: '2026-10-14', deposit_pence: 2000,
  status: 'active', bike_ref: 'BIKE-01', bike_name: 'Blue', pre_result: 'pass',
};
const snakeHire = {
  id: 11, client_id: 1, site_id: 3, bike_id: 4, guest_name: 'Alex Guest', guest_contact: '07700 900000',
  hire_date: '2026-10-14T00:00:00.000Z', return_date_expected: '2026-10-14', return_date_actual: null,
  deposit_pence: 2000, deposit_returned: false, status: 'active', notes: null,
  bike_ref: 'BIKE-01', bike_name: 'Blue', bike_type: 'hybrid', pre_check_id: 8, pre_result: 'pass',
  post_check_id: null, post_result: null,
};
const camelHire = {
  id: 11, clientId: 1, siteId: 3, bikeId: 4, guestName: 'Alex Guest', guestContact: '07700 900000',
  hireDate: '2026-10-14T00:00:00.000Z', returnDateExpected: '2026-10-14', returnDateActual: null,
  depositPence: 2000, depositReturned: false, status: 'active', notes: null,
  bikeRef: 'BIKE-01', bikeName: 'Blue', bikeType: 'hybrid', preCheckId: 8, preResult: 'pass',
  postCheckId: null, postResult: null,
};
assert.deepEqual(normalizeBikeHires([snakeHire]), [expectedHire], 'snake_case hires');
assert.deepEqual(normalizeBikeHires([camelHire]), [expectedHire], 'camelCase hires');
const camelHires = normalizeBikeHires([camelHire, { ...camelHire, id: 12, siteId: null, bikeId: 5, returnDateExpected: null, guestContact: null }]);
assert.deepEqual(activeHiresForSite(camelHires, bikes, 3).map((row) => row.id), [11], 'camelCase hires keep their site');
assert.equal(isOverdueReturn(camelHires[0], '2026-10-15'), true, 'camelCase expected return still marks overdue');
assert.equal(camelHires[1].guest_contact, null);
assert.deepEqual(normalizeBikeHires({ error: 'nope' }), []);
assert.deepEqual(normalizeBikeHires([null, { guestName: 'No id' }]), []);

const expectedService = {
  id: 21, bike_id: 4, service_date: '2026-10-01', service_type: 'annual', serviced_by: 'Cycle Co',
  next_service_date: '2027-10-01', cost_pence: 4500, notes: 'New chain', bike_ref: 'BIKE-01', bike_name: 'Blue',
};
assert.deepEqual(normalizeBikeServices([{
  id: 21, client_id: 1, bike_id: 4, service_date: '2026-10-01', service_type: 'annual', serviced_by: 'Cycle Co',
  next_service_date: '2027-10-01', cost_pence: 4500, notes: 'New chain', created_by: 2,
  bike_ref: 'BIKE-01', bike_name: 'Blue', bike_type: 'hybrid',
}]), [expectedService], 'snake_case services');
assert.deepEqual(normalizeBikeServices([{
  id: 21, clientId: 1, bikeId: 4, serviceDate: '2026-10-01', serviceType: 'annual', servicedBy: 'Cycle Co',
  nextServiceDate: '2027-10-01', costPence: 4500, notes: 'New chain', createdBy: 2,
  bikeRef: 'BIKE-01', bikeName: 'Blue', bikeType: 'hybrid',
}]), [expectedService], 'camelCase services');
assert.deepEqual(normalizeBikeServices([{ id: 22, bikeId: 4, serviceDate: '2026-10-01', serviceType: 'adhoc', nextServiceDate: null, costPence: null, bikeRef: 'BIKE-01' }])[0],
  { id: 22, bike_id: 4, service_date: '2026-10-01', service_type: 'adhoc', serviced_by: null, next_service_date: null, cost_pence: null, notes: null, bike_ref: 'BIKE-01', bike_name: null });

const [snakeLatest] = normalizeLatestServices([{ bike_id: 4, service_date: '2025-10-01', service_type: 'annual', serviced_by: null, next_service_date: '2026-10-01T00:00:00.000Z' }]);
const [camelLatest] = normalizeLatestServices([{ bikeId: 4, serviceDate: '2025-10-01', serviceType: 'annual', servicedBy: null, nextServiceDate: '2026-10-01T00:00:00.000Z' }]);
const expectedLatest = { bike_id: 4, service_date: '2025-10-01', next_service_date: '2026-10-01T00:00:00.000Z' };
assert.deepEqual(snakeLatest, expectedLatest, 'snake_case latest services');
assert.deepEqual(camelLatest, expectedLatest, 'camelCase latest services');
assert.deepEqual(serviceDue(camelLatest, '2026-10-15'), { date: '2026-10-01', overdue: true }, 'camelCase rows still show service due');
assert.deepEqual(normalizeLatestServices([{ serviceDate: '2025-10-01' }]), [], 'a row without a bike is dropped');

console.log('BikeTrack logic tests passed: website payloads, money and date checks, defaults, site choice, fleet and hires, service due, pending hires, connection failures, snake/camel list rows.');
