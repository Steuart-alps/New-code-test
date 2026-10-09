import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import ts from 'typescript';

// Keep the test harness honest about production provider wiring. The mounted
// tests below then exercise the real components with one shared QueryClient.
const layout = await readFile(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('_layout.tsx', layout, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function containsAuth(node) {
  let found = ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'AuthProvider';
  ts.forEachChild(node, child => { if (containsAuth(child)) found = true; });
  return found;
}
let sharedProvider = false;
function inspect(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'QueryClientProvider') {
    sharedProvider ||= containsAuth(node);
    assert.match(node.openingElement.getText(tree), /client=\{queryClient\}/);
  }
  ts.forEachChild(node, inspect);
}
inspect(tree);
assert.ok(sharedProvider, 'production AuthProvider must be inside the shared QueryClientProvider');

const nativePath = fileURLToPath(new URL('./fixtures/auth-cache-native.jsx', import.meta.url));
const withoutClear = process.argv.includes('--without-cache-clear');
const withoutClientKey = process.argv.includes('--without-client-key');
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/auth-cache-entry.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"test"', 'process.env.EXPO_PUBLIC_DOMAIN': '"mobile-cache.test"' },
  plugins: [{
    name: 'native-test-io',
    setup(builder) {
      builder.onResolve({ filter: /^(react-native|react-native-safe-area-context|@expo\/vector-icons|expo-router|expo-haptics|expo-secure-store)$/ }, () => ({ path: nativePath }));
      builder.onResolve({ filter: /^\.\/(kitchenOutbox|fixTrackRecovery|push)$/ }, args =>
        args.importer.endsWith('/lib/auth.tsx') ? { path: nativePath } : undefined);
      // Optional negative controls prove these are behavior tests, not merely
      // assertions over the mocked native I/O. Never modify production files.
      if (withoutClear) builder.onLoad({ filter: /\/lib\/auth\.tsx$/ }, async args => {
        const contents = await readFile(args.path, 'utf8');
        assert.ok(contents.includes('if (!t) queryClient.clear();'));
        return { contents: contents.replace('if (!t) queryClient.clear();', ''), loader: 'tsx' };
      });
      if (withoutClientKey) builder.onLoad({ filter: /\/app\/checks\/incident\.tsx$/ }, async args => {
        const contents = await readFile(args.path, 'utf8');
        assert.ok(contents.includes("['incidents', user?.clientId]"));
        return { contents: contents.replaceAll("['incidents', user?.clientId]", "['incidents']"), loader: 'tsx' };
      });
    },
  }],
});
const html = '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? bundled.outputFiles[0].contents : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const pending = [];
async function awaitPending() {
  const deadline = Date.now() + 10_000;
  while (!pending.length) {
    assert.ok(Date.now() < deadline, 'expected the held private response within 10 seconds');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
try {
  browser = await chromium.launch({
    headless: true, args: ['--no-sandbox'],
    executablePath: process.env.CHROMIUM_PATH,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  let holdClientB = true, rejectLogout = false, revokeClientB = false;
  await page.route('https://mobile-cache.test/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = request.headers(), clientId = Number(headers.authorization?.replace('Bearer account-', ''));
    requests.push({ path, clientId, method: request.method() });
    const respond = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' },
      body: JSON.stringify(data),
    });
    if (request.method() === 'OPTIONS') return respond({});
    if (path === '/api/auth/mobile-login') {
      const { email, password } = request.postDataJSON();
      assert.equal(password, 'test-only-password');
      const id = email === 'first@example.test' ? 11 : 22;
      return respond({ token: `account-${id}`, expiresAt: '2099-01-01T00:00:00Z',
        user: { id, clientId: id, name: `Test account ${id}`, email, role: 'client_staff' } });
    }
    if (!clientId || (clientId === 22 && revokeClientB)) return respond({ error: 'Unauthorized' }, 401);
    if (path === '/api/auth/me') return respond({
      user: { id: clientId, clientId, name: `Test account ${clientId}`, email: 'test@example.test', role: 'client_staff' },
      services: ['incidenttrack'],
    });
    if (path === '/api/auth/mobile-logout') {
      if (rejectLogout) return route.abort('failed');
      return respond({});
    }
    const marker = clientId === 11 ? 'ALPHA_PRIVATE' : 'BRAVO_PRIVATE';
    if (path === '/api/sites') return respond([{ id: clientId, name: `${marker} SITE` }]);
    if (path === '/api/form-options') return respond({ options: { incident_types: ['accident'] } });
    const incident = [{ id: clientId, incidentType: 'accident', severity: 'minor', incidentDate: '2026-10-02',
      location: `${marker} LOCATION`, involvedName: `${marker} PERSON`, status: 'open', riddorReportable: false }];
    if (path === '/api/delayed' || (path === '/api/incidents' && clientId === 22 && holdClientB)) {
      return new Promise(resolve => pending.push(async () => { await respond(incident); resolve(); }));
    }
    if (path === '/api/incidents') return respond(incident);
    throw new Error(`Unexpected fixture request ${path}`);
  });
  const snapshot = () => page.evaluate(() => window.cacheHarness.snapshot());
  const rendered = () => page.locator('body').innerText();
  const assertNoAlpha = async () => {
    assert.ok(!(await rendered()).includes('ALPHA_PRIVATE'), 'previous account data must not be rendered');
    assert.ok(!JSON.stringify(await snapshot()).includes('ALPHA_PRIVATE'), 'previous account query/mutation data must not be available');
  };
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.harnessReady && !window.cacheHarness.auth.isLoading);
  await page.evaluate(() => window.cacheHarness.auth.login('first@example.test', 'test-only-password'));
  await page.getByText('ALPHA_PRIVATE LOCATION · ALPHA_PRIVATE PERSON', { exact: true }).waitFor();
  await page.evaluate(() => window.cacheHarness.seedOtherModules('ALPHA_PRIVATE OTHER_MODULE'));
  assert.ok((await snapshot()).queries.some(query => JSON.stringify(query.key) === '["incidents",11]'),
    'incident query key includes the signed-in client id');
  assert.equal((await snapshot()).mutations.length, 1);
  // Leave an uncancellable HTTP response in flight, then remove its query.
  await page.evaluate(() => { void window.cacheHarness.delayedQuery(); });
  await page.waitForFunction(() => window.cacheHarness.client.isFetching({ queryKey: ['delayed-private-record', 11] }) === 1);
  await awaitPending();
  await page.evaluate(() => window.cacheHarness.auth.logout());
  await page.getByTestId('account').getByText('Signed out', { exact: true }).waitFor();
  assert.deepEqual(await snapshot(), { queries: [], mutations: [] }, 'logout must clear the entire shared cache, not only incidents');
  assert.equal(await page.evaluate(() => window.cacheHarness.secureStore.size), 0);
  await assertNoAlpha();
  await page.evaluate(() => window.cacheHarness.auth.login('second@example.test', 'test-only-password'));
  await page.getByTestId('account').getByText('Account 22', { exact: true }).waitFor();
  await assertNoAlpha(); // B's incidents are still loading.
  assert.ok((await snapshot()).queries.some(query => JSON.stringify(query.key) === '["incidents",22]'));
  // A's old HTTP response arrives while B is signed in and loading incidents.
  // Removal must prevent it recreating a private query for the former account.
  await pending.shift()();
  await page.waitForTimeout(50);
  await assertNoAlpha();
  assert.ok(!(await snapshot()).queries.some(query => query.key.includes(11)));
  await awaitPending();
  holdClientB = false;
  await pending.shift()();
  await page.getByText('BRAVO_PRIVATE LOCATION · BRAVO_PRIVATE PERSON', { exact: true }).waitFor();
  await assertNoAlpha();
  assert.ok(requests.some(req => req.path === '/api/incidents' && req.clientId === 11));
  assert.ok(requests.some(req => req.path === '/api/incidents' && req.clientId === 22));
  // Definitively expired foreground sessions use the same global clearing path.
  revokeClientB = true;
  await page.evaluate(() => {
    window.cacheHarness.secureStore.set('complytrack_mobile_token_expiry', '2000-01-01T00:00:00Z');
    window.cacheHarness.foreground();
  });
  await page.getByTestId('account').getByText('Signed out', { exact: true }).waitFor();
  assert.deepEqual(await snapshot(), { queries: [], mutations: [] });
  assert.ok(requests.some(req => req.path === '/api/auth/mobile-refresh' && req.clientId === 22),
    'foreground revalidation must exercise an actual expired-session 401');
  revokeClientB = false;
  await page.evaluate(() => window.cacheHarness.auth.login('second@example.test', 'test-only-password'));
  await page.getByText('BRAVO_PRIVATE LOCATION · BRAVO_PRIVATE PERSON', { exact: true }).waitFor();
  rejectLogout = true;
  await page.evaluate(() => window.cacheHarness.auth.logout());
  await page.getByTestId('account').getByText('Signed out', { exact: true }).waitFor();
  assert.deepEqual(await snapshot(), { queries: [], mutations: [] }, 'offline server logout must still remove local private records');
  assert.ok(!(await rendered()).includes('BRAVO_PRIVATE'));
  assert.deepEqual(errors, []);
  console.log('Mounted mobile auth/incident regression passed: A → logout → B, global query/mutation removal, scoped incident keys, late A response, 401 expiry and offline logout.');
} finally {
  for (const resume of pending.splice(0)) await resume().catch(() => {});
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}