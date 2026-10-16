import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// TrainTrack on the phone (components/train-track-logic.ts): certificate
// status follows the website (30-day "Expiring Soon"), "missing" training is
// the website matrix's (a certificate type held by someone in the site scope),
// records attach by roster id and only uniquely-named legacy records attach by
// name, the list filters by site, department, course, status and search,
// staff are linked by email as DocTrack does, and API rows parse in snake or
// camel case. The screens are read-only and wired into the Manage hub.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../components/train-track-logic.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const logic = await import(`data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`);
const {
  certificateStatus, signoffStatus, expiryCountdown, daysUntil, buildPeople, trainingOverview, personByKey,
  findMyRosterMember, seesOwnTrainingOnly, toTrainRecord, toRosterMember, photoObjectPath, photoUrl,
  EMPTY_FILTERS, statusFor, recordTitle, recordDetail,
} = logic;

const today = new Date(2026, 9, 15, 14, 30);

// Status rule (website training-matrix certificateStatus + TrainTrack badges).
assert.equal(certificateStatus(null, today), 'no_expiry');
assert.equal(certificateStatus('2026-10-14', today), 'expired');
assert.equal(certificateStatus('2026-10-15', today), 'expiring_soon');
assert.equal(certificateStatus('2026-11-14', today), 'expiring_soon', 'day 30 is expiring soon');
assert.equal(certificateStatus('2026-11-15', today), 'valid');
assert.equal(certificateStatus('2026-11-15T00:00:00.000Z', today), 'valid', 'timestamps read as dates');
assert.equal(signoffStatus('2026-01-01', today), 'expired');
assert.equal(signoffStatus(null, today), 'acknowledged');
assert.equal(expiryCountdown('2026-10-12', today), '3d ago');
assert.equal(expiryCountdown('2026-10-15', today), 'Today');
assert.equal(expiryCountdown('2026-10-20', today), '5d');
assert.equal(daysUntil('2027-03-28', new Date(2027, 2, 27, 23, 0)), 1, 'calendar days across a DST change');

const rec = (id, patch) => ({
  id, site_id: 1, site_name: 'Kitchen', record_type: 'certificate', staff_name: 'x', staff_roster_id: null,
  training_type: 'Food Hygiene (Level 2)', document_title: null, document_type: null, provider: 'Highfield',
  trainer: null, completed_date: '2025-01-01', expiry_date: '2028-01-01', notes: null, ...patch,
});
const member = (id, name, patch = {}) => ({
  id, name, site_id: 1, site_name: 'Kitchen', department: 'Kitchen', job_title: 'Chef', email: null, active: true, ...patch,
});

const roster = [
  member(1, 'Ann Smith', { email: ' Ann@Example.com ' }),
  member(2, 'Bob Jones', { department: 'Front of house', job_title: 'Waiter' }),
  member(3, 'Cara Lee', { site_id: 2, site_name: 'Bar', department: 'Bar' }),
  member(4, 'Sam Patel'),
  member(5, 'Sam Patel', { site_id: 2, site_name: 'Bar', department: 'Bar' }),
];
const records = [
  rec(10, { staff_roster_id: 1, training_type: 'Food Hygiene (Level 2)', expiry_date: '2026-10-01' }), // expired, older
  rec(11, { staff_roster_id: 1, training_type: 'Food Hygiene (Level 2)', completed_date: '2026-09-01', expiry_date: '2029-09-01' }), // newer, valid
  rec(12, { staff_roster_id: 1, training_type: 'First Aid at Work', expiry_date: '2026-10-30' }), // expiring
  rec(13, { staff_name: ' bob  JONES ', training_type: 'Food Hygiene (Level 2)', expiry_date: '2026-09-01' }), // legacy, unique name -> Bob, expired
  rec(14, { staff_name: 'Sam Patel', training_type: 'Manual Handling', expiry_date: null }), // ambiguous across all sites
  rec(15, { staff_name: 'Dee Former', training_type: 'Manual Handling', expiry_date: '2026-01-01' }), // not on roster
  rec(16, { staff_roster_id: 99, training_type: 'Manual Handling' }), // inactive / unknown roster id -> left out
  rec(17, { staff_roster_id: 3, site_id: 2, site_name: 'Bar', training_type: 'Licensing', expiry_date: null }),
  rec(18, { staff_roster_id: 1, record_type: 'signoff', training_type: null, document_title: 'Fire policy', document_type: 'policy', completed_date: '2026-05-01', expiry_date: '2027-05-01' }),
  rec(19, { staff_roster_id: 2, record_type: 'internal', training_type: 'Slicer demo', provider: null, trainer: 'Head chef' }),
];

// All sites: Sam Patel is ambiguous so record 14 stays "Not linked".
let { people, courses } = buildPeople(records, roster, null, today);
assert.deepEqual(courses, ['Food Hygiene (Level 2)', 'First Aid at Work', 'Licensing', 'Manual Handling'].sort((a, b) => a.localeCompare(b)));
const byKey = Object.fromEntries(people.map((person) => [person.key, person]));
assert.equal(byKey['r:1'].courses.find((c) => c.course === 'Food Hygiene (Level 2)').state, 'valid', 'latest certificate wins');
assert.equal(byKey['r:1'].courses.find((c) => c.course === 'First Aid at Work').state, 'expiring_soon');
assert.equal(byKey['r:1'].status, 'missing', 'Ann lacks Licensing and Manual Handling held by others');
assert.equal(byKey['r:2'].status, 'expired', 'legacy record attached to Bob by unique name');
assert.ok(byKey['r:2'].records.some((r) => r.id === 13));
assert.ok(byKey['n:sam patel'], 'ambiguous legacy name is kept as a Not linked person');
assert.equal(byKey['n:sam patel'].unlinked, true);
assert.equal(byKey['n:dee former'].status, 'expired', 'unlinked people are never "missing"');
assert.ok(!people.some((person) => person.records.some((r) => r.id === 16)), 'records of inactive roster ids are left out');
assert.equal(byKey['r:4'].label, 'Sam Patel (Kitchen, roster #4)', 'same-name staff are disambiguated');
assert.equal(byKey['r:1'].records[0].record_type, 'certificate', 'certificates first');
assert.equal(byKey['r:1'].records.at(-1).record_type, 'signoff');

// Site scope: in Kitchen only one Sam Patel, so record 14 attaches to roster #4.
({ people, courses } = buildPeople(records, roster, 1, today));
assert.ok(!courses.includes('Licensing'), 'courses come from certificates in the selected site');
assert.ok(people.find((person) => person.key === 'r:4').records.some((r) => r.id === 14));
assert.ok(!people.some((person) => person.key === 'r:3'), 'staff of other sites are out of scope');

// Overview filters and counts.
let overview = trainingOverview(records, roster, EMPTY_FILTERS, today);
assert.equal(overview.total, overview.people.length);
assert.deepEqual(overview.departments, ['Bar', 'Front of house', 'Kitchen']);
assert.equal(overview.people[0].status, 'expired', 'worst first');
assert.equal(Object.values(overview.counts).reduce((a, b) => a + b, 0), overview.total);
overview = trainingOverview(records, roster, { ...EMPTY_FILTERS, department: 'Front of house' }, today);
assert.deepEqual(overview.people.map((p) => p.key), ['r:2']);
overview = trainingOverview(records, roster, { ...EMPTY_FILTERS, siteId: 1, course: 'First Aid at Work' }, today);
assert.equal(statusFor(overview.people.find((p) => p.key === 'r:1'), 'First Aid at Work'), 'expiring_soon');
assert.equal(statusFor(overview.people.find((p) => p.key === 'r:2'), 'First Aid at Work'), 'missing');
overview = trainingOverview(records, roster, { ...EMPTY_FILTERS, siteId: 1, course: 'First Aid at Work', status: 'missing' }, today);
assert.ok(overview.people.every((p) => statusFor(p, 'First Aid at Work') === 'missing'));
assert.ok(overview.counts.expiring_soon >= 1, 'counts ignore the status filter');
overview = trainingOverview(records, roster, { ...EMPTY_FILTERS, search: 'head chef' }, today);
assert.deepEqual(overview.people.map((p) => p.key), ['r:2'], 'search covers trainer and provider');
overview = trainingOverview(records, roster, { ...EMPTY_FILTERS, course: 'Not a course' }, today);
assert.equal(overview.total, trainingOverview(records, roster, EMPTY_FILTERS, today).total, 'unknown course is ignored');

// Person screen and staff linking.
assert.equal(personByKey(records, roster, 'r:1', today).records.length, 4);
assert.equal(personByKey(records, roster, 'r:404', today), null);
assert.deepEqual(findMyRosterMember(roster, 'ann@example.COM').state, 'linked');
assert.equal(findMyRosterMember(roster, 'ann@example.com').member.id, 1);
assert.equal(findMyRosterMember(roster, '').state, 'none');
assert.equal(findMyRosterMember([...roster, member(6, 'Ann Two', { email: 'ann@example.com' })], 'ann@example.com').state, 'ambiguous');
assert.equal(findMyRosterMember([member(7, 'Gone', { email: 'g@x.com', active: false })], 'g@x.com').state, 'none');
assert.equal(seesOwnTrainingOnly('client_staff'), true);
for (const role of ['client_admin', 'consultant', 'client_viewer']) assert.equal(seesOwnTrainingOnly(role), false);
assert.equal(recordTitle(records[8]), 'Fire policy');
assert.equal(recordDetail(records[8]), 'Policy');
assert.equal(recordDetail(records[9]), 'Delivered by: Head chef');

// API rows in either case (PR #95 moves some responses to camelCase).
const snake = {
  id: 5, site_id: 2, site_name: 'Bar', record_type: 'certificate', staff_name: 'Ann', staff_roster_id: 1,
  training_type: 'First Aid at Work', document_title: null, document_type: null, provider: 'SJA', trainer: null,
  completed_date: '2026-01-02T00:00:00.000Z', expiry_date: '2029-01-02', notes: 'n',
};
const camel = {
  id: 5, siteId: 2, siteName: 'Bar', recordType: 'certificate', staffName: 'Ann', staffRosterId: 1,
  trainingType: 'First Aid at Work', documentTitle: null, documentType: null, provider: 'SJA', trainer: null,
  completedDate: '2026-01-02', expiryDate: '2029-01-02T00:00:00.000Z', notes: 'n',
};
assert.deepEqual(toTrainRecord(snake), toTrainRecord(camel));
assert.equal(toTrainRecord(snake).completed_date, '2026-01-02');
const rosterSnake = { id: 1, name: 'Ann', site_id: 2, site_name: 'Bar', department: 'Bar', job_title: 'Chef', email: 'a@x.com', active: true };
const rosterCamel = { id: 1, name: 'Ann', siteId: 2, siteName: 'Bar', department: 'Bar', jobTitle: 'Chef', email: 'a@x.com', active: true };
assert.deepEqual(toRosterMember(rosterSnake), toRosterMember(rosterCamel));
assert.equal(photoObjectPath({ object_path: '/objects/a' }), '/objects/a');
assert.equal(photoObjectPath({ objectPath: '/objects/a' }), '/objects/a');
assert.equal(photoUrl('https://api.example.com', '/objects/a'), 'https://api.example.com/api/storage/objects/a');

// Screens: read-only, gated, registered and in the hub.
const list = await readFile(new URL('../app/manage/training.tsx', import.meta.url), 'utf8');
const person = await readFile(new URL('../app/manage/training-person.tsx', import.meta.url), 'utf8');
const ui = await readFile(new URL('../components/train-track-ui.tsx', import.meta.url), 'utf8');
for (const source of [list, person, ui]) {
  assert.ok(!/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(source), 'TrainTrack on the phone never writes');
}
assert.ok(list.includes("hasService('traintrack')") && person.includes("hasService('traintrack')"));
assert.ok(ui.includes("'/api/train-track/records'") && ui.includes("'/api/staff-roster'"));
assert.ok(list.includes('/manage/training-person?key=me'), 'staff go to their own records');
const items = await readFile(new URL('../components/manage-items.ts', import.meta.url), 'utf8');
assert.ok(/route: '\/manage\/training',\n\s+audience: 'everyone',\n\s+service: 'traintrack'/.test(items));
const layout = await readFile(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
for (const name of ['manage/training', 'manage/training-person']) {
  assert.ok(new RegExp(`name="${name}"\\n\\s+options=\\{\\{\\n[^}]*headerShown: false`).test(layout), `${name} registered`);
}

console.log('train-track logic: ok');
