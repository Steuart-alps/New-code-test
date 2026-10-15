import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Pure logic behind the mobile resilience fixes: unsent check copies, push
// route mapping, local check dates, apiFetch 401 handling and the API domain.
async function load(relative, env = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  let js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // Each load gets its own module instance; a comment keeps data URLs unique.
  js += `\n// ${JSON.stringify(env)} ${Math.random()}`;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

// ── Unsent submissions ──────────────────────────────────────────────────────
{
  const {
    discardUnsent, isRetryableFailure, parseUnsentSubmissions, recordUnsent, resolveUnsent, unsentSubmissionKey,
  } = await load('../components/unsent-submission-logic.ts');
  let n = 0;
  const id = () => `draft-${++n}`;
  const now = new Date('2026-10-12T09:00:00Z');
  const body = { checkType: 'alarm', checkDate: '2026-10-12', result: 'pass' };
  let drafts = recordUnsent([], { body, label: 'Alarm test', error: 'Network request failed' }, now, id);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].body, body);
  body.result = 'fail';
  assert.equal(drafts[0].body.result, 'pass', 'the saved copy is detached from later form edits');
  // A failed retry of the same body updates that copy instead of duplicating it.
  drafts = recordUnsent(drafts, { body: { ...drafts[0].body }, label: 'Alarm test', error: 'Timeout' }, new Date('2026-10-12T10:00:00Z'), id);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].error, 'Timeout');
  // A different check is kept alongside; at most ten are kept.
  for (let i = 0; i < 12; i++) {
    drafts = recordUnsent(drafts, { body: { checkType: 'alarm', checkDate: `2026-10-0${i % 9 + 1}`, n: i }, label: 'x', error: 'e' }, now, id);
  }
  assert.equal(drafts.length, 10);
  // A successful send removes exactly the delivered copy; discard removes by id.
  const delivered = drafts[3];
  drafts = resolveUnsent(drafts, JSON.parse(JSON.stringify(delivered.body)));
  assert.equal(drafts.length, 9);
  assert.ok(!drafts.some((draft) => draft.id === delivered.id));
  drafts = discardUnsent(drafts, drafts[0].id);
  assert.equal(drafts.length, 8);
  // Stored data round-trips; unreadable or malformed data yields nothing.
  assert.deepEqual(parseUnsentSubmissions(JSON.stringify(drafts)), drafts);
  assert.deepEqual(parseUnsentSubmissions('{not json'), []);
  assert.deepEqual(parseUnsentSubmissions(JSON.stringify([{ id: 1 }])), []);
  // Copies are scoped to the client and user on a shared device.
  assert.notEqual(
    unsentSubmissionKey({ clientId: 1, userId: 2 }, 'pat-test'),
    unsentSubmissionKey({ clientId: 1, userId: 3 }, 'pat-test'),
  );
  // Only failures a resend could fix keep a device copy.
  assert.equal(isRetryableFailure(new TypeError('Network request failed')), true);
  assert.equal(isRetryableFailure(Object.assign(new Error('x'), { status: 503 })), true);
  assert.equal(isRetryableFailure(Object.assign(new Error('x'), { status: 401 })), true);
  assert.equal(isRetryableFailure(Object.assign(new Error('x'), { status: 400 })), false);
  assert.equal(isRetryableFailure(Object.assign(new Error('x'), { status: 409 })), false);
}

// ── Notification route hints ────────────────────────────────────────────────
{
  const { resolveNotificationRoute, HOME_ROUTE } = await load('../lib/notificationRoutes.ts');
  // Hints sent by server reminders today.
  assert.equal(resolveNotificationRoute('/train-track'), '/(tabs)/docs?tab=training');
  assert.equal(resolveNotificationRoute('/track-actions'), '/manage/actions');
  assert.equal(resolveNotificationRoute('/compliance-hub'), '/manage/actions?tab=hub');
  assert.equal(resolveNotificationRoute('/contractors'), HOME_ROUTE);
  assert.equal(resolveNotificationRoute('/(tabs)/docs'), '/(tabs)/docs');
  assert.equal(resolveNotificationRoute('/(tabs)/issues'), '/(tabs)/issues');
  assert.equal(resolveNotificationRoute('/(tabs)/profile'), '/(tabs)/profile');
  assert.equal(resolveNotificationRoute('/(tabs)'), '/(tabs)');
  // Existing check and issue screens pass through; anything else goes home.
  assert.equal(resolveNotificationRoute('/checks/daily'), '/checks/daily');
  assert.equal(resolveNotificationRoute('/checks/fire'), '/checks/fire');
  assert.equal(resolveNotificationRoute('/issues/42'), '/issues/42');
  assert.equal(resolveNotificationRoute('/checks/unknown'), HOME_ROUTE);
  assert.equal(resolveNotificationRoute('https://evil.test/'), HOME_ROUTE);
  assert.equal(resolveNotificationRoute('/settings/billing'), HOME_ROUTE);
  assert.equal(resolveNotificationRoute(undefined), HOME_ROUTE);
  assert.equal(resolveNotificationRoute(42), HOME_ROUTE);
}

// ── Check dates ─────────────────────────────────────────────────────────────
{
  const { addCalendarDays, describeCheckDate, isIsoDate, localIsoDate } = await load('../components/date-stepper-logic.ts');
  const lateEvening = new Date(2026, 9, 12, 23, 30); // local time
  assert.equal(localIsoDate(lateEvening), '2026-10-12', 'device-local date, not UTC');
  assert.equal(addCalendarDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addCalendarDays('2026-03-28', 2), '2026-03-30', 'across the DST change');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('2026-10-12'), true);
  assert.equal(describeCheckDate('2026-10-12', '2026-10-12'), 'Today');
  assert.equal(describeCheckDate('2026-10-11', '2026-10-12'), 'Yesterday');
  assert.match(describeCheckDate('2026-10-05', '2026-10-12'), /5 Oct 2026/);
}

// ── apiFetch: 401 handler and API domain ────────────────────────────────────
{
  const api = await load('../lib/api.ts');
  const calls = [];
  let status = 401;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status, headers: { 'Content-Type': 'application/json' } });
  };
  let unauthorized = 0;
  api.setUnauthorizedHandler(() => { unauthorized++; });

  // Signed out (sign-in / 2FA): a 401 is an inline error, not a sign-out.
  await assert.rejects(api.apiFetch('/api/auth/mobile-login', { method: 'POST' }), (e) => e.status === 401);
  assert.equal(unauthorized, 0);

  // Signed in: a 401 with the session bearer signs out.
  api.setToken('session-token');
  await assert.rejects(api.apiFetch('/api/sites'), (e) => e.status === 401);
  assert.equal(unauthorized, 1);
  assert.equal(calls.at(-1).auth, 'Bearer session-token');

  // A request bound to another bearer (e.g. a replay for an older session or
  // revoking a rotated token) does not sign the current session out.
  await assert.rejects(api.apiFetch('/api/auth/mobile-logout', { headers: { Authorization: 'Bearer old-token' } }), (e) => e.status === 401);
  assert.equal(unauthorized, 1);

  // Other errors never call the handler.
  status = 503;
  await assert.rejects(api.apiFetch('/api/sites'), (e) => e.status === 503);
  assert.equal(unauthorized, 1);
  api.setUnauthorizedHandler(null);

  // Domain normalisation: never "https://undefined".
  const saved = process.env.EXPO_PUBLIC_DOMAIN;
  delete process.env.EXPO_PUBLIC_DOMAIN;
  assert.equal(api.apiBaseUrl(), null);
  process.env.EXPO_PUBLIC_DOMAIN = 'undefined';
  assert.equal(api.apiBaseUrl(), null);
  process.env.EXPO_PUBLIC_DOMAIN = 'https://complytrack.example.test/';
  assert.equal(api.apiBaseUrl(), 'https://complytrack.example.test');
  process.env.EXPO_PUBLIC_DOMAIN = 'complytrack.example.test';
  assert.equal(api.apiDomain(), 'complytrack.example.test');
  if (saved === undefined) delete process.env.EXPO_PUBLIC_DOMAIN; else process.env.EXPO_PUBLIC_DOMAIN = saved;
}

console.log('Mobile offline-resilience logic passed: unsent check copies, push route mapping, local check dates, 401 sign-out scoping and API domain.');
