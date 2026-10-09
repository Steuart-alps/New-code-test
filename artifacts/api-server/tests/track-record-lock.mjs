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

console.log('Track record 24-hour lock tests passed.');