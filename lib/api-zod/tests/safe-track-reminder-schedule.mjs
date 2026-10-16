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

// ── Daylight-saving boundaries (Replit #339) ────────────────────────────────
// Runs the scheduler exactly as the API does: a check every five minutes on
// the UTC clock, sending when due and nothing has gone out in the window.
const localDay = (instant, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
const localTime = (instant, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
function simulate(s, fromIso, toIso) {
  const sends = [];
  // Start as if the first day's reminder had already gone out.
  let lastSent = new Date(fromIso);
  // What Settings would have shown at the start and after each send.
  let preview = nextSafeTrackReminder(lastSent, s, lastSent);
  for (let tick = Date.parse(fromIso); tick < Date.parse(toIso); tick += 5 * 60_000) {
    const check = new Date(tick);
    if (!isSafeTrackReminderDue(check, s) || lastSent >= safeTrackReminderWindowStart(check, s)) continue;
    assert.equal(preview?.at.toISOString(), check.toISOString(), 'the preview named this send');
    lastSent = check;
    sends.push({ day: localDay(check, s.timeZone), time: localTime(check, s.timeZone) });
    preview = nextSafeTrackReminder(new Date(tick + 1), s, lastSent);
  }
  return sends;
}
const transitions = [
  // zone, spring forward (local 1-2am or 2-3am skipped), autumn fall back (repeated hour)
  ['Europe/London', '2027-03-28', '01:30', '02:00', '2026-10-25', '01:30'],
  ['America/New_York', '2027-03-14', '02:30', '03:00', '2026-11-01', '01:30'],
];
for (const [zone, springDay, missing, afterJump, autumnDay, repeated] of transitions) {
  const around = (day, hoursBefore, hoursAfter) => [
    new Date(Date.parse(`${day}T12:00:00Z`) - hoursBefore * 3_600_000).toISOString(),
    new Date(Date.parse(`${day}T12:00:00Z`) + hoursAfter * 3_600_000).toISOString(),
  ];
  for (const [label, day] of [['spring forward', springDay], ['autumn fall back', autumnDay]]) {
    test(`${zone} ${label}: an ordinary daily time is sent once per local day at that time`, () => {
      const sends = simulate(settings('daily', '08:50', zone), ...around(day, 72, 72));
      assert.deepEqual(sends.map((send) => send.time), Array(sends.length).fill('08:50'));
      assert.equal(new Set(sends.map((send) => send.day)).size, sends.length, 'one send per local day');
      const gaps = sends.slice(1).map((send, index) => (Date.parse(send.day) - Date.parse(sends[index].day)) / 86_400_000);
      assert.deepEqual(gaps, Array(gaps.length).fill(1), 'no local day skipped');
      assert.ok(sends.length >= 5 && sends.some((send) => send.day === day), 'sent on the change-over day');
    });
  }
  test(`${zone} spring forward: a skipped local time is sent once, at the first check after the jump`, () => {
    const sends = simulate(settings('daily', missing, zone), ...around(springDay, 60, 60));
    assert.equal(new Set(sends.map((send) => send.day)).size, sends.length, 'one send per local day');
    assert.deepEqual(sends.find((send) => send.day === springDay), { day: springDay, time: afterJump });
    assert.deepEqual(sends.filter((send) => send.day !== springDay).map((send) => send.time), Array(sends.length - 1).fill(missing));
  });
  test(`${zone} autumn fall back: a repeated local time is sent once, the first time round`, () => {
    const s = settings('daily', repeated, zone);
    const [from, to] = around(autumnDay, 60, 60);
    const sends = simulate(s, from, to);
    assert.deepEqual(sends.map((send) => send.time), Array(sends.length).fill(repeated));
    assert.equal(new Set(sends.map((send) => send.day)).size, sends.length, 'no second send in the repeated hour');
    // The first occurrence is in summer time: one hour earlier in UTC.
    const first = nextSafeTrackReminder(new Date(`${autumnDay}T00:00:00Z`), s, new Date(`${autumnDay}T00:00:00Z`));
    assert.equal(localTime(first.at, zone), repeated);
    assert.equal(first.at.getTime() + 3_600_000 <= Date.parse(to), true);
    assert.equal(isSafeTrackReminderDue(new Date(first.at.getTime() + 3_600_000), s), true, 'the repeat is still due');
    assert.ok(first.at >= safeTrackReminderWindowStart(new Date(first.at.getTime() + 3_600_000), s), 'but in the same window');
  });
  for (const [label, day] of [['spring forward', springDay], ['autumn fall back', autumnDay]]) {
    test(`${zone} ${label}: a weekly reminder goes once each Monday across the change`, () => {
      const sends = simulate(settings('weekly', '08:50', zone), ...around(day, 10 * 24, 10 * 24));
      assert.equal(sends.length, 3);
      for (const send of sends) {
        assert.equal(new Date(`${send.day}T12:00:00Z`).getUTCDay(), 1, `${send.day} is a Monday`);
        assert.equal(send.time, '08:50');
      }
      const gaps = sends.slice(1).map((send, index) => (Date.parse(send.day) - Date.parse(sends[index].day)) / 86_400_000);
      assert.deepEqual(gaps, [7, 7]);
    });
  }
}

for (const [status, name, error] of results) console.log(`${status} - ${name}${error ? `\n  ${error.stack}` : ''}`);
if (results.some(([status]) => status === 'FAIL')) process.exit(1);
console.log('SafeTrack reminder schedule checks passed.');
