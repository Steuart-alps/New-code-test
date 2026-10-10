import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Release checks for the mobile PAT flow (app/checks/pat.tsx and the PATtrack
// card in app/(tabs)/checks.tsx), mounted with the production screens:
//   1. appliance status labels and their date boundaries (yesterday, today,
//      day 30, day 31) on a device clock in Europe/London just after midnight;
//   2. tapping an appliance preselects it in the Log test form;
//   3. the exact POST /api/pat-track/tests body (result, tester, next due date,
//      notes) and the client-side checks that stop a bad submission;
//   4. PATtrack is hidden from Checks and blocked on its screen without the
//      service. The API refuses it too: routes/index.ts mounts pat-track behind
//      requireService("pattrack").
// Run with a flag below to prove the assertions catch that regression.
const nativePath = fileURLToPath(new URL('./fixtures/pat-native.jsx', import.meta.url));
const mutations = {
  '--utc-today': ['pat.tsx', 'return localIsoDate();', 'return new Date().toISOString().slice(0, 10);'],
  '--overdue-today': ['pat.tsx', 'if (due < todayDate)', 'if (due <= todayDate)'],
  '--due-soon-29': ['pat.tsx', 'inThirtyDays.getDate() + 30', 'inThirtyDays.getDate() + 29'],
  '--first-appliance': ['pat.tsx', 'setApplianceId(appliance.id);', 'setApplianceId(activeAppliances[0].id);'],
  '--drop-notes': ['pat.tsx', '...(notes.trim() ? { notes: notes.trim() } : {}),', ''],
  '--untrimmed-tester': ['pat.tsx', 'testedBy: testedBy.trim(),', 'testedBy,'],
  '--ungated-screen': ['pat.tsx', 'if (!serviceEnabled) {', 'if (false) {'],
  '--ungated-checks': ['checks.tsx', "(mod.id !== 'pat' || hasService('pattrack')) &&", ''],
};
const active = Object.entries(mutations).filter(([flag]) => process.argv.includes(flag));
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/pat-flow-entry.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{
    name: 'native-test-io',
    setup(builder) {
      builder.onResolve({
        filter: /^(react-native|react-native-safe-area-context|@expo\/vector-icons|expo-router|expo-haptics|@\/hooks\/useColors|@\/lib\/auth|@\/lib\/api|@\/components\/KeyboardAwareScrollViewCompat)$/,
      }, () => ({ path: nativePath }));
      builder.onResolve({ filter: /^@\/components\/aqua-track-logic$/ }, () => ({
        path: fileURLToPath(new URL('../components/aqua-track-logic.ts', import.meta.url)),
      }));
      // Negative controls alter only the in-memory bundle, never production files.
      if (active.length) builder.onLoad({ filter: /\/app\/(checks\/pat|\(tabs\)\/checks)\.tsx$/ }, async (args) => {
        let contents = await readFile(args.path, 'utf8');
        for (const [, [file, from, to]] of active) {
          if (!args.path.endsWith(`/${file}`)) continue;
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
  const isScript = req.url === '/fixture.js';
  res.setHeader('Content-Type', isScript ? 'text/javascript' : 'text/html');
  res.end(isScript ? bundled.outputFiles[0].contents : html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// 00:30 BST on 10 Oct 2026 is still 9 Oct in UTC, so "today" must come from the
// device's local date. The 30-day window also crosses the end of BST (25 Oct).
const NOW = new Date('2026-10-10T00:30:00+01:00');
const TODAY = '2026-10-10';
const appliance = (id, name, overrides = {}) => ({
  id, client_id: 23, site_id: 4, name, appliance_type: 'Class I', location: 'Kitchen', asset_tag: `TAG-${id}`,
  description: null, active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  last_test_date: '2025-11-01', last_result: 'pass', next_test_date: null, last_tested_by: 'A Tester', ...overrides,
});
const appliances = [
  appliance(21, 'Due yesterday', { next_test_date: '2026-10-09' }),
  appliance(22, 'Due today', { next_test_date: TODAY }),
  appliance(23, 'Due in 30 days', { next_test_date: '2026-11-09' }),
  appliance(24, 'Due in 31 days', { next_test_date: '2026-11-10' }),
  appliance(25, 'Never tested', { last_test_date: null, last_result: null, last_tested_by: null }),
  // Date columns can arrive as ISO timestamps; only the date part counts.
  appliance(26, 'Due in 30 days (timestamp)', { next_test_date: '2026-11-09T00:00:00.000Z' }),
  appliance(27, 'Failed last test', { last_result: 'fail', next_test_date: '2027-06-01' }),
  appliance(28, 'Tested, no due date'),
];
const expectedLabels = {
  21: 'Overdue', 22: 'Due soon', 23: 'Due soon', 24: 'OK', 25: 'Untested', 26: 'Due soon',
  27: 'Failed', 28: 'Due date needed',
};

let browser;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n  ${error.message.split('\n').join('\n  ')}`);
  }
}
async function openScreen({ screen = 'pat', services } = {}) {
  const context = await browser.newContext({ timezoneId: 'Europe/London', locale: 'en-GB' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.clock.setFixedTime(NOW);
  const errors = [], requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://pat-mobile.test/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const respond = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' },
      body: JSON.stringify(data),
    });
    if (method === 'OPTIONS') return respond({});
    const body = request.postData() ? request.postDataJSON() : undefined;
    requests.push({ method, path, body });
    if (path === '/api/pat-track/appliances' && method === 'GET') return respond(appliances);
    if (path === '/api/pat-track/tests' && method === 'GET') return respond([]);
    if (path === '/api/pat-track/tests' && method === 'POST') {
      return respond({ id: 900 + requests.length, applianceId: body.applianceId, testDate: body.testDate, result: body.result, snapshotSource: 'recorded' }, 201);
    }
    return respond({ error: `Unexpected fixture request ${method} ${path}` }, 500);
  });
  const query = new URLSearchParams({ screen, ...(services === undefined ? {} : { services: services.join(',') }) });
  await page.goto(`${origin}/?${query}`);
  await page.waitForFunction(() => window.harnessReady);
  return {
    page, requests, errors, close: () => context.close(),
    posts: () => requests.filter((r) => r.method === 'POST' && r.path === '/api/pat-track/tests'),
    alerts: () => page.evaluate(() => window.patHarness.alerts),
  };
}

try {
  browser = await chromium.launch({
    headless: true, args: ['--no-sandbox'],
    executablePath: process.env.CHROMIUM_PATH
      ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((path) => existsSync(path)),
  });

  await check('status labels: overdue, due soon (today to day 30), OK from day 31, untested', async () => {
    const s = await openScreen();
    try {
      await s.page.getByTestId('pat-appliance-21').waitFor();
      const labels = {};
      for (const id of Object.keys(expectedLabels)) {
        // The status badge is the card's last text node.
        labels[id] = await s.page.getByTestId(`pat-appliance-${id}`).locator('span').last().innerText();
      }
      assert.deepEqual(labels, expectedLabels);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });

  await check('tapping an appliance preselects it in the Log test form', async () => {
    const s = await openScreen();
    try {
      const modal = s.page.getByTestId('native-modal');
      await s.page.getByTestId('pat-appliance-23').click();
      assert.match(await modal.innerText(), /Due in 30 days/);
      // Fresh form defaults: today, a year ahead, the signed-in user, no notes.
      assert.equal(await s.page.getByTestId('pat-test-date').inputValue(), TODAY);
      assert.equal(await s.page.getByTestId('pat-next-test-date').inputValue(), '2027-10-10');
      assert.equal(await s.page.getByTestId('pat-tested-by').inputValue(), 'Mobile Tester');
      assert.equal(await s.page.getByTestId('pat-notes').inputValue(), '');
      await s.page.getByTestId('pat-close-form').click();
      await modal.waitFor({ state: 'detached' });

      // A second tap replaces the earlier choice; the form has no other picker.
      await s.page.getByTestId('pat-appliance-24').click();
      const text = await modal.innerText();
      assert.match(text, /Due in 31 days/);
      assert.doesNotMatch(text, /Due in 30 days/);
      assert.equal(await modal.locator('select').count(), 0);
      await s.page.getByTestId('pat-submit-test').click();
      await s.page.waitForFunction(() => window.patHarness.alerts.some((a) => a.title === 'Logged'));
      assert.equal(s.posts().at(-1).body.applianceId, 24);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });

  await check('POST /api/pat-track/tests sends result, tester, next due date and notes', async () => {
    const s = await openScreen();
    try {
      await s.page.getByTestId('pat-appliance-22').click();
      await s.page.getByTestId('pat-result-fail').click();
      await s.page.getByTestId('pat-next-test-date').fill('2026-12-01');
      await s.page.getByTestId('pat-tested-by').fill('  Sam Field  ');
      await s.page.getByTestId('pat-notes').fill('  Cracked plug top, removed from use  ');
      await s.page.getByTestId('pat-submit-test').click();
      await s.page.waitForFunction(() => window.patHarness.alerts.some((a) => a.title === 'Logged'));
      assert.equal(s.posts().length, 1);
      assert.deepEqual(s.posts()[0].body, {
        applianceId: 22,
        testDate: TODAY,
        result: 'fail',
        nextTestDate: '2026-12-01',
        testedBy: 'Sam Field',
        notes: 'Cracked plug top, removed from use',
      });

      // A blank tester or a malformed date is stopped before any request.
      await s.page.getByTestId('pat-appliance-25').click();
      await s.page.getByTestId('pat-tested-by').fill('   ');
      await s.page.getByTestId('pat-submit-test').click();
      assert.equal((await s.alerts()).at(-1).title, 'Tester required');
      await s.page.getByTestId('pat-tested-by').fill('Sam Field');
      await s.page.getByTestId('pat-next-test-date').fill('01/12/2026');
      await s.page.getByTestId('pat-submit-test').click();
      assert.equal((await s.alerts()).at(-1).title, 'Check dates');
      assert.equal(s.posts().length, 1, 'invalid forms are not submitted');

      // Defaults are sent as-is, and empty notes are left out.
      await s.page.getByTestId('pat-next-test-date').fill('2027-10-10');
      await s.page.getByTestId('pat-submit-test').click();
      await s.page.waitForFunction(() => window.patHarness.alerts.filter((a) => a.title === 'Logged').length === 2);
      assert.deepEqual(s.posts()[1].body, {
        applianceId: 25, testDate: TODAY, result: 'pass', nextTestDate: '2027-10-10', testedBy: 'Sam Field',
      });
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });

  await check('without the pattrack service the PAT screen is blocked and calls no PAT API', async () => {
    const s = await openScreen({ services: [] });
    try {
      await s.page.getByText('PATtrack is not enabled on your account').waitFor();
      // Give any stray query a chance to fire before asserting none did.
      await s.page.waitForTimeout(300);
      assert.equal(await s.page.locator('[data-testid^="pat-appliance-"]').count(), 0);
      assert.equal(await s.page.getByTestId('pat-submit-test').count(), 0);
      assert.deepEqual(s.requests.filter((r) => r.path.startsWith('/api/pat-track')), []);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });

  await check('the Checks tab hides PATtrack without the service and opens it with the service', async () => {
    const off = await openScreen({ screen: 'checks', services: [] });
    try {
      await off.page.getByTestId('checks-module-daily').waitFor();
      assert.equal(await off.page.getByTestId('checks-module-pat').count(), 0);
      assert.doesNotMatch(await off.page.locator('body').innerText(), /PATtrack/);
    } finally { await off.close(); }

    const on = await openScreen({ screen: 'checks', services: ['pattrack'] });
    try {
      await on.page.getByTestId('checks-module-pat').click();
      const calls = await on.page.evaluate(() => window.patHarness.routerCalls);
      assert.deepEqual(calls, [{ method: 'push', href: '/checks/pat' }]);
      assert.deepEqual(on.errors, []);
    } finally { await on.close(); }
  });
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  console.error(`${failures.length} mobile PAT release check(s) failed.`);
  process.exit(1);
}
console.log('Mobile PAT release checks passed: status labels and boundaries, appliance preselection, test submission body, service gating.');
