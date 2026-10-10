import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import ts from 'typescript';

// Asset tag scanning on app/checks/pat.tsx: tag matching rules, then the
// mounted screen with the camera replaced by a stand-in that delivers scans.

const logicSource = await readFile(new URL('../components/pat-tag-logic.ts', import.meta.url), 'utf8');
const logicJs = ts.transpileModule(logicSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { matchAssetTag, normalizeAssetTag } = await import(`data:text/javascript,${encodeURIComponent(logicJs)}`);

const a = (id, tag, active = true) => ({ id, name: `Appliance ${id}`, active, asset_tag: tag });
const register = [a(1, 'PAT-0001'), a(2, 'pat 0002'), a(3, 'RET-9', false), a(4, 'DUP'), a(5, 'dup'), a(6, null), a(7, 'MIX'), a(8, 'MIX', false)];
assert.equal(normalizeAssetTag('  pat-0001\r\n'), 'PAT-0001');
assert.equal(normalizeAssetTag('PAT   0002'), 'PAT 0002');
assert.deepEqual(matchAssetTag(register, 'pat-0001\n'), { kind: 'match', tag: 'PAT-0001', appliance: register[0] });
assert.equal(matchAssetTag(register, 'PAT  0002').appliance.id, 2, 'internal spacing and case are ignored');
assert.deepEqual(matchAssetTag(register, 'ret-9'), { kind: 'retired', tag: 'RET-9', appliance: register[2] });
assert.deepEqual(matchAssetTag(register, 'Dup').appliances.map((x) => x.id), [4, 5]);
assert.equal(matchAssetTag(register, 'mix').appliance.id, 7, 'an active appliance wins over a retired one with the same tag');
assert.deepEqual(matchAssetTag(register, 'NOPE'), { kind: 'unknown', tag: 'NOPE' });
assert.deepEqual(matchAssetTag(register, '   '), { kind: 'empty' });
assert.equal(matchAssetTag(register, 'https://labels.example/assets/PAT-0001').appliance.id, 1, 'URL payload: last path segment');
assert.equal(matchAssetTag(register, 'https://labels.example/a?tag=pat%200002').appliance.id, 2, 'URL payload: tag query parameter');
assert.equal(matchAssetTag(register, 'javascript:PAT-0001').kind, 'unknown', 'only http(s) payloads are unpacked');
assert.deepEqual(matchAssetTag(register, 'https://labels.example/x/UNKNOWN'), { kind: 'unknown', tag: 'HTTPS://LABELS.EXAMPLE/X/UNKNOWN' });

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
    },
  }],
});
const html = '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? bundled.outputFiles[0].contents : html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const appliance = (id, name, tag, overrides = {}) => ({
  id, client_id: 23, site_id: 4, name, appliance_type: 'Class I', location: 'Kitchen', asset_tag: tag,
  description: null, active: true, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  last_test_date: null, last_result: null, next_test_date: null, last_tested_by: null,
  last_test_site_id: null, last_test_site_name: null, last_test_location: null, last_test_location_source: null, ...overrides,
});
const appliances = [
  appliance(11, 'Office kettle', 'PAT-0011'),
  appliance(12, 'Retired heater', 'PAT-0012', { active: false }),
  appliance(13, 'Bar fridge', 'PAT-0013'),
  appliance(14, 'Extension lead A', 'LEAD'),
  appliance(15, 'Extension lead B', 'LEAD'),
];
const posts = [];
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
    if (path === '/api/pat-track/appliances' && method === 'GET') return respond(appliances);
    if (path === '/api/pat-track/tests' && method === 'GET') return respond([]);
    if (path === '/api/pat-track/tests' && method === 'POST') {
      const body = request.postDataJSON();
      posts.push(body);
      return respond({ id: 900 + posts.length, applianceId: body.applianceId, testDate: body.testDate, result: body.result, snapshotSource: 'recorded' }, 201);
    }
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.harnessReady);
  await page.getByTestId('pat-appliance-11').waitFor();

  const modal = () => page.getByTestId('native-modal');
  const formName = () => modal().locator('span', { hasText: /^(Office kettle|Bar fridge|Extension lead [AB])$/ }).first().innerText();
  const scan = async (data) => {
    await page.waitForFunction(() => window.cameraHarness.scanning);
    return page.evaluate((value) => window.cameraHarness.scan(value), data);
  };
  const openScanner = async () => {
    await page.getByTestId('pat-scan-tag').click();
    await page.getByTestId('pat-scan-close').waitFor();
  };
  const closeForm = async () => {
    await page.getByTestId('pat-close-form').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="native-modal"]'));
  };

  // A scanned tag opens the matching appliance in the log form, and the test is logged against it.
  await openScanner();
  await page.waitForFunction(() => window.cameraHarness.scanning);
  assert.equal(await scan(' pat-0013\n'), true);
  await page.getByTestId('pat-submit-test').waitFor();
  assert.equal(await page.getByTestId('pat-scan-close').count(), 0, 'the scanner closes once a tag matches');
  assert.equal(await formName(), 'Bar fridge');
  await page.getByTestId('pat-submit-test').click();
  await page.waitForFunction(() => window.patHarness.alerts.some((x) => x.title === 'Logged'));
  assert.equal(posts.at(-1).applianceId, 13);

  // Unknown tag: explained in place, the camera pauses, and both recovery paths work.
  await openScanner();
  await scan('NOPE-404');
  await page.getByTestId('pat-scan-unknown').waitFor();
  assert.match(await page.getByTestId('pat-scan-unknown').innerText(), /NOPE-404[\s\S]*choose the appliance from the list/);
  assert.equal(await page.evaluate(() => window.cameraHarness.scanning), false, 'scanning pauses while the problem is shown');
  assert.equal(await page.evaluate(() => window.cameraHarness.scan('PAT-0011')), false);
  await page.getByTestId('pat-scan-again').click();
  await page.waitForFunction(() => window.cameraHarness.scanning);
  assert.equal(await page.getByTestId('pat-scan-unknown').count(), 0);
  await scan('ALSO-UNKNOWN');
  await page.getByTestId('pat-scan-unknown').waitFor();
  await page.getByTestId('pat-scan-use-list').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="native-modal"]'));
  // Manual selection still works after backing out of the scanner.
  await page.getByTestId('pat-appliance-11').click();
  assert.equal(await formName(), 'Office kettle');
  await closeForm();

  // A retired appliance's tag is reported, not opened.
  await openScanner();
  await scan('PAT-0012');
  await page.getByTestId('pat-scan-retired').waitFor();
  assert.match(await page.getByTestId('pat-scan-retired').innerText(), /Retired heater, which is retired[\s\S]*Reactivate it on the web app/);
  assert.equal(await page.getByTestId('pat-submit-test').count(), 0);
  await page.getByTestId('pat-scan-close').click();

  // A tag shared by several active appliances asks which one is being tested.
  await openScanner();
  await scan('lead');
  await page.getByTestId('pat-scan-multiple').waitFor();
  await page.getByTestId('pat-scan-choose-15').click();
  await page.getByTestId('pat-submit-test').waitFor();
  assert.equal(await formName(), 'Extension lead B');
  await closeForm();

  // Camera not yet allowed: the scanner asks, and scanning starts once granted.
  await page.evaluate(() => {
    window.cameraHarness.setPermission({ granted: false, canAskAgain: true, status: 'undetermined' });
    window.cameraHarness.setRequestResult({ granted: true, canAskAgain: true, status: 'granted' });
  });
  await openScanner();
  await page.getByTestId('pat-scan-permission').waitFor();
  assert.equal(await page.evaluate(() => window.cameraHarness.mounted), false, 'no camera without permission');
  await page.getByTestId('pat-scan-allow-camera').click();
  await page.waitForFunction(() => window.cameraHarness.scanning);
  assert.equal(await page.evaluate(() => window.cameraHarness.requests), 1);
  await page.getByTestId('pat-scan-close').click();

  // Camera permanently denied: Settings is offered, and typing the tag still opens the appliance.
  await page.evaluate(() => {
    window.cameraHarness.setPlatform('android');
    window.cameraHarness.setPermission({ granted: false, canAskAgain: false, status: 'denied' });
  });
  await openScanner();
  await page.getByTestId('pat-scan-permission').waitFor();
  assert.match(await page.getByTestId('pat-scan-permission').innerText(), /turned off for ComplyTrack/);
  assert.equal(await page.getByTestId('pat-scan-allow-camera').count(), 0, 'the OS will not prompt again, so no Allow button');
  await page.getByTestId('pat-scan-open-settings').click();
  assert.equal(await page.evaluate(() => window.cameraHarness.openedSettings), 1);
  await page.getByTestId('pat-scan-typed-tag').fill('PAT-0011');
  await page.getByTestId('pat-scan-find').click();
  await page.getByTestId('pat-submit-test').waitFor();
  assert.equal(await formName(), 'Office kettle');
  await closeForm();

  // Denied in a browser: no Settings button, the typed tag remains the way in.
  await page.evaluate(() => window.cameraHarness.setPlatform('web'));
  await openScanner();
  assert.match(await page.getByTestId('pat-scan-permission').innerText(), /blocked in this browser/);
  assert.equal(await page.getByTestId('pat-scan-open-settings').count(), 0);
  await page.getByTestId('pat-scan-typed-tag').fill('unknown-tag');
  await page.getByTestId('pat-scan-find').click();
  await page.getByTestId('pat-scan-unknown').waitFor();
  assert.match(await page.getByTestId('pat-scan-again').innerText(), /Try another tag/);
  await page.getByTestId('pat-scan-again').click();
  await page.getByTestId('pat-scan-typed-tag').waitFor();
  assert.equal(await page.getByTestId('pat-scan-typed-tag').inputValue(), '');

  assert.deepEqual(errors, []);
  console.log('PAT asset tag scanning passed: tag matching, scan to log form, unknown/retired/shared tags, permission prompt, denied camera with Settings and typed-tag fallback, manual selection.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
