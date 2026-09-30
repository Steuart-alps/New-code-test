import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "training-matrix-analytics-"));
const originalWindow = globalThis.window;
try {
  const output = path.join(dir, "analytics.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/analytics.ts")],
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
  });
  const { trackTrainingMatrixDownload } = await import(pathToFileURL(output).href);

  delete globalThis.window;
  assert.doesNotThrow(() => trackTrainingMatrixDownload("all"));
  globalThis.window = {};
  assert.doesNotThrow(() => trackTrainingMatrixDownload("123"));

  const events = [];
  globalThis.window = { umami: { track: (...args) => events.push(args) } };
  trackTrainingMatrixDownload("all");
  trackTrainingMatrixDownload("123");
  trackTrainingMatrixDownload('Site "Name", staff and certificates');
  assert.deepEqual(events, [
    ["training_matrix_download_started", { site_scope: "all_sites" }],
    ["training_matrix_download_started", { site_scope: "selected_site" }],
    ["training_matrix_download_started", { site_scope: "selected_site" }],
  ], "only the fixed, non-sensitive scope dimension may be sent");

  globalThis.window = { umami: { track: () => { throw new Error("tracker failed"); } } };
  assert.doesNotThrow(() => trackTrainingMatrixDownload("all"));
  globalThis.window = { umami: { track: () => Promise.reject(new Error("network failed")) } };
  assert.doesNotThrow(() => trackTrainingMatrixDownload("all"));
  // Allow rejection handling to run; an unhandled rejection fails this process.
  await new Promise(resolve => setImmediate(resolve));

  const page = await readFile(path.join(root, "src/pages/train-track.tsx"), "utf8");
  const handler = page.slice(
    page.indexOf("function handleDownloadMatrix()"),
    page.indexOf('toast({ title: "Training matrix downloaded" })'),
  );
  const event = handler.indexOf("trackTrainingMatrixDownload(siteFilter)");
  assert.ok(event > handler.indexOf("link.click();"), "track only after the click starts the download");
  assert.ok(handler.indexOf("link.click();") > handler.indexOf("return;"),
    "empty exports must return before the download and tracking");
  assert.equal(handler.match(/trackTrainingMatrixDownload\(/g)?.length, 1,
    "one download must emit only one custom event");
  assert.ok(event < handler.indexOf("link.remove();"), "tracking must not depend on later cleanup");
  console.log("Training matrix analytics privacy and failure checks passed.");
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  await rm(dir, { recursive: true, force: true });
}