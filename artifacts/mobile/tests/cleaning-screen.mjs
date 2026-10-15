import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Mounted regression for app/checks/cleaning.tsx (KitchenTrack cleaning
// schedule):
// - with two accessible kitchens, the task, log and history reads use the
//   selected kitchen and its schedule is the only one shown;
// - switching kitchen with unsaved ticks keeps them until the user explicitly
//   discards them;
// - unsaved ticks are kept on the device and restored after an app restart;
// - draft saves and sign-offs carry the kitchen's siteId; a sign-off made
//   with no signal is saved on the device, shown as waiting, then sent with the
//   same entry ID and body (a lost response is replayed, never applied twice).
// Responses mirror artifacts/api-server/src/routes/kitchen-cleaning.ts.
const nativePath = fileURLToPath(new URL('./fixtures/cleaning-native.jsx', import.meta.url));
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/cleaning-entry.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{
    name: 'native-test-io',
    setup(builder) {
      builder.onResolve({
        filter: /^(react-native|react-native-safe-area-context|@expo\/vector-icons|expo-router|expo-haptics|@react-native-async-storage\/async-storage|@\/hooks\/useColors|@\/lib\/auth|@\/lib\/api|@\/components\/KeyboardAwareScrollViewCompat)$/,
      }, () => ({ path: nativePath }));
      // The production outbox core with in-memory storage, signed in as the fixture user.
      builder.onResolve({ filter: /^@\/lib\/checkOutbox$/ }, () => ({
        path: fileURLToPath(new URL('./fixtures/cleaning-check-outbox-native.jsx', import.meta.url)),
      }));
      // Optional negative controls prove the assertions detect regressions.
      // They alter only the in-memory bundle, never production files.
      const mutations = {
        '--unscoped-reads': ['`/api/kitchen-cleaning/tasks?siteId=${siteId}`', '`/api/kitchen-cleaning/tasks`'],
        '--switch-without-confirm': ['requestCleaningSiteChange(siteId, nextSiteId, dirty, isPending)', 'requestCleaningSiteChange(siteId, nextSiteId, false, isPending)'],
        '--no-restore': ['setChecked(draft.checked);', ''],
        '--drop-site-id': ['outbox.send({ ...payload }, label)', 'outbox.send({ ...payload, siteId: null }, label)'],
      };
      const active = Object.entries(mutations).filter(([flag]) => process.argv.includes(flag));
      if (active.length) builder.onLoad({ filter: /\/app\/checks\/cleaning\.tsx$/ }, async (args) => {
        let contents = await readFile(args.path, 'utf8');
        for (const [, [from, to]] of active) {
          assert.ok(contents.includes(from), `negative control target missing: ${from}`);
          contents = contents.replace(from, to);
        }
        return { contents, loader: 'tsx' };
      });
    },
  }],
});
const html = '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? bundled.outputFiles[0].contents : html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

// Daily schedules are dated by the device's local calendar day.
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const sites = [{ id: 4, name: 'Harbour Kitchen' }, { id: 9, name: 'Garden Kitchen' }];
const task = (id, siteId, name) => ({
  id, client_id: 23, site_id: siteId, area: siteId === 4 ? 'Harbour prep' : 'Garden prep', task: name,
  frequency: 'daily', method: null, product: null, responsible: null, sort_order: 0, active: true,
});
const tasks = [task(41, 4, 'Sanitise Harbour boards'), task(42, 4, 'Degrease Harbour fryer'), task(91, 9, 'Mop Garden cold room')];
const logs = new Map();
const receipts = new Map();
const applied = [];
const requests = [];
// online | offline (nothing reaches the server) | lose-response (applied, reply lost)
let network = 'online';
const logKey = (siteId, date, frequency) => `${siteId ?? 'none'}|${date}|${frequency}`;
const draftKey = (siteId) => `complytrack:cleaning-draft:v1:23:5:${siteId}:daily:${today}`;

async function until(check, message) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out: ${message}`);
}

let browser;
try {
  browser = await chromium.launch({
    headless: true, args: ['--no-sandbox'],
    executablePath: process.env.CHROMIUM_PATH
      ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((path) => existsSync(path)),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://cleaning-mobile.test/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const respond = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' },
      body: JSON.stringify(data),
    });
    if (method === 'OPTIONS') return respond({});
    const body = request.postData() ? request.postDataJSON() : undefined;
    const siteParam = url.searchParams.get('siteId');
    requests.push({ method, path, siteId: siteParam, body, network });
    if (network === 'offline') return route.abort('internetdisconnected');

    if (path === '/api/sites' && method === 'GET') return respond(sites);
    // Like the API: no siteId means the account-wide list of every kitchen's tasks.
    if (path === '/api/kitchen-cleaning/tasks' && method === 'GET') {
      return respond(tasks.filter((t) => siteParam === null || t.site_id === Number(siteParam) || t.site_id === null));
    }
    if (path === '/api/kitchen-cleaning/logs/history' && method === 'GET') {
      return respond([...logs.values()].filter((row) => siteParam === null || row.site_id === Number(siteParam)).map((row) => ({
        id: row.id, site_id: row.site_id, log_date: row.log_date, frequency: row.frequency, signed_by: row.signed_by,
        submitted_at: row.submitted_at, completed_count: row.completions.filter((c) => c.done).length, total_count: row.completions.length,
      })));
    }
    if (path === '/api/kitchen-cleaning/logs' && method === 'GET') {
      const row = logs.get(logKey(siteParam === null ? null : Number(siteParam), url.searchParams.get('date'), url.searchParams.get('frequency')));
      return row ? respond(row) : respond({ error: 'Not found' }, 404);
    }
    if (path === '/api/kitchen-cleaning/logs' && method === 'POST') {
      const { clientEntryId, ...payload } = body;
      const key = logKey(payload.siteId ?? null, payload.logDate, payload.frequency);
      if (clientEntryId) {
        const receipt = receipts.get(clientEntryId);
        if (receipt) {
          return receipt.hash === JSON.stringify(payload)
            ? respond(logs.get(receipt.key))
            : respond({ error: 'This device entry was already used for a different submission.', code: 'CLIENT_ENTRY_CONFLICT' }, 409);
        }
        if (logs.get(key)?.submitted_at) {
          return respond({ error: 'This cleaning schedule was already signed off.', code: 'CLEANING_LOG_SIGNED_OFF' }, 409);
        }
      }
      const existing = logs.get(key);
      const row = {
        id: existing?.id ?? 700 + logs.size, client_id: 23, site_id: payload.siteId ?? null, log_date: payload.logDate,
        frequency: payload.frequency, completions: payload.completions, signed_by: payload.signedBy ?? null,
        submitted_at: payload.submittedAt ?? null,
      };
      logs.set(key, row);
      if (clientEntryId) receipts.set(clientEntryId, { hash: JSON.stringify(payload), key });
      applied.push(clientEntryId ?? null);
      if (network === 'lose-response') {
        network = 'online';
        return route.abort('connectionreset');
      }
      return respond(row, existing ? 200 : 201);
    }
    throw new Error(`Unexpected fixture request ${method} ${path}${url.search}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.harnessReady);
  const harness = (fn, arg) => page.evaluate(fn, arg);
  const deviceKeys = () => harness(() => window.cleaningHarness.deviceKeys());
  const lastAlert = () => harness(() => window.cleaningHarness.alerts.at(-1) && {
    title: window.cleaningHarness.alerts.at(-1).title,
    message: window.cleaningHarness.alerts.at(-1).message,
  });
  const alertCount = () => harness(() => window.cleaningHarness.alerts.length);
  const press = (text) => harness((label) => window.cleaningHarness.pressAlertButton(label), text);
  const checked = (id) => page.getByTestId(`cleaning-task-${id}`).getAttribute('aria-checked');
  const text = () => page.locator('body').innerText();
  const reads = (siteId) => requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/kitchen-cleaning/') && r.siteId === String(siteId));

  // ── Two accessible kitchens: reads and the visible schedule follow the selection.
  await page.getByTestId('cleaning-site-4').waitFor();
  await page.getByTestId('cleaning-site-9').waitFor();
  assert.match(await text(), /Select a kitchen/);
  await page.getByTestId('cleaning-site-4').click();
  await page.getByTestId('cleaning-task-41').waitFor();
  await page.getByTestId('cleaning-task-42').waitFor();
  assert.equal(await page.getByTestId('cleaning-task-91').count(), 0, "another kitchen's tasks are never shown");
  for (const path of ['/api/kitchen-cleaning/tasks', '/api/kitchen-cleaning/logs', '/api/kitchen-cleaning/logs/history']) {
    assert.ok(reads(4).some((r) => r.path === path), `${path} was read for the selected kitchen`);
  }
  assert.deepEqual(
    requests.filter((r) => r.path.startsWith('/api/kitchen-cleaning/') && r.siteId === null),
    [],
    'no cleaning read is made without the selected kitchen',
  );

  // ── Unsaved ticks survive a kitchen switch until explicitly discarded.
  await page.getByTestId('cleaning-task-41').click();
  assert.equal(await checked(41), 'true');
  await until(async () => (await deviceKeys()).includes(draftKey(4)), 'the unsaved tick is kept on the device');
  const alertsBefore = await alertCount();
  await page.getByTestId('cleaning-site-9').click();
  assert.equal(await alertCount(), alertsBefore + 1, 'switching kitchen with unsaved work asks first');
  assert.equal((await lastAlert()).title, 'Discard unsaved changes?');
  assert.equal(reads(9).length, 0, 'the other kitchen is not loaded before the user decides');
  await press('Keep editing');
  await page.waitForTimeout(100);
  assert.equal(await checked(41), 'true', 'keep editing leaves the draft untouched');
  assert.equal(await page.getByTestId('cleaning-task-91').count(), 0);
  assert.ok((await deviceKeys()).includes(draftKey(4)), 'the device copy is kept');
  assert.equal(reads(9).length, 0);

  await page.getByTestId('cleaning-site-9').click();
  assert.equal((await lastAlert()).title, 'Discard unsaved changes?');
  await press('Discard');
  await page.getByTestId('cleaning-task-91').waitFor();
  assert.equal(await page.getByTestId('cleaning-task-41').count(), 0, 'the previous kitchen schedule is gone');
  assert.equal(await page.getByTestId('cleaning-task-42').count(), 0);
  for (const path of ['/api/kitchen-cleaning/tasks', '/api/kitchen-cleaning/logs', '/api/kitchen-cleaning/logs/history']) {
    assert.ok(reads(9).some((r) => r.path === path), `${path} was read for the newly selected kitchen`);
  }
  await until(async () => !(await deviceKeys()).includes(draftKey(4)), 'an explicit discard removes the device copy');

  // ── Draft save carries the kitchen; a clean switch needs no confirmation.
  const beforeCleanSwitch = await alertCount();
  await page.getByTestId('cleaning-site-4').click();
  await page.getByTestId('cleaning-task-41').waitFor();
  assert.equal(await alertCount(), beforeCleanSwitch, 'no confirmation without unsaved work');
  await page.getByTestId('cleaning-task-41').click();
  await page.getByTestId('cleaning-task-42').click();
  await page.getByTestId('cleaning-save-draft').click();
  await until(async () => (await lastAlert())?.title === 'Draft saved', 'the draft is saved');
  const draftPost = requests.filter((r) => r.method === 'POST').at(-1);
  assert.equal(draftPost.body.siteId, 4, 'the draft save carries the selected kitchen');
  assert.equal(draftPost.body.submittedAt, null);
  assert.match(draftPost.body.clientEntryId, /^cleaning-log-/);
  assert.deepEqual(draftPost.body.completions.map((c) => [c.taskId, c.done]), [[41, true], [42, true]]);
  await until(async () => !(await deviceKeys()).includes(draftKey(4)), 'a saved draft leaves no device copy');

  // ── Unsaved ticks are restored after the app is closed and reopened.
  await page.getByTestId('cleaning-task-42').click();
  await until(async () => {
    const stored = await harness((key) => window.cleaningHarness.deviceValue(key), draftKey(4));
    return stored && JSON.parse(stored).checked['42'] === false;
  }, 'the untick is kept on the device');
  const readsBeforeRestart = reads(4).length;
  await harness(() => window.cleaningHarness.restart());
  await page.getByTestId('cleaning-site-4').waitFor();
  assert.match(await text(), /Select a kitchen/, 'the reopened screen starts from scratch');
  await page.getByTestId('cleaning-site-4').click();
  await page.getByTestId('cleaning-unsaved').waitFor();
  assert.ok(reads(4).length > readsBeforeRestart, 'the server copy was reloaded after the restart');
  assert.match(await page.getByTestId('cleaning-unsaved').innerText(), /restored from this device/);
  assert.equal(await checked(41), 'true', 'restored tick');
  assert.equal(await checked(42), 'false', 'restored untick wins over the older server draft');
  assert.match(await text(), /1 of 2 tasks completed/);

  // ── Sign-off with no signal: saved on the device and shown as waiting.
  network = 'offline';
  await page.getByTestId('cleaning-sign-off').click();
  await until(async () => (await lastAlert())?.title === 'Saved on this device', 'the offline sign-off is kept on the device');
  const offlineAttempt = requests.filter((r) => r.method === 'POST').at(-1);
  assert.equal(offlineAttempt.network, 'offline');
  assert.equal(offlineAttempt.body.siteId, 4, 'the sign-off carries the selected kitchen');
  assert.ok(offlineAttempt.body.submittedAt, 'it is a final sign-off');
  const signOffId = offlineAttempt.body.clientEntryId;
  assert.match(signOffId, /^cleaning-log-/);
  assert.notEqual(signOffId, draftPost.body.clientEntryId, 'each save has its own entry ID');
  assert.match(await page.getByTestId('cleaning-sync-status').innerText(), /Sign-off saved on this device/);
  await page.getByTestId(`outbox-entry-${signOffId}`).waitFor();
  assert.match(await page.getByTestId('outbox-entries').innerText(), /Cleaning sign-off · Harbour Kitchen/);
  assert.equal(await page.getByTestId('cleaning-sign-off').count(), 0, 'a waiting sign-off locks the schedule');
  assert.equal(await page.getByTestId('cleaning-task-41').isDisabled(), true);
  assert.equal(await checked(41), 'true', 'the waiting sign-off ticks stay on screen');
  assert.equal(await checked(42), 'false');
  await until(async () => !(await deviceKeys()).includes(draftKey(4)), 'the outbox now holds the work, not a draft');
  const stored = await harness(() => window.cleaningHarness.outboxStored());
  assert.ok(stored.flat().some((e) => e.entryId === signOffId && e.state === 'queued' && e.body.siteId === 4),
    'the sign-off is persisted in device storage before delivery');
  assert.ok(!applied.includes(signOffId), 'nothing reached the server while offline');

  // ── Back online: the response to the first delivery is lost, the resend is
  // recognised by its entry ID, and the schedule shows as signed off.
  network = 'lose-response';
  await page.getByTestId(`outbox-send-${signOffId}`).click();
  await until(() => applied.includes(signOffId), 'the server applied the sign-off');
  await until(async () => (await harness(() => window.cleaningHarness.outboxEntries()))
    .some((e) => e.entryId === signOffId && e.state === 'queued'), 'a lost response keeps the entry waiting');
  await page.getByTestId(`outbox-send-${signOffId}`).click();
  await page.getByText('Signed off by Mobile Tester').waitFor();
  await until(async () => /Sign-off from this device received by the server/.test(await page.getByTestId('cleaning-sync-status').innerText()),
    'the sign-off shows as sent');
  assert.equal(await page.getByTestId('outbox-entries').count(), 0, 'nothing is left waiting');
  const attempts = requests.filter((r) => r.method === 'POST' && r.body?.clientEntryId === signOffId);
  assert.ok(attempts.length >= 3, 'offline attempt, lost-response attempt and resend');
  for (const attempt of attempts) assert.deepEqual(attempt.body, attempts[0].body, 'every attempt is identical, with the same entry ID and siteId');
  assert.equal(applied.filter((id) => id === signOffId).length, 1, 'the resend never applied the sign-off twice');
  assert.deepEqual([...logs.keys()], [logKey(4, today, 'daily')], 'only the selected kitchen was written');
  const signedLog = logs.get(logKey(4, today, 'daily'));
  assert.ok(signedLog.submitted_at);
  assert.deepEqual(signedLog.completions.map((c) => [c.taskId, c.done]), [[41, true], [42, false]]);

  assert.deepEqual(errors, []);
  console.log('Mounted mobile cleaning regression passed: kitchen-scoped reads, kitchen switch keeps unsaved work until discarded, device draft restored after restart, siteId on draft and sign-off, offline sign-off queued then sent once under the same entry ID.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
