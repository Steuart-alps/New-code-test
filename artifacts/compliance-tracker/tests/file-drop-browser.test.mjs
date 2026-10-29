import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, firefox, webkit } from "@playwright/test";

// Browser regression for dragging photos onto attach boxes
// (src/hooks/use-file-drop.ts, src/lib/media-upload.ts heicToJpeg):
//   - a photo dropped on the box is added, as before;
//   - a photo dropped beside the box (elsewhere on the form) goes into the
//     only box in view instead of the browser opening the file;
//   - with two boxes in view a stray drop is held and a message says where
//     to drop it;
//   - a drop that carries only a file:// link (Safari, dragging straight out
//     of the Mac Photos app) is held and explained, never opened;
//   - text and links can still be dropped into text boxes;
//   - a HEIC photo the browser can read is turned into a JPEG.
// FILE_DROP_BROWSER=chromium|firefox|webkit picks the engine.
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const browserName = process.env.FILE_DROP_BROWSER ?? "chromium";
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported FILE_DROP_BROWSER=${browserName}; expected chromium, firefox, or webkit`);
const freePort = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
};
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const vite = spawn("pnpm", ["exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), BASE_PATH: "/", NODE_ENV: "test" },
  stdio: ["ignore", "ignore", "pipe"],
});
let viteError = "";
vite.stderr.on("data", chunk => { viteError += chunk.toString(); });
let browser;

async function waitForVite() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}
const executablePath = browserName === "chromium"
  ? process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium"].find(path => existsSync(path))
  : undefined;

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function open(query = "") {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/tests/file-drop-harness.html${query}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("media-first").waitFor();
  return page;
}

/**
 * Drags onto the element matching `selector` the way the operating system
 * would: dragenter, dragover, then drop. `files` are {name, type} made from
 * the PNG bytes; `data` adds string types such as text/uri-list. Returns
 * whether the page took the drop (cancelled the drop event), which is what
 * stops the browser opening the file itself.
 */
function drop(page, selector, { files = [], data = {} } = {}) {
  return page.evaluate(({ selector, files, data, bytes }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([new Uint8Array(bytes)], file.name, { type: file.type }));
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    const target = document.querySelector(selector);
    if (!target) throw new Error(`No element for ${selector}`);
    let taken = false;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(event);
      if (type === "drop") taken = event.defaultPrevented;
    }
    return taken;
  }, { selector, files, data, bytes: [...PNG] });
}

const filesIn = (page, name) => page.evaluate((name) => window.__files[name] ?? [], name);
const toastText = (page) => page.locator("[data-state='open']").filter({ hasText: /./ }).allInnerTexts().then(texts => texts.join("\n"));

async function test(name, run) {
  try { await run(); console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

try {
  await waitForVite();
  browser = await browserType.launch({ headless: true, executablePath });

  await test("a photo dropped on the photos box is added", async () => {
    const page = await open();
    assert.equal(await drop(page, "[data-testid='media-first'] p", { files: [{ name: "leak.png", type: "image/png" }] }), true);
    await page.waitForFunction(() => window.__files.first?.length === 1);
    assert.deepEqual(await filesIn(page, "first"), [{ name: "leak.png", type: "image/png" }]);
    await page.close();
  });

  await test("a photo dropped beside the box goes into the only box in view", async () => {
    const page = await open();
    assert.equal(await drop(page, "[data-testid='beside-first']", { files: [{ name: "beside.png", type: "image/png" }] }), true, "the browser must not open the file");
    await page.waitForFunction(() => window.__files.first?.length === 1);
    assert.deepEqual(await filesIn(page, "first"), [{ name: "beside.png", type: "image/png" }]);
    // Anywhere on the page, too.
    assert.equal(await drop(page, "[data-testid='page-heading']", { files: [{ name: "heading.png", type: "image/png" }] }), true);
    await page.waitForFunction(() => window.__files.first?.length === 2);
    await page.close();
  });

  await test("with two boxes in view a stray photo is held and the page says where to drop it", async () => {
    const page = await open("?two");
    assert.equal(await drop(page, "[data-testid='page-heading']", { files: [{ name: "stray.png", type: "image/png" }] }), true, "the browser must not open the file");
    await page.getByText("Drop it on an upload box").waitFor();
    assert.deepEqual(await filesIn(page, "first"), []);
    assert.deepEqual(await filesIn(page, "second"), []);
    // Dropped on a box, it goes to that box only.
    assert.equal(await drop(page, "[data-testid='media-second'] p", { files: [{ name: "second.png", type: "image/png" }] }), true);
    await page.waitForFunction(() => window.__files.second?.length === 1);
    assert.deepEqual(await filesIn(page, "first"), []);
    await page.close();
  });

  await test("a Photos library link with no photo is held and explained, not opened", async () => {
    const page = await open();
    const link = "file:///Users/someone/Pictures/Photos%20Library.photoslibrary/originals/7/7F67F344.jpeg";
    assert.equal(await drop(page, "[data-testid='beside-first']", { data: { "text/uri-list": link } }), true, "the browser must not open the file link");
    await page.getByText("The browser didn't pass the photo on").waitFor();
    assert.match(await toastText(page), /onto your desktop first/);
    assert.deepEqual(await filesIn(page, "first"), []);
    await page.close();
  });

  await test("text and links can still be dropped into a text box", async () => {
    const page = await open();
    assert.equal(await drop(page, "input[aria-label='first title']", { data: { "text/plain": "Leaking pipe" } }), false);
    assert.equal(await drop(page, "input[aria-label='first title']", { data: { "text/uri-list": "https://example.com/", "text/plain": "https://example.com/" } }), false);
    await page.close();
  });

  await test("a HEIC photo the browser can read becomes a JPEG", async () => {
    const page = await open();
    // Image bytes the browser can decode, named and typed as HEIC (the Mac
    // Photos app's usual format, which Safari can read).
    assert.equal(await drop(page, "[data-testid='media-first'] p", { files: [{ name: "IMG_0001.HEIC", type: "image/heic" }] }), true);
    await page.waitForFunction(() => window.__files.first?.length === 1);
    assert.deepEqual(await filesIn(page, "first"), [{ name: "IMG_0001.jpg", type: "image/jpeg" }]);
    await page.close();
  });

  console.log(`File drop browser checks passed (${browserName}).`);
} finally {
  await browser?.close();
  vite.kill();
}
