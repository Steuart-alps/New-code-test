import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Calendar on the phone (components/calendar-agenda-logic.ts): the website's
// GET /api/calendar entries as an agenda (Overdue, Today, This week, Later),
// requests within the API's 93-day limit, and links to phone screens.
const source = await readFile(new URL('../components/calendar-agenda-logic.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  addDays, agendaWindows, calendarPath, mergeCalendarEntries, endOfWeek, buildAgenda, agendaDayLabel,
  phoneRouteForCalendarHref, groupOf, entryAccessibilityLabel, localIsoDate, MAX_RANGE_DAYS, normalizeCalendarResponse,
} = await import(`data:text/javascript,${encodeURIComponent(js)}`);

assert.equal(localIsoDate(new Date(2026, 9, 5, 23, 59)), '2026-10-05');
assert.equal(addDays('2026-12-31', 1), '2027-01-01');
assert.equal(addDays('2026-03-01', -1), '2026-02-28');
assert.throws(() => addDays('2026-02-30', 1));

// Windows: each within the API's limit (both ends included), together
// covering the last and next three months.
const inclusive = (w) => (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 + 1;
const windows = agendaWindows('2026-10-15');
assert.deepEqual(windows, [{ from: '2026-07-15', to: '2026-10-15' }, { from: '2026-10-15', to: '2027-01-15' }]);
for (const w of windows) assert.equal(inclusive(w), MAX_RANGE_DAYS);
assert.equal(calendarPath(windows[0], null), '/api/calendar?from=2026-07-15&to=2026-10-15');
assert.equal(calendarPath(windows[1], 4), '/api/calendar?from=2026-10-15&to=2027-01-15&siteId=4');

// Weeks run Monday to Sunday like the website.
assert.equal(endOfWeek('2026-10-15'), '2026-10-18'); // Thursday -> Sunday
assert.equal(endOfWeek('2026-10-12'), '2026-10-18'); // Monday
assert.equal(endOfWeek('2026-10-18'), '2026-10-18'); // Sunday itself

const entry = (id, date, status, extra = {}) => ({
  id, date, status, kind: 'compliance_due', title: id, detail: null, siteName: null, href: '/items/1', ...extra,
});
// Today appears in both windows: merged once.
const merged = mergeCalendarEntries([
  { entries: [entry('old-done', '2026-08-01', 'done'), entry('late', '2026-09-30', 'overdue'), entry('now', '2026-10-15', 'due')] },
  { entries: [entry('now', '2026-10-15', 'due'), entry('sun', '2026-10-18', 'due'), entry('mon', '2026-10-19', 'due'),
    entry('fri-done', '2026-10-16', 'done'), entry('later', '2026-12-01', 'due')] },
]);
assert.deepEqual(merged.map((e) => e.id), ['old-done', 'late', 'now', 'fri-done', 'sun', 'mon', 'later']);

const agenda = buildAgenda(merged, '2026-10-15');
assert.deepEqual(agenda.map((s) => [s.title, s.entries.map((e) => e.id)]), [
  ['Overdue', ['late']],
  ['Today', ['now']],
  ['This week', ['fri-done', 'sun']],
  ['Later', ['mon', 'later']],
]);

assert.equal(agendaDayLabel('2026-10-15'), 'Thu 15 Oct');
assert.equal(agendaDayLabel('nonsense'), 'nonsense');

// Links: phone screens where they exist; none for records only the website has.
assert.equal(phoneRouteForCalendarHref('/contractors/42'), '/manage/contractor/42');
assert.equal(phoneRouteForCalendarHref('/fix-track/7'), '/issues/7');
assert.equal(phoneRouteForCalendarHref('/pest-track'), '/checks/pest');
assert.equal(phoneRouteForCalendarHref('/train-track'), '/(tabs)/docs?tab=training');
for (const href of ['/items/3', '/coshh', '/asbestos', '/contractors/abc', '/fix-track/1/edit', '']) {
  assert.equal(phoneRouteForCalendarHref(href), null, href);
}

// The response is read in either field style; malformed rows are dropped.
const camel = normalizeCalendarResponse({
  from: '2026-10-15', to: '2027-01-15', today: '2026-10-15', siteId: 4, truncated: true,
  entries: [
    { id: 'pest-1', date: '2026-10-20', kind: 'pest_visit', title: 'Pest control visit due', detail: null, siteName: 'Hotel', href: '/pest-track', status: 'due' },
    { id: 'bad', date: '20/10/2026', kind: 'pest_visit', title: 'x', href: '/', status: 'due' },
  ],
});
const snake = normalizeCalendarResponse({
  from: '2026-10-15', to: '2027-01-15', today: '2026-10-15', site_id: 4, truncated: true,
  entries: [{ id: 'pest-1', date: '2026-10-20', kind: 'pest_visit', title: 'Pest control visit due', detail: null, site_name: 'Hotel', href: '/pest-track', status: 'due' }],
});
assert.deepEqual(camel, snake);
assert.equal(camel.entries.length, 1);
assert.equal(camel.entries[0].siteName, 'Hotel');
assert.deepEqual(normalizeCalendarResponse(null).entries, []);
assert.equal(normalizeCalendarResponse({ entries: [{ id: 1, date: '2026-10-20', status: 'weird' }] }).entries[0].status, 'due');

assert.equal(groupOf('training_expiry'), 'training');
assert.equal(groupOf('pest_visit'), 'visits');
assert.equal(groupOf('unknown_kind'), 'checks');
assert.equal(entryAccessibilityLabel(entry('Fire alarm test', '2026-10-01', 'overdue', { siteName: 'Hotel' })),
  'Overdue: Fire alarm test, Hotel, Thu 1 Oct');

console.log('calendar agenda logic: ok');
