// Browser regression for photos and videos on the "Record …" forms of every
// track (src/components/record-media.tsx) and on saved records
// (src/components/check-photo-uploader.tsx):
//   - a photo and a video picked in a new record's form upload only once the
//     record is saved, onto that new record, and show in its photo box;
//   - a video shows as a video, and opens in a player;
//   - nothing is uploaded when the form isn't saved;
//   - a file that can't be added says the record was still saved;
//   - a saved record's photo box takes a video directly.
//
// The real components are built with the app's React and Tailwind setup
// (tests/browser/record-media.harness.tsx). API and storage requests are
// intercepted; nothing is uploaded anywhere.
// FILE_DROP_BROWSER=chromium|firefox|webkit picks the engine.
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium, firefox, webkit } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = path.join(root, "tests", "browser");
const browserName = process.env.FILE_DROP_BROWSER ?? "chromium";
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported FILE_DROP_BROWSER=${browserName}; expected chromium, firefox, or webkit`);
const executablePath = browserName === "chromium"
  ? process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium"].find(candidate => existsSync(candidate))
  : undefined;

// A 1x1 PNG, and the start of an MP4 (an ftyp box): enough for the type checks.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from("isommp41"), Buffer.alloc(64)]);
const NEW_RECORD_ID = 77;

let passed = 0;
const failures = [];
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL: ${name}\n  ${err?.message?.split("\n").slice(0, 8).join("\n  ")}`);
  }
}

async function buildHarness() {
  const outDir = await mkdtemp(path.join(harnessDir, ".dist-"));
  await build({
    configFile: false,
    root,
    base: "./",
    logLevel: "error",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        // Only the signed-in context is stubbed; the upload code is real.
        { find: "@/context/auth-context", replacement: path.join(harnessDir, "auth-context.stub.ts") },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(harnessDir, "record-media.html") } },
  });
  return outDir;
}

function serve(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer(async (req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(dir)) return void res.writeHead(403).end();
    try {
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** In-memory record and photo API with the server's response shapes. */
function mockApi(page, { failAttach = false } = {}) {
  const state = { photos: [], nextId: 900, requests: [], puts: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const at = prefix => url => url.pathname.includes(prefix);
  page.route("https://fonts.googleapis.com/**", route => route.abort());
  page.route(at("/api/auth/csrf-token"), route => json(route, 200, { token: "harness-csrf" }));
  page.route(at("/api/storage/"), route => {
    const video = /\.mp4$/.test(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: video ? "video/mp4" : "image/png", body: video ? MP4 : PNG });
  });
  page.route("https://storage.test/**", route => {
    state.puts.push({ method: route.request().method(), contentType: route.request().headers()["content-type"] });
    return route.fulfill({ status: 200, body: "" });
  });
  page.route(at("/api/fire-safety"), route => {
    state.requests.push({ method: route.request().method(), path: "/api/fire-safety" });
    return json(route, 201, { id: NEW_RECORD_ID, checkType: "fire_door" });
  });
  page.route(at("/api/photos"), route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    state.requests.push({ method, path: url.pathname.slice(url.pathname.indexOf("/api/")), body });
    if (method === "GET" && url.pathname.endsWith("/api/photos")) {
      return json(route, 200, state.photos.filter(photo => photo.entity_type === url.searchParams.get("entityType")
        && String(photo.entity_id) === url.searchParams.get("entityId")));
    }
    if (method === "POST" && url.pathname.endsWith("/api/photos/request-upload")) {
      const id = state.nextId++;
      return json(route, 200, { uploadUrl: `https://storage.test/upload/${id}`, objectPath: `/objects/uploads/${id}` });
    }
    if (method === "POST" && url.pathname.endsWith("/api/photos")) {
      if (failAttach) return json(route, 400, { error: "The file must be a valid JPEG, PNG, WebP, MP4, MOV or WebM photo or video" });
      // The server finalises to a fresh key named for the verified type.
      const id = state.nextId++;
      const extension = body.objectPath.endsWith(String(state.lastVideoUpload)) ? ".mp4" : ".png";
      const photo = { id, entity_type: body.entityType, entity_id: body.entityId, object_path: `/objects/finalized/${id}${extension}`, caption: null, created_at: new Date().toISOString() };
      state.photos.push(photo);
      return json(route, 201, photo);
    }
    return json(route, 404, { error: "unexpected" });
  });
  return state;
}

const photoFile = { name: "door-closer.png", mimeType: "image/png", buffer: PNG };
const videoFile = { name: "door-closing.mp4", mimeType: "video/mp4", buffer: MP4 };
const uploads = state => state.requests.filter(request => request.path === "/api/photos/request-upload");
const attaches = state => state.requests.filter(request => request.method === "POST" && request.path === "/api/photos");

async function main() {
  const outDir = await buildHarness();
  const server = await serve(outDir);
  const base = `http://127.0.0.1:${server.address().port}/tests/browser/record-media.html`;
  const browser = await browserType.launch({ executablePath });
  const open = async (options) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    page.on("filechooser", () => {});
    const state = mockApi(page, options);
    // Which reserved upload is the video, so the fake server names it .mp4.
    page.on("request", request => {
      if (request.url().includes("/api/photos/request-upload") && JSON.parse(request.postData() ?? "{}").contentType === "video/mp4") {
        state.lastVideoUpload = state.nextId;
      }
    });
    await page.goto(base);
    await page.getByTestId("record-form").waitFor();
    return { page, state };
  };
  const chooseFiles = async (scope, files, button = "Choose files") => {
    const chooser = scope.page().waitForEvent("filechooser");
    await scope.getByRole("button", { name: button, exact: true }).click();
    await (await chooser).setFiles(files);
  };

  try {
    await test("a photo and a video picked in a new record upload once it is saved, onto that record", async () => {
      const { page, state } = await open();
      const form = page.getByTestId("record-form");
      await chooseFiles(form, [photoFile]);
      await chooseFiles(form, [videoFile]);
      await form.locator("video").waitFor();
      assert.equal(await form.locator("img").count(), 1, "the photo is previewed");
      assert.equal(uploads(state).length, 0, "nothing uploads before the record is saved");

      await form.getByRole("button", { name: "Record Check" }).click();
      const saved = page.getByTestId("saved-record");
      await saved.getByRole("button", { name: "View video 2 of 2" }).waitFor();
      assert.deepEqual(uploads(state).map(request => request.body.contentType), ["image/png", "video/mp4"]);
      assert.deepEqual(uploads(state).map(request => request.body.entityId), [NEW_RECORD_ID, NEW_RECORD_ID]);
      assert.deepEqual(state.puts.map(put => put.contentType), ["image/png", "video/mp4"]);
      assert.deepEqual(attaches(state).map(request => [request.body.entityType, request.body.entityId]),
        [["fire_safety_check", NEW_RECORD_ID], ["fire_safety_check", NEW_RECORD_ID]]);
      assert.equal(await form.locator("video, img").count(), 0, "the form's picked files are cleared");

      assert.equal(await saved.locator("video").count(), 1, "the video shows as a video");
      assert.equal(await saved.locator("img").count(), 1, "the photo shows as a photo");
      await saved.getByRole("button", { name: "View video 2 of 2" }).click();
      const player = page.getByRole("dialog", { name: "Video 2 of 2" });
      await player.waitFor();
      assert.equal(await player.locator("video[controls]").count(), 1, "the video opens in a player");
      await page.keyboard.press("Escape");
      await player.waitFor({ state: "hidden" });
      await page.close();
    });

    await test("nothing uploads for a form that isn't saved", async () => {
      const { page, state } = await open();
      const form = page.getByTestId("record-form");
      await chooseFiles(form, [photoFile]);
      await form.getByRole("button", { name: "Remove door-closer.png" }).click();
      assert.equal(await form.locator("img").count(), 0);
      assert.equal(uploads(state).length + state.puts.length, 0);
      await page.close();
    });

    await test("a file that can't be added says the record was still saved", async () => {
      const { page } = await open({ failAttach: true });
      const form = page.getByTestId("record-form");
      await chooseFiles(form, [photoFile]);
      await form.getByRole("button", { name: "Record Check" }).click();
      await page.getByText("Photos and videos weren't added", { exact: true }).waitFor();
      await page.getByText(/The record was saved\. Add them again from its photo box\./).waitFor();
      await page.getByTestId("saved-record").waitFor();
      await page.close();
    });

    await test("a saved record's photo box takes a video", async () => {
      const { page, state } = await open();
      await page.getByTestId("record-form").getByRole("button", { name: "Record Check" }).click();
      const saved = page.getByTestId("saved-record");
      await saved.getByText("No photos or videos attached.").waitFor();
      await chooseFiles(saved, [videoFile]);
      await page.getByText("Video added", { exact: true }).waitFor();
      await saved.getByRole("button", { name: "View video 1 of 1" }).waitFor();
      assert.equal(uploads(state).at(-1).body.contentType, "video/mp4");
      assert.equal(await saved.locator("video").count(), 1);
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`${failures.length} record photo and video check(s) failed (${browserName}): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(`Record photo and video browser checks passed (${browserName}): ${passed}.`);
}

await main();
