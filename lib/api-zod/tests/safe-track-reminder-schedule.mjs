// The shared SafeTrack reminder cadence used by the API scheduler and the
// Settings preview. Run: pnpm --filter @workspace/api-zod run test:safe-track-reminder-schedule
import assert from 'node:assert/strict';
import {
  isSafeTrackReminderDue, nextSafeTrackReminder, parseSafeTrackReminderSettings, safeTrackReminderWindowStart,
} from '../src/safe-track-reminder-schedule.ts';

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error]); } };
const at = (iso) => new Date(iso);
const settings = (frequency, time, accountTimezone = 'Europe/London') =>
  parseSafeTrackReminderSettings({ safeTrackReminderFrequency: frequency, safeTrackReminderTime: time, accountTimezone });
const iso = (preview) => preview?.at.toISOString() ?? null;

test('defaults and invalid values fall back', () => {
  assert.deepEqual(parseSafeTrackReminderSettings({}), { frequency: 'daily', time: '08:50', timeZone: 'Europe/London' });
  assert.deepEqual(settings('hourly', '25:00', 'Mars/Base'), { frequency: 'daily', time: '08:50', timeZone: 'Europe/London' });
});

test('daily: next is today at the delivery time, in BST', () => {
  // 15 Oct 2026 is BST (UTC+1): 08:50 local = 07:50Z.
  const next = nextSafeTrackReminder(at('2026-10-15T06:00:00Z'), settings('daily', '08:50'));
  assert.equal(iso(next), '2026-10-15T07:50:00.000Z');
  assert.equal(next.late, false);
});

test('daily: already sent today moves to tomorrow', () => {
  const next = nextSafeTrackReminder(at('2026-10-15T09:00:00Z'), settings('daily', '08:50'), at('2026-10-15T07:50:20Z'));
  assert.equal(iso(next), '2026-10-16T07:50:00.000Z');
});

test('daily: time passed and nothing sent today is due at the next check', () => {
  const next = nextSafeTrackReminder(at('2026-10-15T13:02:00Z'), settings('daily', '08:50'), at('2026-10-14T07:50:00Z'));
  assert.equal(iso(next), '2026-10-15T13:05:00.000Z');
  assert.equal(next.late, true);
});

test('times off the five-minute grid go at the following check', () => {
  assert.equal(iso(nextSafeTrackReminder(at('2026-10-15T06:00:00Z'), settings('daily', '08:52'))), '2026-10-15T07:55:00.000Z');
});

test('weekly: next Monday at the delivery time, across the end of BST', () => {
  // Thu 15 Oct 2026; BST ends Sun 25 Oct. Mon 19 Oct is BST, Mon 26 Oct is GMT.
  const weekly = settings('weekly', '08:50');
  assert.equal(iso(nextSafeTrackReminder(at('2026-10-15T12:00:00Z'), weekly)), '2026-10-19T07:50:00.000Z');
  assert.equal(iso(nextSafeTrackReminder(at('2026-10-19T09:00:00Z'), weekly, at('2026-10-19T07:50:00Z'))), '2026-10-26T08:50:00.000Z');
});

test('the account timezone decides the day and time', () => {
  // 23:30 Sunday in London is already Monday 08:30 in Sydney (AEDT, UTC+11).
  const sydney = settings('weekly', '08:50', 'Australia/Sydney');
  assert.equal(iso(nextSafeTrackReminder(at('2026-10-18T21:00:00Z'), sydney)), '2026-10-18T21:50:00.000Z');
  // 12:00Z is 08:00 in New York (EDT): today's 07:00 has gone out, so tomorrow's.
  const newYork = settings('daily', '07:00', 'America/New_York');
  assert.equal(iso(nextSafeTrackReminder(at('2026-10-15T12:00:00Z'), newYork, at('2026-10-15T11:00:00Z'))), '2026-10-16T11:00:00.000Z');
});

test('window start is local midnight, or Monday midnight for weekly', () => {
  assert.equal(safeTrackReminderWindowStart(at('2026-10-15T12:00:00Z'), settings('daily', '08:50')).toISOString(), '2026-10-14T23:00:00.000Z');
  assert.equal(safeTrackReminderWindowStart(at('2026-10-15T12:00:00Z'), settings('weekly', '08:50')).toISOString(), '2026-10-11T23:00:00.000Z');
  assert.equal(safeTrackReminderWindowStart(at('2026-10-27T12:00:00Z'), settings('weekly', '08:50')).toISOString(), '2026-10-26T00:00:00.000Z');
});

test('a send a few seconds late does not push the next day later', () => {
  // The old rolling 24-hour window skipped 08:50 whenever yesterday's claim
  // landed later in its check than today's, drifting 5 minutes at a time.
  const daily = settings('daily', '08:50');
  assert.equal(iso(nextSafeTrackReminder(at('2026-10-16T07:49:00Z'), daily, at('2026-10-15T07:50:09Z'))), '2026-10-16T07:50:00.000Z');
});

test('the preview agrees with isSafeTrackReminderDue at every check', () => {
  for (const s of [settings('daily', '08:50'), settings('weekly', '17:15', 'Asia/Dubai'), settings('daily', '00:00', 'Pacific/Auckland')]) {
    const lastSent = at('2026-10-15T11:59:00Z');
    const sendsAt = (check) => isSafeTrackReminderDue(check, s) && lastSent < safeTrackReminderWindowStart(check, s);
    const next = nextSafeTrackReminder(at('2026-10-15T12:00:00Z'), s, lastSent);
    assert.ok(next);
    assert.equal(sendsAt(next.at), true);
    assert.equal(sendsAt(new Date(next.at.getTime() - 5 * 60_000)), false);
  }
});

for (const [status, name, error] of results) console.log(`${status} - ${name}${error ? `\n  ${error.stack}` : ''}`);
if (results.some(([status]) => status === 'FAIL')) process.exit(1);
console.log('SafeTrack reminder schedule checks passed.');
