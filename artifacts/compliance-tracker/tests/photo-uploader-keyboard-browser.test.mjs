// Keyboard and screen-reader coverage for CheckPhotoUploader in a real
// browser (Chromium via Playwright), in both the full and compact layouts.
//
// The real component is mounted by tests/browser/photo-uploader.harness.tsx
// and built with the app's React and Tailwind setup, so visibility rules
// (hidden inputs, hover-only overlays) are the production CSS. API and
// storage requests are intercepted with realistic response shapes; nothing
// is uploaded anywhere.
//
// Run with: pnpm --filter @workspace/compliance-tracker run test:photo-uploader-keyboard-browser
// (CHROMIUM_PATH selects the browser binary, as in photo-upload-browser.test.mjs).
//
// Page-level upload flows live in photo-upload-browser.test.mjs; this suite
// covers the component's keyboard and screen-reader contract.
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = path.join(root, "tests", "browser");
// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let passed = 0;
const failures = [];
async function test(name, run) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try {
    await run();
    passed++;
  } catch (err) {
    failures.push(name);
    console.error(`FAIL: ${name}\n  ${err?.message?.split("\n").slice(0, 6).join("\n  ")}`);
  }
}

async function buildHarness() {
  const outDir = await mkdtemp(path.join(harnessDir, ".dist-"));
  await build({
    configFile: false,
    // The package root, as in the app build, so Tailwind scans src/ exactly
    // as it does in production.
    root,
    base: "./",
    logLevel: "error",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        // Only the signed-in context is stubbed; the uploader's API hooks are real.
        { find: "@/context/auth-context", replacement: path.join(harnessDir, "auth-context.stub.ts") },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(harnessDir, "photo-uploader.html") } },
  });
  return outDir;
}

function serve(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(dir, decodeURIComponent(url.pathname));
    if (!file.startsWith(dir)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** In-memory photo API with the server's snake_case response shape. */
function mockApi(page, initial) {
  const state = { photos: initial.map((p) => ({ ...p })), nextId: 900, requests: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  // Predicate matchers: glob semantics for trailing "**" differ between
  // Playwright versions.
  const apiPath = (prefix) => (url) => url.pathname.includes(prefix);
  page.route(apiPath("/api/auth/csrf-token"), (route) => json(route, 200, { token: "harness-csrf" }));
  page.route(apiPath("/api/storage/"), (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  page.route("https://storage.test/**", (route) => {
    state.requests.push({ method: route.request().method(), url: route.request().url() });
    return route.fulfill({ status: 200, body: "" });
  });
  page.route(apiPath("/api/photos"), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    // The app resolves its API relative to the page; record the /api/... path.
    const apiPath = url.pathname.slice(url.pathname.indexOf("/api/"));
    state.requests.push({ method, path: apiPath, body: request.postData(), csrf: request.headers()["x-csrf-token"] ?? null });
    if (method === "GET" && url.pathname.endsWith("/api/photos")) {
      assert.equal(url.searchParams.get("entityType"), "fire_safety_check");
      assert.equal(url.searchParams.get("entityId"), "41");
      return json(route, 200, state.photos);
    }
    if (method === "POST" && url.pathname.endsWith("/api/photos/request-upload")) {
      const id = state.nextId++;
      return json(route, 200, { uploadUrl: `https://storage.test/upload/${id}`, objectPath: `/objects/uploads/${id}` });
    }
    if (method === "POST" && url.pathname.endsWith("/api/photos")) {
      const body = JSON.parse(request.postData());
      const id = state.nextId++;
      state.photos.push({ id, entity_type: body.entityType, entity_id: body.entityId, object_path: body.objectPath, caption: null, created_at: new Date().toISOString() });
      return json(route, 201, { id });
    }
    const del = url.pathname.match(/\/api\/photos\/(\d+)$/);
    if (method === "DELETE" && del) {
      state.photos = state.photos.filter((p) => p.id !== Number(del[1]));
      return json(route, 200, { ok: true });
    }
    return json(route, 404, { error: "unexpected" });
  });
  return state;
}

const fixturePhotos = () => [1, 2].map((id) => ({
  id, entity_type: "fire_safety_check", entity_id: 41, object_path: `/objects/uploads/fixture-${id}`, caption: null, created_at: "2026-10-01T09:00:00Z",
}));

/** Accessible names of everything reached by Tab from #before to #after. */
async function tabSequence(page) {
  await page.focus("#before");
  const names = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.id === "after" ? null : (el?.getAttribute("aria-label") || el?.textContent?.trim() || el?.tagName);
    });
    if (name === null) return names;
    names.push(name);
  }
  throw new Error("Tab never reached the element after the uploader");
}

const focusedName = (page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim());
async function tabTo(page, name) {
  await page.focus("#before");
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    if (await focusedName(page) === name) return;
  }
  throw new Error(`Could not Tab to "${name}"`);
}

async function main() {
  const outDir = await buildHarness();
  const server = await serve(outDir);
  const base = `http://127.0.0.1:${server.address().port}/tests/browser/photo-uploader.html`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium" });
  const open = async (query, photos = fixturePhotos()) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000); // a missing control fails fast instead of hanging
    if (process.env.DEBUG_BROWSER) page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
    // Enable file-chooser interception before any key press: Playwright turns
    // it on asynchronously when the first listener is added, so a listener
    // added in the same tick as the key press can miss the chooser.
    page.on("filechooser", () => {});
    const state = mockApi(page, photos);
    await page.goto(`${base}${query}`);
    await page.getByRole("button", { name: /View photo 1 of/ }).first().waitFor();
    return { page, state };
  };
  const mutations = (state) => state.requests.filter((r) => r.method !== "GET");

  try {
    for (const layout of [{ label: "full", query: "?", add: "Add Photo" }, { label: "compact", query: "?compact=1", add: "Add photo" }]) {
      await test(`${layout.label}: every control is named and reachable by Tab, in order`, async () => {
        const { page } = await open(layout.query);
        const sequence = await tabSequence(page);
        const expected = layout.label === "full"
          ? [layout.add, "View photo 1 of 2", "Remove photo 1 of 2", "View photo 2 of 2", "Remove photo 2 of 2"]
          : ["View photo 1 of 2", "Remove photo 1 of 2", "View photo 2 of 2", "Remove photo 2 of 2", layout.add];
        assert.deepEqual(sequence, expected);
        assert.equal(await page.locator('input[type="file"]').evaluate((el) => el.tabIndex), -1, "the file input itself is not a Tab stop");
        await page.close();
      });

      await test(`${layout.label}: keyboard focus reveals a hover-only control`, async () => {
        const { page } = await open(layout.query);
        await tabTo(page, "Remove photo 1 of 2");
        // Waits out the opacity transition; fails if focus never reveals it.
        await page.waitForFunction(() => {
          const el = document.activeElement;
          return Number(getComputedStyle(el).opacity) === 1 && Number(getComputedStyle(el.parentElement).opacity) === 1;
        }, null, { timeout: 2_000 });
        await page.close();
      });

      await test(`${layout.label}: Enter on the add control opens the file chooser and uploads to this record`, async () => {
        const { page, state } = await open(layout.query);
        await tabTo(page, layout.add);
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
        await chooser.setFiles({ name: "extinguisher.png", mimeType: "image/png", buffer: PNG });
        await page.getByRole("button", { name: "View photo 3 of 3" }).waitFor();
        const writes = mutations(state);
        assert.deepEqual(writes.map((r) => r.method + " " + (r.path ?? new URL(r.url).host)), [
          "POST /api/photos/request-upload", "PUT storage.test", "POST /api/photos",
        ]);
        assert.ok(writes.filter((r) => r.path).every((r) => r.csrf === "harness-csrf"), "API writes carry the session CSRF token");
        const requested = JSON.parse(writes[0].body);
        assert.equal(requested.entityType, "fire_safety_check");
        assert.equal(requested.entityId, 41);
        assert.deepEqual(JSON.parse(writes[2].body), { entityType: "fire_safety_check", entityId: 41, objectPath: "/objects/uploads/900" });
        await page.close();
      });

      await test(`${layout.label}: lightbox opens by keyboard, is a named dialog, and returns focus on close`, async () => {
        const { page } = await open(layout.query);
        await tabTo(page, "View photo 2 of 2");
        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Photo 2 of 2" });
        await dialog.waitFor();
        assert.equal(await focusedName(page), "Close photo", "focus moves into the dialog");
        await page.keyboard.press("Tab");
        assert.equal(await focusedName(page), "Close photo", "focus stays in the dialog");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "View photo 2 of 2");
        // Close button by keyboard as well.
        await page.keyboard.press("Enter");
        await dialog.waitFor();
        await page.keyboard.press("Enter");
        await dialog.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "View photo 2 of 2");
        await page.close();
      });

      await test(`${layout.label}: remove by keyboard asks first, deletes once and keeps focus in the uploader`, async () => {
        const { page, state } = await open(layout.query);
        await tabTo(page, "Remove photo 1 of 2");
        page.once("dialog", (d) => d.dismiss());
        await page.keyboard.press("Enter");
        await page.waitForTimeout(100);
        assert.equal(mutations(state).length, 0, "a cancelled confirmation deletes nothing");
        page.once("dialog", (d) => d.accept());
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "View photo 1 of 1" }).waitFor();
        assert.deepEqual(mutations(state).map((r) => `${r.method} ${r.path}`), ["DELETE /api/photos/1"]);
        await page.waitForFunction((add) => {
          const el = document.activeElement;
          return (el?.getAttribute("aria-label") || el?.textContent?.trim()) === add;
        }, layout.add);
        await page.close();
      });

      await test(`${layout.label}: read-only keeps viewing but has no upload or remove controls`, async () => {
        const { page, state } = await open(`${layout.query}&readOnly=1`);
        assert.deepEqual(await tabSequence(page), ["View photo 1 of 2", "View photo 2 of 2"]);
        assert.equal(await page.locator('input[type="file"]').count(), 0);
        assert.equal(await page.getByRole("button", { name: /Remove photo|Add photo/i }).count(), 0);
        await tabTo(page, "View photo 1 of 2");
        await page.keyboard.press("Enter");
        await page.getByRole("dialog", { name: "Photo 1 of 2" }).waitFor();
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "View photo 1 of 2");
        assert.equal(mutations(state).length, 0);
        await page.close();
      });
    }

    await test("images carry no misleading alt text; the controls carry the names", async () => {
      const { page } = await open("?");
      const alts = await page.locator("img").evaluateAll((imgs) => imgs.map((img) => img.getAttribute("alt")));
      assert.ok(alts.every((alt) => alt === ""), JSON.stringify(alts));
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
  console.log(`${passed} photo uploader browser checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
