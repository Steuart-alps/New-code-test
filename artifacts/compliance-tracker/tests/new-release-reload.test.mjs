import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// A tab opened before a release asks for page files the release removed
// (src/lib/new-release-reload.ts): those failures are recognised in each
// browser's wording, and the page reloads once, not in a loop.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "new-release-reload-"));
try {
  const bundle = path.join(dir, "new-release-reload.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/new-release-reload.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent",
  });
  const { isChunkLoadError, reloadForNewRelease, isReloadingForNewRelease, resetNewReleaseReloadForTests } =
    await import(pathToFileURL(bundle).href);

  // Each browser's wording for a page file that cannot load.
  for (const message of [
    "'text/html' is not a valid JavaScript MIME type.", // Safari, file answered with HTML
    "Importing a module script failed.", // Safari
    "Failed to fetch dynamically imported module: https://example.test/assets/calendar-abc123.js", // Chrome
    "error loading dynamically imported module: https://example.test/assets/calendar-abc123.js", // Firefox
    "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\".",
    "Unable to preload CSS for /assets/calendar-abc123.css", // Vite
  ]) {
    assert.equal(isChunkLoadError(new Error(message)), true, message);
  }
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(isChunkLoadError(undefined), false);

  function fakeEnv({ online = true, storage = new Map() } = {}) {
    let clock = 1_000_000;
    const env = {
      reloads: 0,
      storage: storage && {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => void storage.set(key, value),
      },
      reload: () => { env.reloads += 1; },
      now: () => clock,
      online: () => online,
      advance: (ms) => { clock += ms; },
    };
    return env;
  }

  // First failure reloads; a second failure straight after the reload (the
  // in-memory flag is reset by the reload) shows the error page instead.
  const store = new Map();
  const env = fakeEnv({ storage: store });
  assert.equal(reloadForNewRelease(env), true);
  assert.equal(env.reloads, 1);
  assert.equal(isReloadingForNewRelease(), true);
  assert.equal(reloadForNewRelease(env), true, "a second failure before the reload finishes waits for it");
  assert.equal(env.reloads, 1, "only one reload is started");
  resetNewReleaseReloadForTests();
  env.advance(5_000);
  assert.equal(reloadForNewRelease(env), false, "no reload loop");
  assert.equal(env.reloads, 1);

  // A later release, well after the last automatic reload, reloads again.
  env.advance(60_000);
  assert.equal(reloadForNewRelease(env), true);
  assert.equal(env.reloads, 2);
  resetNewReleaseReloadForTests();

  // Offline, or with no session storage to record the reload, it never reloads.
  const offline = fakeEnv({ online: false });
  assert.equal(reloadForNewRelease(offline), false);
  assert.equal(offline.reloads, 0);
  const noStorage = fakeEnv({ storage: null });
  assert.equal(reloadForNewRelease(noStorage), false);
  assert.equal(noStorage.reloads, 0);
  const throwing = fakeEnv();
  throwing.storage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.equal(reloadForNewRelease(throwing), false);
  assert.equal(throwing.reloads, 0);
  assert.equal(isReloadingForNewRelease(), false);

  console.log("new-release-reload: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
