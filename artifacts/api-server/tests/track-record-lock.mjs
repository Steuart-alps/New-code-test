import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../src/middleware/dailyEntryCutoff.ts', import.meta.url),
  'utf8',
);
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { getDailyEntryCutoffDecision, TRACK_WRITE_PREFIXES } = await import(
  `data:text/javascript,${encodeURIComponent(javascript)}`
);

const staff = { role: 'client_staff' };
const clientAdmin = { role: 'client_admin' };
const consultant = { role: 'consultant' };
// Intentionally fixed dates: every decision below passes an explicit clock
// (this `now` or its own), so the lock boundaries never depend on today's date.
const now = new Date('2026-09-23T12:00:00.000Z');
const request = (body, overrides = {}) => ({
  method: 'PUT',
  path: '/food-safety/42',
  body,
  ...overrides,
});

assert.equal(
  getDailyEntryCutoffDecision(request({ recordDate: '2026-09-23' }), staff, now).blocked,
  false,
  'current-day records remain editable',
);
assert.equal(
  getDailyEntryCutoffDecision(request({ recordDate: '2026-09-22' }), staff, now).blocked,
  false,
  'the following calendar day is the 24-hour correction window',
);
assert.deepEqual(
  getDailyEntryCutoffDecision(request({ recordDate: '2026-09-21' }), staff, now),
  { blocked: true, today: '2026-09-23', reason: 'record_lock' },
  'records lock after the correction window',
);
for (const prefix of TRACK_WRITE_PREFIXES) {
  assert.equal(
    getDailyEntryCutoffDecision(
      request({ recordDate: '2026-09-21' }, { path: `${prefix}/42` }),
      staff,
      now,
    ).blocked,
    true,
    `${prefix} uses the shared record lock`,
  );
}
assert.equal(
  getDailyEntryCutoffDecision(
    request({ mobileTemperatureLog: { recordDate: '2026-09-21' } }),
    staff,
    now,
  ).blocked,
  true,
  'nested record dates cannot bypass the lock',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({}, { query: { checkDate: '2026-09-21' } }),
    staff,
    now,
  ).blocked,
  true,
  'query-string record dates cannot bypass the lock',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({}, { path: '/daily-checklists/2026-09-21' }),
    staff,
    now,
  ).blocked,
  true,
  'date-addressed routes cannot bypass the lock',
);
assert.equal(
  getDailyEntryCutoffDecision(request({ recordDate: '2026-09-21' }), clientAdmin, now).blocked,
  false,
  'client admins retain the correction override',
);
assert.equal(
  getDailyEntryCutoffDecision(request({ recordDate: '2026-09-21' }), consultant, now).blocked,
  false,
  'consultants retain the correction override',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({ recordDate: '2026-09-21' }, { method: 'GET' }),
    staff,
    now,
  ).blocked,
  false,
  'reads are never locked',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({ recordDate: '2026-09-21' }, { path: '/billing/subscription' }),
    staff,
    now,
  ).blocked,
  false,
  'non-track writes are unaffected',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({ checkDate: '2026-10-25' }),
    staff,
    new Date('2026-10-27T00:30:00.000Z'),
    'Europe/London',
  ).blocked,
  true,
  'the lock follows local calendar days across daylight-saving changes',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({ recordDate: '2026-09-21' }),
    staff,
    new Date('2026-09-23T01:30:00.000Z'),
    'America/Los_Angeles',
  ).blocked,
  false,
  'the account timezone controls the local cutoff date',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({ recordDate: '2026-09-20' }),
    staff,
    new Date('2026-09-23T01:30:00.000Z'),
    'America/Los_Angeles',
  ).blocked,
  true,
  'account-local dates still lock after the correction window',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({ recordDate: '2026-09-21' }),
    staff,
    now,
    'not/a-real-timezone',
  ).blocked,
  true,
  'invalid timezone values safely fall back to the UK timezone',
);
assert.equal(
  getDailyEntryCutoffDecision(
    request({ recordDate: '2026-09-21' }),
    staff,
    now,
    '+05:00',
  ).blocked,
  true,
  'fixed offsets are not accepted as account timezones',
);

// Weekly and monthly records stay open to staff until the day after their
// period ends (Steuart, 2026-10-16). `now` is Wednesday 23 September 2026.
const weekly = (weekCommencing, extra = {}, at = now) =>
  getDailyEntryCutoffDecision(
    { method: 'POST', path: '/kitchen-weekly/weekly', body: { weekCommencing }, ...extra },
    staff,
    at,
  ).blocked;
assert.equal(weekly('2026-09-21'), false, 'this week\'s review stays open to staff on Wednesday');
// The week of Monday 14 September ends on Sunday 20th.
assert.equal(
  weekly('2026-09-14', {}, new Date('2026-09-21T12:00:00.000Z')),
  false,
  'last week\'s review is still open the day after the week ends',
);
assert.equal(
  weekly('2026-09-14', {}, new Date('2026-09-22T12:00:00.000Z')),
  true,
  'a week locks once the day after it has passed',
);
assert.equal(weekly('2026-09-07'), true, 'older weekly reviews stay locked');
assert.equal(
  getDailyEntryCutoffDecision(
    { method: 'PUT', path: '/kitchen-weekly/weekly/42', body: { recordDate: '2026-09-21' } },
    staff,
    now,
  ).blocked,
  false,
  'the stored week-commencing date of an existing review uses the weekly window',
);
assert.equal(
  getDailyEntryCutoffDecision(
    { method: 'PUT', path: '/kitchen-weekly/probe/42', body: { recordDate: '2026-09-21' } },
    staff,
    now,
  ).blocked,
  true,
  'probe checks are daily records and keep the 24-hour window',
);
const cleaning = (logDate, frequency, at = now) =>
  getDailyEntryCutoffDecision(
    { method: 'POST', path: '/kitchen-cleaning/logs', body: { logDate, frequency } },
    staff,
    at,
  ).blocked;
assert.equal(cleaning('2026-09-21', 'weekly'), false, 'this week\'s cleaning schedule stays open');
assert.equal(cleaning('2026-09-07', 'weekly'), true, 'an older weekly cleaning schedule is locked');
assert.equal(cleaning('2026-09-01', 'monthly'), false, 'this month\'s cleaning schedule stays open on the 23rd');
assert.equal(cleaning('2026-08-01', 'monthly', new Date('2026-09-01T12:00:00.000Z')), false,
  'last month\'s cleaning schedule is open on the 1st');
assert.equal(cleaning('2026-08-01', 'monthly'), true, 'last month\'s cleaning schedule locks after the 1st');
assert.equal(cleaning('2026-02-01', 'monthly', new Date('2026-03-01T12:00:00.000Z')), false,
  'February ends on the 28th');
assert.equal(cleaning('2026-09-21', 'daily'), true, 'daily cleaning logs keep the 24-hour window');
assert.equal(
  getDailyEntryCutoffDecision(
    { method: 'PUT', path: '/kitchen-cleaning/tasks/42', body: { recordDate: '2026-09-07', frequency: 'monthly' } },
    staff,
    now,
  ).blocked,
  true,
  'only the cleaning log route gets the longer window',
);

console.log('Track record 24-hour lock tests passed.');