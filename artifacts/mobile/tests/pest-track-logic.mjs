import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// PestTrack on the phone (components/pest-track-logic.ts): the payloads match
// the website's forms (pages/pest-track.tsx) field for field, dates are
// checked before anything is saved on the device, and the site rules.
const source = await readFile(new URL('../components/pest-track-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  buildPestActivityPayload, buildPestVisitPayload, isCalendarDate, nextPestVisit,
  pestOptions, pestRecordsForSite, pestSiteChoice, pestTypeLabel, evidenceLabel,
  DEFAULT_PEST_TYPES, DEFAULT_PEST_EVIDENCE_TYPES,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

// Dates: real calendar days only (the API stores them in date columns, and a
// bad one would fail there after being saved on the device).
assert.equal(isCalendarDate('2026-10-15'), true);
assert.equal(isCalendarDate('2028-02-29'), true);
for (const bad of ['2026-02-29', '2026-13-01', '15/10/2026', '2026-10-15T00:00', '']) assert.equal(isCalendarDate(bad), false, bad);

// Activity: the website's fields; blank text becomes null like the website.
const activity = {
  recordedDate: '2026-10-15', pestType: 'rodent', evidenceType: 'droppings', location: ' Bin store ',
  severity: 'high', actionTaken: '', recordedBy: 'Porter', resolved: false, notes: '  ',
};
assert.deepEqual(buildPestActivityPayload(activity, 7), {
  ok: true,
  payload: {
    recordedDate: '2026-10-15', pestType: 'rodent', evidenceType: 'droppings', location: 'Bin store',
    severity: 'high', actionTaken: null, recordedBy: 'Porter', resolved: false, notes: null, siteId: 7,
  },
});
assert.equal(buildPestActivityPayload({ ...activity, recordedDate: '2026-02-30' }, 7).ok, false);
assert.equal(buildPestActivityPayload({ ...activity, severity: 'critical' }, 7).ok, false);
assert.equal(buildPestActivityPayload({ ...activity, resolved: true }, null).payload.resolved, true);
assert.equal(buildPestActivityPayload(activity, null).payload.siteId, null, 'an account without sites records against all sites');

// Visit: the website's fields; next visit optional but must be a real date.
const visit = {
  visitDate: '2026-10-15', nextVisitDate: '', contractorName: 'J Smith', contractorCompany: 'ABC Pest Control',
  areasInspected: 'Kitchen', findings: 'No activity', treatmentsApplied: '', recommendations: '',
  signedOffBy: 'Manager', notes: '',
};
assert.deepEqual(buildPestVisitPayload(visit, 3), {
  ok: true,
  payload: {
    visitDate: '2026-10-15', contractorName: 'J Smith', contractorCompany: 'ABC Pest Control',
    areasInspected: 'Kitchen', findings: 'No activity', treatmentsApplied: null, recommendations: null,
    nextVisitDate: null, signedOffBy: 'Manager', notes: null, siteId: 3,
  },
});
assert.equal(buildPestVisitPayload({ ...visit, nextVisitDate: '2027-01-15' }, 3).payload.nextVisitDate, '2027-01-15');
assert.equal(buildPestVisitPayload({ ...visit, nextVisitDate: 'next month' }, 3).ok, false);
assert.equal(buildPestVisitPayload({ ...visit, visitDate: '' }, 3).ok, false);

// Options: the account's lists once loaded, the server defaults until then.
assert.deepEqual(pestOptions(undefined, DEFAULT_PEST_TYPES), ['rodent', 'insect', 'bird', 'other']);
assert.deepEqual(pestOptions(['rodent', 'cockroach'], DEFAULT_PEST_TYPES), ['rodent', 'cockroach']);
assert.deepEqual(pestOptions([], DEFAULT_PEST_EVIDENCE_TYPES), [...DEFAULT_PEST_EVIDENCE_TYPES]);
assert.equal(pestTypeLabel('rodent'), 'Rodent');
assert.equal(pestTypeLabel('cockroach'), 'cockroach', 'custom values show as entered');
assert.equal(evidenceLabel('nest'), 'Nest / harbourage');

// Sites: one must be chosen when the account has sites.
const sites = [{ id: 3, name: 'Main' }, { id: 4, name: 'Annex' }];
assert.deepEqual(pestSiteChoice(null, undefined), { ready: false }, 'not before the sites load');
assert.deepEqual(pestSiteChoice(null, []), { ready: true, siteId: null });
assert.deepEqual(pestSiteChoice(null, sites), { ready: false });
assert.deepEqual(pestSiteChoice(9, sites), { ready: false }, 'a site from another account is never used');
assert.deepEqual(pestSiteChoice(4, sites), { ready: true, siteId: 4 });

// Recent records: the chosen site plus records logged against all sites.
const rows = [{ id: 1, site_id: 3 }, { id: 2, site_id: 4 }, { id: 3, site_id: null }];
assert.deepEqual(pestRecordsForSite(rows, 3).map((row) => row.id), [1, 3]);
assert.deepEqual(pestRecordsForSite(rows, null).map((row) => row.id), [1, 2, 3]);

// Next visit: as recorded on the most recent visit (the website's status card).
const visits = [
  { visit_date: '2026-07-01', next_visit_date: '2026-10-01' },
  { visit_date: '2026-10-01', next_visit_date: '2027-01-01' },
];
assert.deepEqual(nextPestVisit(visits, '2026-10-15'), { date: '2027-01-01', overdue: false });
assert.deepEqual(nextPestVisit(visits.slice(0, 1), '2026-10-15'), { date: '2026-10-01', overdue: true });
assert.equal(nextPestVisit([{ visit_date: '2026-10-01', next_visit_date: null }], '2026-10-15'), null);
assert.equal(nextPestVisit([], '2026-10-15'), null);

console.log('PestTrack logic tests passed: website payloads, date checks, option fallback, site choice, recent records, next visit.');
