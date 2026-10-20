import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Mounted regression for lib/auth.tsx with the production AuthProvider and
// apiFetch (only device I/O is substituted):
// - no signal at launch with a stored token opens the last validated account
//   offline instead of the login screen, and re-validates on reconnect;
// - a 401 while signed in (apiFetch or the generated client) signs out and
//   clears the stored token and saved account;
// - a 401 at launch never falls back to the saved account.
const nativePath = fileURLToPath(new URL('./fixtures/auth-cache-native.jsx', import.meta.url));
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/auth-offline-entry.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"test"', 'process.env.EXPO_PUBLIC_DOMAIN': '"mobile-cache.test"' },
  plugins: [{
    name: 'native-test-io',
    setup(builder) {
      builder.onResolve({ filter: /^(react-native|react-native-safe-area-context|@expo\/vector-icons|expo-router|expo-haptics|expo-secure-store)$/ }, () => ({ path: nativePath }));
      builder.onResolve({ filter: /^\.\/(kitchenOutbox|checkOutbox|fixTrackRecovery|push)$/ }, (args) =>
        args.importer.endsWith('/lib/auth.tsx') ? { path: nativePath } : undefined);
    },
  }],
});
const html = '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? bundled.outputFiles[0].contents : html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const cached = (clientId) => JSON.stringify({
  version: 1,
  user: { id: clientId, clientId, name: `Saved account ${clientId}`, email: 'saved@example.test', role: 'client_staff' },
  services: ['dailytrack_am'],
  savedAt: '2026-10-11T08:00:00.000Z',
});
const seeded = (clientId) => ({
  complytrack_mobile_token: `account-${clientId}`,
  complytrack_mobile_token_expiry: '2099-01-01T00:00:00Z',
  complytrack_mobile_user_cache: cached(clientId),
});

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROMIUM_PATH });

  async function start(seed, network) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const requests = [];
    await page.route('https://mobile-cache.test/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const token = request.headers().authorization?.replace('Bearer ', '');
      // The generated client sends credentials, so CORS needs the exact origin.
      const cors = {
        'Access-Control-Allow-Origin': `http://127.0.0.1:${server.address().port}`,
        'Access-Control-Allow-Credentials': 'true',
      };
      if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...cors, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE' } });
      }
      requests.push({ path, token });
      const result = network(path, token);
      if (result === 'offline') return route.abort('internetdisconnected');
      return route.fulfill({
        status: result.status ?? 200, contentType: 'application/json',
        headers: cors,
        body: JSON.stringify(result.body ?? {}),
      });
    });
    await page.addInitScript((value) => { window.__seedSecureStore = value; }, seed);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.harnessReady && !window.offlineHarness.auth.isLoading);
    const account = () => page.getByTestId('account').innerText();
    const store = () => page.evaluate(() => Object.fromEntries(window.offlineHarness.secureStore));
    return { page, errors, requests, account, store };
  }

  // 1. No signal at launch: the saved account opens offline (not the login screen).
  let online = false;
  const me = (token) => ({ body: { user: { id: 11, clientId: 11, name: 'Fresh account 11', email: 'a@example.test', role: 'client_staff' }, services: ['incidenttrack'] } });
  const a = await start(seeded(11), (path, token) => {
    if (!online) return 'offline';
    if (token !== 'account-11') return { status: 401, body: { error: 'Unauthorized' } };
    if (path === '/api/auth/me') return me(token);
    if (path === '/api/auth/mobile-refresh') return { body: { token: 'account-11', expiresAt: '2099-01-01T00:00:00Z' } };
    if (path === '/api/sites') return { status: 401, body: { error: 'Session expired' } };
    return { body: {} };
  });
  assert.equal(await a.account(), 'Account 11 (offline) services:["dailytrack_am"]');
  assert.equal((await a.store()).complytrack_mobile_token, 'account-11', 'the token is kept for reconnection');

  // 2. Signal returns: foregrounding re-validates and leaves the offline state.
  online = true;
  await a.page.evaluate(() => window.offlineHarness.foreground());
  await a.page.getByTestId('account').getByText('Account 11 services:["incidenttrack"]', { exact: true }).waitFor();
  assert.match((await a.store()).complytrack_mobile_user_cache, /Fresh account 11/, 'the saved account is refreshed after validation');

  // 3. A 401 on an apiFetch request with the session bearer signs out.
  assert.equal(await a.page.evaluate(() => window.offlineHarness.apiSites()), 'error 401');
  await a.page.getByTestId('account').getByText('Signed out', { exact: true }).waitFor();
  await a.page.waitForFunction(() => window.offlineHarness.secureStore.size === 0);
  assert.deepEqual(a.errors, []);
  await a.page.close();

  // 4. A 401 from the generated API client signs out too.
  const b = await start(seeded(22), (path) => {
    if (path === '/api/auth/me') return { body: { user: { id: 22, clientId: 22, name: 'B', email: 'b@example.test', role: 'client_staff' }, services: 'all' } };
    if (path === '/api/auth/mobile-refresh') return { body: { token: 'account-22', expiresAt: '2099-01-01T00:00:00Z' } };
    if (path === '/api/sites') return { status: 401, body: { error: 'Session revoked' } };
    return { body: {} };
  });
  assert.equal(await b.account(), 'Account 22 services:"all"');
  assert.match(await b.page.evaluate(() => window.offlineHarness.generatedSites()), /^error/);
  await b.page.getByTestId('account').getByText('Signed out', { exact: true }).waitFor();
  await b.page.waitForFunction(() => window.offlineHarness.secureStore.size === 0);
  assert.deepEqual(b.errors, []);
  await b.page.close();

  // 5. A revoked session at launch signs out; the saved account is not used.
  const c = await start(seeded(33), () => ({ status: 401, body: { error: 'Unauthorized' } }));
  assert.equal(await c.account(), 'Signed out');
  await c.page.waitForFunction(() => window.offlineHarness.secureStore.size === 0);
  await c.page.close();

  // 6. Offline with a token but no saved account: login screen, token kept.
  const d = await start({ complytrack_mobile_token: 'account-44', complytrack_mobile_token_expiry: '2099-01-01T00:00:00Z' }, () => 'offline');
  assert.equal(await d.account(), 'Signed out');
  assert.equal((await d.store()).complytrack_mobile_token, 'account-44');
  await d.page.close();

  console.log('Mounted mobile offline auth regression passed: offline launch with saved account, reconnect re-validation, 401 sign-out from apiFetch and generated client, launch 401 ignores saved account, no saved account stays signed out.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
