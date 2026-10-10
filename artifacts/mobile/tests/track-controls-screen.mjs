import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Mounted regression for app/controls/[module].tsx: the read-only FireTrack and
// LegionellaTrack site controls. Every read goes through the generated API
// client with the mobile bearer token, is scoped to the chosen site, never
// carries a client id, and a department refusal is shown rather than hidden.
// Responses mirror artifacts/api-server/src/routes/{fire-safety,legionella}.ts.
const nativePath = fileURLToPath(new URL('./fixtures/track-controls-native.jsx', import.meta.url));
const componentsDir = fileURLToPath(new URL('../components/', import.meta.url));
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/track-controls-entry.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{
    name: 'native-test-io',
    setup(builder) {
      builder.onResolve({
        filter: /^(react-native|@expo\/vector-icons|expo-router|@\/hooks\/useColors|@\/lib\/auth|@\/lib\/api)$/,
      }, () => ({ path: nativePath }));
      builder.onResolve({ filter: /^@\/components\// }, (args) => {
        const base = `${componentsDir}${args.path.slice('@/components/'.length)}`;
        return { path: [`${base}.ts`, `${base}.tsx`].find((path) => existsSync(path)) };
      });
      // Optional negative control: an unscoped status read must fail the test.
      if (process.argv.includes('--unscoped-status')) builder.onLoad({ filter: /\/app\/controls\/\[module\]\.tsx$/ }, async (args) => {
        const contents = await readFile(args.path, 'utf8');
        const target = 'getLegionellaStatus({ siteId })';
        assert.ok(contents.includes(target), 'negative control target missing');
        return { contents: contents.replace(target, 'getLegionellaStatus()'), loader: 'tsx' };
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

function isoDaysFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const sites = [{ id: 4, name: 'Harbour Hotel' }, { id: 7, name: 'Beach Bar' }, { id: 9, name: 'Other Department' }];
const waterCheck = (id, checkType, checkDate, overrides = {}) => ({
  id, clientId: 23, siteId: 7, checkType, checkDate, result: 'pass', temperature: '61.0', location: 'Plant room',
  notes: null, performedBy: 'Duty Manager', createdAt: `${checkDate}T09:00:00.000Z`, updatedAt: `${checkDate}T09:00:00.000Z`, ...overrides,
});
const fireCheck = (id, checkType, checkDate, overrides = {}) => ({
  id, clientId: 23, siteId: 4, checkType, checkDate, result: 'pass', location: 'Reception', notes: null,
  performedBy: 'Night Porter', createdAt: `${checkDate}T09:00:00.000Z`, updatedAt: `${checkDate}T09:00:00.000Z`, ...overrides,
});

function answer(path, siteId) {
  if (path === '/api/sites') return [200, sites];
  if (siteId === '9') return [403, { error: 'Site not accessible' }];
  if (path === '/api/legionella/config') return [200, {
    siteId: Number(siteId),
    effectiveTemperatureLimits: { calorifier_temp: { min: 60 }, cold_tank_temp: { max: 20 } },
    controlProfile: {
      writtenControlSchemeReference: `WCS-${siteId}`,
      riskAssessmentReviewDate: isoDaysFromToday(-3),
      competentPerson: 'A. Waterman (Aqua Ltd)',
      temperatureLimits: { calorifier_temp: { min: 60 } },
    },
  }];
  if (path === '/api/legionella/monitoring-plan') return [200, {
    approved: false, profile: { reviewRequired: true, materialChangeNote: 'New calorifier fitted' },
  }];
  if (path === '/api/legionella/status') return [200, [
    { checkType: 'calorifier_temp', frequencyDays: null, lastDate: isoDaysFromToday(-1), lastResult: 'pass', dueDate: null, status: 'plan_required' },
    { checkType: 'shower_clean', frequencyDays: null, lastDate: null, lastResult: null, dueDate: null, status: 'plan_required' },
  ]];
  if (path === '/api/legionella') return [200, [
    waterCheck(1, 'calorifier_temp', isoDaysFromToday(-40)),
    waterCheck(2, 'calorifier_temp', isoDaysFromToday(-1), { temperature: '58.5', result: 'fail' }),
    waterCheck(3, 'calorifier_temp', isoDaysFromToday(-8)),
    waterCheck(4, 'calorifier_temp', isoDaysFromToday(-15)),
  ]];
  if (path === '/api/fire-safety/config') return [200, {
    siteId: Number(siteId),
    controlProfile: {
      riskAssessmentReference: 'FRA-2026-04', riskAssessmentDate: '2026-04-01', nextReviewDate: isoDaysFromToday(10),
      responsiblePerson: 'General Manager', maintenanceEvidenceReference: 'Alarm contract ALM-77', ukNation: 'wales',
    },
  }];
  if (path === '/api/fire-safety/status') return [200, [
    { checkType: 'alarm', frequencyDays: 7, lastDate: isoDaysFromToday(-2), lastResult: 'pass', dueDate: isoDaysFromToday(5), status: 'ok' },
    { checkType: 'fire_walk', frequencyDays: 14, lastDate: null, lastResult: null, dueDate: null, status: 'never' },
  ]];
  if (path === '/api/fire-safety') return [200, [fireCheck(11, 'alarm', isoDaysFromToday(-2))]];
  return null;
}

let browser;
try {
  browser = await chromium.launch({
    headless: true, args: ['--no-sandbox'],
    executablePath: process.env.CHROMIUM_PATH
      ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((path) => existsSync(path)),
  });

  async function open(params) {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://controls-mobile.test/**', async (route) => {
      const request = route.request(), url = new URL(request.url());
      const headers = {
        'Access-Control-Allow-Origin': request.headers().origin ?? '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'GET',
      };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      requests.push({ method: request.method(), path: url.pathname, query: url.searchParams, auth: request.headers().authorization });
      const result = request.method() === 'GET' ? answer(url.pathname, url.searchParams.get('siteId')) : null;
      if (!result) throw new Error(`Unexpected fixture request ${request.method()} ${url.pathname}${url.search}`);
      return route.fulfill({ status: result[0], contentType: 'application/json', headers, body: JSON.stringify(result[1]) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/#${encodeURIComponent(JSON.stringify(params))}`);
    await page.waitForFunction(() => window.harnessReady);
    return { page, errors, requests, text: () => page.locator('body').innerText() };
  }

  function assertScopedReads(requests, siteId) {
    const moduleReads = requests.filter((r) => r.path !== '/api/sites');
    assert.ok(moduleReads.length > 0, 'the screen read the site controls');
    for (const r of requests) {
      assert.equal(r.method, 'GET', `${r.path} is read-only`);
      assert.equal(r.auth, 'Bearer test-only-token', `${r.path} carries the mobile bearer token`);
      assert.equal(r.query.has('clientId'), false, `${r.path} never supplies a client id`);
    }
    for (const r of moduleReads) assert.equal(r.query.get('siteId'), String(siteId), `${r.path} is scoped to site ${siteId}`);
  }

  // ── LegionellaTrack, opened for a specific site from the dashboard ──────────
  {
    const { page, errors, requests, text } = await open({ module: 'water', siteId: '7' });
    await page.getByTestId('site-controls-check-calorifier_temp').waitFor();
    await page.getByTestId('site-controls-plan').waitFor();
    assertScopedReads(requests, 7);
    assert.deepEqual(
      [...new Set(requests.map((r) => r.path))].sort(),
      ['/api/legionella', '/api/legionella/config', '/api/legionella/monitoring-plan', '/api/legionella/status', '/api/sites'],
    );
    const body = await text();
    assert.match(body, /LegionellaTrack controls/);
    assert.match(body, /Evidence gaps/);
    assert.match(body, /Missing: Legionella risk assessment/);
    assert.match(body, /Missing: Approved monitoring plan/);
    assert.match(body, /Overdue: Risk assessment review date/);
    assert.match(body, /WCS-7/);
    assert.match(body, /A\. Waterman \(Aqua Ltd\)/);
    assert.match(body, /Review required after a material change/);
    assert.match(body, /New calorifier fitted/);
    assert.match(body, /Read-only/);
    const calorifier = await page.getByTestId('site-controls-check-calorifier_temp').innerText();
    assert.match(calorifier, /No approved frequency · Limit: At least 60°C/);
    assert.match(calorifier, /Plan needed/);
    assert.match(calorifier, /58\.5°C/);
    assert.match(calorifier, /Duty Manager · Plant room/);
    assert.equal((calorifier.match(/Duty Manager/g) ?? []).length, 3, 'only the three latest checks are listed per type');
    assert.match(await page.getByTestId('site-controls-check-shower_clean').innerText(), /No checks recorded at this site/);
    assert.doesNotMatch(body, /Save|Edit|Delete/, 'no editing controls are offered');

    // Switching site re-reads every control for the new site only.
    const before = requests.length;
    await page.getByTestId('site-controls-site-4').click();
    await page.waitForFunction(() => document.body.innerText.includes('WCS-4'));
    assertScopedReads(requests.slice(before), 4);

    // Logging a check hands over to the existing check form.
    await page.getByTestId('site-controls-log-check').click();
    assert.deepEqual(await page.evaluate(() => window.controlsHarness.pushes), ['/checks/water']);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // ── FireTrack, opened without a site, then a site outside the department ────
  {
    const { page, errors, requests, text } = await open({ module: 'fire' });
    await page.getByTestId('site-controls-check-fire_walk').waitFor();
    assertScopedReads(requests, 4);
    const body = await text();
    assert.match(body, /FireTrack controls/);
    assert.match(body, /Ready for inspection/);
    assert.match(body, /5 of 5 inspection references in place/);
    assert.match(body, /FRA-2026-04/);
    assert.match(body, /1 Apr 2026/);
    assert.match(body, /Wales/);
    assert.match(body, /Not recorded/, 'unrecorded optional fields are shown as such');
    assert.equal(await page.getByTestId('control-field-nextReviewDate').locator('xpath=..').getByText('Due soon').count(), 1,
      'a review date within 30 days is flagged');
    const alarm = await page.getByTestId('site-controls-check-alarm').innerText();
    assert.match(alarm, /Weekly \(every 7 days\)/);
    assert.match(alarm, /Next due:/);
    assert.match(alarm, /Night Porter · Reception/);
    assert.match(await page.getByTestId('site-controls-check-fire_walk').innerText(), /Fire walk \(escape routes\)[\s\S]*Fortnightly \(every 14 days\)/);

    const before = requests.length;
    await page.getByTestId('site-controls-site-9').click();
    await page.getByTestId('site-controls-error').waitFor();
    assert.match(await page.getByTestId('site-controls-error').innerText(), /outside your department/);
    assert.doesNotMatch(await text(), /FRA-2026-04/, 'the previous site’s controls are not shown for a refused site');
    assertScopedReads(requests.slice(before), 9);
    assert.deepEqual(errors, []);
    await page.close();
  }

  console.log('Mounted mobile site controls regression passed: bearer-only scoped reads, control references, review dates, cadence beside history, plan state and department refusal.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
