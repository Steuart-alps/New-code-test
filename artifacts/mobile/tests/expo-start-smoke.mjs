import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

// Startup smoke check for the Expo Go workflow (`pnpm run dev`): starts the
// same `expo start` the dev script runs, waits for Metro, asks the dev server
// for the manifest Expo Go loads when the QR code is scanned, and fails on
// known fatal native-tool errors (missing shared libraries and the like) that
// typecheck and production exports never surface. No EAS, prebuild or
// development build. Run it after Expo CLI, Node or system package changes:
//   pnpm --filter @workspace/mobile run test:expo-start
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const STARTUP_TIMEOUT_MS = Number(process.env.EXPO_SMOKE_TIMEOUT_MS ?? 120_000);

// Output that means a native tool or runtime dependency is broken.
const FATAL = [
  /error while loading shared libraries/i,
  /cannot open shared object file/i,
  /GLIBC_[\d.]+' not found/,
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /Segmentation fault/i,
  /Failed to start (?:the )?(?:Metro|dev server)/i,
  /CommandError/,
];
// Optional React Native DevTools shell: it cannot launch as root or without a
// display, which is an environment limit, not an app regression. A missing
// library is still caught by FATAL above, since its details are printed too.
const ENVIRONMENT_ONLY = [/Running as root without --no-sandbox is not supported/];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = await freePort();
let output = '';
const child = spawn('pnpm', ['exec', 'expo', 'start', '--port', String(port), '--offline'], {
  cwd: projectRoot,
  env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
const collect = (chunk) => { output += chunk.toString(); };
child.stdout.on('data', collect);
child.stderr.on('data', collect);
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

function stop() {
  if (exited) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
}
process.on('exit', stop);

async function get(path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, text: await res.text() };
}

try {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let status = null;
  while (Date.now() < deadline && !exited) {
    try {
      status = await get('/status');
      if (status.text.includes('packager-status:running')) break;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(!exited, `expo start exited early (${JSON.stringify(exited)}):\n${output}`);
  assert.ok(status?.text.includes('packager-status:running'), `Metro did not report running within ${STARTUP_TIMEOUT_MS} ms:\n${output}`);
  assert.match(output, /Waiting on http:\/\/localhost:\d+/, 'expo start announces the dev server address');

  // The request Expo Go makes after scanning the QR code (exp://host:port).
  const manifest = await get('/', { 'expo-platform': 'ios', accept: 'application/expo+json,application/json' });
  assert.equal(manifest.status, 200, `manifest request failed (${manifest.status}): ${manifest.text.slice(0, 500)}`);
  const body = JSON.parse(manifest.text);
  const launchUrl = body.launchAsset?.url ?? body.bundleUrl;
  assert.ok(launchUrl && /\.bundle\?|\/index\.bundle|platform=ios/.test(launchUrl), `manifest has no iOS bundle URL: ${manifest.text.slice(0, 500)}`);
  const expoConfig = body.extra?.expoClient ?? body;
  assert.ok(expoConfig.sdkVersion?.startsWith('57.') || body.runtimeVersion || expoConfig.slug,
    `manifest does not describe the app: ${manifest.text.slice(0, 300)}`);

  // Give tools that start lazily (DevTools shell, watchers) a moment to report.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const fatal = FATAL.filter((pattern) => pattern.test(output));
  assert.deepEqual(fatal.map(String), [], `fatal startup output:\n${output}`);
  const notes = ENVIRONMENT_ONLY.filter((pattern) => pattern.test(output));
  for (const note of notes) console.log(`note: ignored environment-only message matching ${note}`);

  console.log(`Expo startup smoke check passed: Metro running on port ${port}, Expo Go manifest served (exp://127.0.0.1:${port}), no fatal native-tool errors.`);
} finally {
  stop();
}
