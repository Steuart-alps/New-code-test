import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium, firefox, webkit } from "@playwright/test";

// Browser regression for "Take photo or video" (src/components/camera-capture.tsx),
// using the photos box from the new FixTrack issue form (file-drop-harness).
//   - on a laptop or desktop it opens a camera window; a photo taken there
//     is added as a JPEG, and a recorded clip as an MP4 or WebM video the
//     server's checks recognise;
//   - "Try again" goes back to the camera;
//   - a refused camera says why and "Choose a file instead" opens the picker;
//   - phones and tablets (touch screens) keep their own camera app.
// The browser's fake camera stands in for a real one.
// FILE_DROP_BROWSER=chromium|firefox|webkit picks the engine;
// CAMERA_SCREENSHOTS=<dir> saves screenshots.
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
const screenshotDir = process.env.CAMERA_SCREENSHOTS;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const shot = async (page, name) => { if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png` }); };

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
const launchOptions = {
  chromium: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  firefox: { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } },
  webkit: {},
}[browserName];

async function open({ initScript } = {}) {
  // Chromium needs the camera granted; Firefox (prefs above) and Playwright's
  // WebKit (which has no "camera" permission to grant) allow it already.
  const context = await browser.newContext(browserName === "chromium" ? { permissions: ["camera", "microphone"] } : {});
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("filechooser", () => {});
  await page.goto(`${baseUrl}/tests/file-drop-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("media-first").waitFor();
  return { context, page };
}

const takeButton = (page) => page.getByTestId("media-first").getByRole("button", { name: "Take photo or video" });
const filesIn = (page) => page.evaluate(() => window.__files.first ?? []);
// The first bytes of the added file, as the server's type check reads them.
const header = (page) => page.evaluate(async () => {
  const bytes = new Uint8Array(await window.__raw.first[0].slice(0, 12).arrayBuffer());
  return { hex: [...bytes.slice(0, 4)].map(b => b.toString(16).padStart(2, "0")).join(""), ascii: String.fromCharCode(...bytes.slice(4, 8)), size: window.__raw.first[0].size };
});

async function test(name, run) {
  try { await run(); console.log(`ok - ${name}`); } catch (error) { console.error(`not ok - ${name}`); throw error; }
}

try {
  await waitForVite();
  browser = await browserType.launch({ headless: true, executablePath, ...launchOptions });

  await test("a photo taken in the camera window is added as a JPEG", async () => {
    const { context, page } = await open();
    await takeButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Take a photo or video" });
    await dialog.getByRole("button", { name: "Take photo" }).waitFor();
    await page.waitForTimeout(500);
    await shot(page, "1-camera-window");
    await dialog.getByRole("button", { name: "Take photo" }).click();
    await dialog.getByTestId("camera-review").waitFor();
    await shot(page, "2-check-the-photo");
    // Try again returns to the live camera.
    await dialog.getByRole("button", { name: "Try again" }).click();
    await dialog.getByRole("button", { name: "Take photo" }).click();
    await dialog.getByRole("button", { name: "Use this photo" }).click();
    await dialog.waitFor({ state: "detached" });
    const files = await filesIn(page);
    assert.equal(files.length, 1);
    assert.match(files[0].name, /^photo-\d{8}-\d{6}\.jpg$/);
    assert.equal(files[0].type, "image/jpeg");
    assert.equal((await header(page)).hex.slice(0, 6), "ffd8ff", "a real JPEG");
    await context.close();
  });

  await test("a clip recorded in the camera window is added as a video the server accepts", async () => {
    const { context, page } = await open();
    await takeButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Take a photo or video" });
    await dialog.getByRole("button", { name: "Record video" }).click();
    await dialog.getByText(/Recording 0:0[1-9]/).waitFor();
    await shot(page, "3-recording");
    await dialog.getByRole("button", { name: "Stop recording" }).click();
    await dialog.getByRole("button", { name: "Use this video" }).click();
    await dialog.waitFor({ state: "detached" });
    const [file] = await filesIn(page);
    assert.match(file.name, /^video-\d{8}-\d{6}\.(mp4|webm)$/);
    assert.ok(["video/mp4", "video/webm"].includes(file.type), file.type);
    const { hex, ascii, size } = await header(page);
    assert.ok(size > 1000, `the clip has content (${size} bytes)`);
    if (file.type === "video/webm") assert.equal(hex, "1a45dfa3", "WebM header");
    else assert.equal(ascii, "ftyp", "MP4 header");
    await context.close();
  });

  await test("a refused camera says why and offers the file picker", async () => {
    const { context, page } = await open({
      initScript: () => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      },
    });
    await takeButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Take a photo or video" });
    await dialog.getByRole("alert").filter({ hasText: "isn't allowed to use the camera" }).waitFor();
    await shot(page, "4-camera-not-allowed");
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      dialog.getByRole("button", { name: "Choose a file instead" }).click(),
    ]);
    await dialog.waitFor({ state: "detached" });
    await chooser.setFiles({ name: "chosen.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") });
    await page.waitForFunction(() => window.__files.first?.length === 1);
    await context.close();
  });

  await test("phones and tablets keep their own camera app", async () => {
    const { context, page } = await open({
      initScript: () => {
        const real = window.matchMedia.bind(window);
        window.matchMedia = (query) => query === "(pointer: coarse)" ? { ...real(query), matches: true, media: query } : real(query);
      },
    });
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), takeButton(page).click()]);
    assert.equal(await page.getByTestId("camera-dialog").count(), 0, "no camera window");
    assert.equal(await chooser.element().getAttribute("capture"), "environment", "the camera file box");
    await context.close();
  });

  console.log(`Camera capture browser checks passed (${browserName}).`);
} finally {
  await browser?.close();
  vite.kill();
}
