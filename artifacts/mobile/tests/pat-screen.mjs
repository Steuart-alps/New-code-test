import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Mounted regression for app/checks/pat.tsx: retired appliances are not test
// targets, retained history stays visible with honest location provenance,
// tests cannot be deleted, the tapped appliance is fixed in the log form and a
// successful log refreshes both cached lists. Responses mirror
// artifacts/api-server/src/routes/pat-track.ts.
const nativePath = fileURLToPath(new URL('./fixtures/pat-native.jsx', import.meta.url));
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/pat-entry.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{
    name: 'native-test-io',
    setup(builder) {
      builder.onResolve({
        filter: /^(react-native|react-native-safe-area-context|@expo\/vector-icons|expo-router|expo-haptics|expo-camera|@\/hooks\/useColors|@\/lib\/auth|@\/lib\/api|@\/components\/KeyboardAwareScrollViewCompat)$/,
      }, () => ({ path: nativePath }));
      // Optional negative controls prove the assertions detect regressions.
      // They alter only the in-memory bundle, never production files.
      const mutations = {
        '--offer-retired': ['appliances.filter((appliance) => appliance.active)', 'appliances'],
        '--skip-refresh': ["qc.invalidateQueries({ queryKey: ['pat-tests'] });", ''],
        '--unqualified-backfill': ['Backfilled location (not verified at test date)', 'Test location'],
      };
      const active = Object.entries(mutations).filter(([flag]) => process.argv.includes(flag));
      if (active.length) builder.onLoad({ filter: /\/app\/checks\/pat\.tsx$/ }, async (args) => {
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

const appliance = (id, name, overrides = {}) => ({
  id, client_id: 23, site_id: 4, name, appliance_type: 'Kitchen Appliance', location: 'Kitchen', asset_tag: `TAG-${id}`,
  description: null, active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  last_test_date: null, last_result: null, next_test_date: null, last_tested_by: null,
  last_test_site_id: null, last_test_site_name: null, last_test_location: null, last_test_location_source: null, ...overrides,
});
const patTest = (id, applianceId, name, overrides = {}) => ({
  id, client_id: 23, appliance_id: applianceId, site_id_snapshot: 4, site_name_snapshot: 'Harbour Hotel',
  department_id_snapshot: null, location_snapshot: 'Kitchen', appliance_name_snapshot: name, appliance_type_snapshot: 'Class I',
  asset_tag_snapshot: `TAG-${applianceId}`, snapshot_source: 'recorded', test_date: '2026-03-01', result: 'pass',
  next_test_date: '2027-03-01', tested_by: 'A Tester', visual_inspection: 'pass', earth_continuity_ohms: null,
  insulation_mohms: null, operating_current: null, notes: null, created_by: 1, created_at: '2026-03-01T10:00:00.000Z',
  updated_at: '2026-03-01T10:00:00.000Z', appliance_name: name, appliance_type: 'Class I', asset_tag: `TAG-${applianceId}`, ...overrides,
});
const state = {
  appliances: [
    appliance(11, 'Active kettle', { last_test_date: '2026-03-01', last_result: 'pass', next_test_date: '2027-03-01' }),
    appliance(12, 'Retired heater', { active: false, location: 'Moved store' }),
    appliance(13, 'Bar fridge'),
  ],
  tests: [
    patTest(101, 11, 'Active kettle'),
    patTest(102, 12, 'Retired heater (as tested)', { snapshot_source: 'legacy_backfill', site_name_snapshot: 'Old site', location_snapshot: 'Old boiler room', test_date: '2026-02-01' }),
    patTest(103, 12, 'Retired heater (as tested)', { snapshot_source: 'legacy_unavailable', site_id_snapshot: null, site_name_snapshot: null, location_snapshot: null, test_date: '2025-02-01' }),
  ],
};
const requests = [];
const gets = (path) => requests.filter((r) => r.method === 'GET' && r.path === path).length;
let browser;
try {
  browser = await chromium.launch({
    headless: true, args: ['--no-sandbox'],
    executablePath: process.env.CHROMIUM_PATH
      ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((path) => existsSync(path)),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
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
    if (path === '/api/pat-track/appliances' && method === 'GET') return respond(state.appliances);
    if (path === '/api/pat-track/tests' && method === 'GET') return respond(state.tests);
    if (path === '/api/pat-track/tests' && method === 'POST') {
      const target = state.appliances.find((a) => a.id === body.applianceId);
      if (!target.active) return respond({ error: 'Retired appliances cannot receive new tests; reactivate the appliance first' }, 409);
      const created = patTest(200 + state.tests.length, target.id, target.name, { test_date: body.testDate, result: body.result, tested_by: body.testedBy });
      state.tests.unshift(created);
      Object.assign(target, { last_test_date: body.testDate, last_result: body.result, next_test_date: body.nextTestDate });
      return respond({ id: created.id, applianceId: target.id, testDate: body.testDate, result: body.result, snapshotSource: 'recorded' }, 201);
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.harnessReady);
  await page.getByTestId('pat-appliance-11').waitFor();
  const text = () => page.locator('body').innerText();

  // Retired assets are not offered as test targets.
  assert.equal(await page.getByTestId('pat-appliance-12').count(), 0, 'retired appliance is excluded from test targets');
  assert.equal(await page.getByTestId('pat-appliance-13').count(), 1);
  await page.getByText('Retired heater (as tested)').first().waitFor();

  // Retained history: visible for retired appliances, with location provenance.
  const body = await text();
  assert.match(body, /Test location: Harbour Hotel · Kitchen/);
  assert.match(body, /Backfilled location \(not verified at test date\): Old site · Old boiler room/);
  assert.match(body, /Historical test location unavailable/);
  assert.doesNotMatch(body, /Moved store/, 'the live location of a retired appliance is never shown as test history');
  assert.doesNotMatch(body, /delete/i, 'retained tests have no delete control');

  // The tapped appliance is fixed in the log form; there is no other picker.
  await page.getByTestId('pat-appliance-13').click();
  const modal = page.getByTestId('native-modal');
  await modal.waitFor();
  assert.match(await modal.innerText(), /Bar fridge/);
  assert.equal(await modal.locator('select').count(), 0, 'the log form has no appliance re-selection');
  const before = { appliances: gets('/api/pat-track/appliances'), tests: gets('/api/pat-track/tests') };
  await page.getByTestId('pat-result-fail').click();
  await page.getByTestId('pat-submit-test').click();
  await page.waitForFunction(() => window.patHarness.alerts.some((a) => a.title === 'Logged'));
  const posted = requests.filter((r) => r.method === 'POST').at(-1);
  assert.equal(posted.body.applianceId, 13);
  assert.equal(posted.body.result, 'fail');
  assert.equal(posted.body.testedBy, 'Mobile Tester');
  await page.waitForFunction(() => !document.querySelector('[data-testid="native-modal"]'));
  for (let i = 0; i < 50 && (gets('/api/pat-track/appliances') <= before.appliances || gets('/api/pat-track/tests') <= before.tests); i++) {
    await page.waitForTimeout(50);
  }
  assert.ok(gets('/api/pat-track/appliances') > before.appliances, 'a successful log refreshes the appliance list');
  assert.ok(gets('/api/pat-track/tests') > before.tests, 'a successful log refreshes the test history');
  await page.getByText('Bar fridge').nth(1).waitFor();

  // An appliance retired elsewhere is rejected with the server's explanation.
  await page.getByTestId('pat-appliance-11').click();
  state.appliances.find((a) => a.id === 11).active = false;
  await page.getByTestId('pat-submit-test').click();
  await page.waitForFunction(() => window.patHarness.alerts.some((a) => a.title === 'Error'));
  assert.equal(await page.evaluate(() => window.patHarness.alerts.at(-1).message),
    'Retired appliances cannot receive new tests; reactivate the appliance first');
  await page.getByTestId('pat-close-form').click();
  await page.evaluate(() => window.patHarness.refresh());
  await page.waitForFunction(() => !document.querySelector('[data-testid="pat-appliance-11"]'));

  // Reactivation on the web returns the appliance to the targets on refresh.
  state.appliances.find((a) => a.id === 12).active = true;
  await page.evaluate(() => window.patHarness.refresh());
  await page.getByTestId('pat-appliance-12').waitFor();
  assert.equal(requests.filter((r) => r.method === 'DELETE').length, 0);
  assert.deepEqual(errors, []);
  console.log('Mounted mobile PAT regression passed: retired targets, retained history provenance, no test deletion, fixed appliance, refreshed caches, retirement race and reactivation.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
