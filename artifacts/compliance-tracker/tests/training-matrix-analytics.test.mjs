import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { assertAnalyticsRequests, bundleDefine, captureAnalytics, flush } from "./analytics-capture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(os.tmpdir(), "training-matrix-analytics-"));
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
try {
  const output = path.join(dir, "analytics.mjs");
  await build({
    entryPoints: [path.join(root, "src/lib/analytics.ts")],
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    define: bundleDefine,
  });
  const { trackTrainingMatrixDownload, trackInspectionPdfDownload } = await import(pathToFileURL(output).href);

  // No browser: nothing is sent.
  let capture = captureAnalytics();
  delete globalThis.window;
  assert.doesNotThrow(() => trackTrainingMatrixDownload("all"));
  await flush();
  assert.deepEqual(capture.events, [], "no request outside a browser");

  globalThis.window = {};
  trackTrainingMatrixDownload("all");
  trackTrainingMatrixDownload("123");
  trackTrainingMatrixDownload('Site "Name", staff and certificates');
  await flush();
  assert.deepEqual(capture.events, [
    ["training_matrix_download_started", { site_scope: "all_sites" }],
    ["training_matrix_download_started", { site_scope: "selected_site" }],
    ["training_matrix_download_started", { site_scope: "selected_site" }],
  ], "only the fixed, non-sensitive scope dimension may be sent");
  assertAnalyticsRequests(capture.requests);

  // The HotTubTrack PDF helper (for the queued download event) only ever
  // sends the fixed module and the two enum scopes.
  capture = captureAnalytics();
  trackInspectionPdfDownload({ siteScope: "all_sites", recordScope: "has_records" });
  trackInspectionPdfDownload({ siteScope: "selected_site", recordScope: "empty" });
  trackInspectionPdfDownload({ siteScope: "Site 12 Spa", recordScope: "3 records" });
  await flush();
  assert.deepEqual(capture.events, [
    ["inspection_pdf_download_started", { module: "hottubtrack", site_scope: "all_sites", record_scope: "has_records" }],
    ["inspection_pdf_download_started", { module: "hottubtrack", site_scope: "selected_site", record_scope: "empty" }],
    ["inspection_pdf_download_started", { module: "hottubtrack", site_scope: "selected_site", record_scope: "has_records" }],
  ], "unexpected input collapses to the enum values, never free text");

  // Missing endpoint (older API), a synchronous fetch error and a rejected
  // request must all stay harmless; an unhandled rejection fails this process.
  for (const respond of [
    () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    () => { throw new Error("fetch failed synchronously"); },
    () => Promise.reject(new Error("network failed")),
  ]) {
    capture = captureAnalytics(respond);
    assert.doesNotThrow(() => trackTrainingMatrixDownload("all"));
    await flush();
    assert.equal(capture.events.length, 1);
  }

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
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}