// Real-browser (Chromium via Playwright) checks for the DailyTrack checklist
// card:
//  - each checklist line is a keyboard-operable checkbox (Tab, Space, Enter)
//    with aria-checked state;
//  - a failed save shows the server's error, keeps the user's ticks and does
//    not report success or reload; a successful save does.
//
// The real card is mounted by tests/browser/daily-checklist.harness.tsx and
// built with the app's React and Tailwind setup. API requests are intercepted.
//
// Run with: pnpm --filter @workspace/compliance-tracker run test:daily-checklist-card-browser
// (CHROMIUM_PATH selects the browser binary).
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

let passed = 0;
const failures = [];
async function test(name, run) {
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
    root,
    base: "./",
    logLevel: "error",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: "@/context/auth-context", replacement: path.join(harnessDir, "daily-checklist-auth.stub.ts") },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(harnessDir, "daily-checklist.html") } },
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

/** Answers the card's requests; `saveResponses` are used in order for POSTs. */
function mockApi(page, saveResponses) {
  const state = { posts: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  const apiPath = (prefix) => (url) => url.pathname.includes(prefix);
  page.route(apiPath("/api/auth/csrf-token"), (route) => json(route, 200, { token: "harness-csrf" }));
  page.route(apiPath("/api/staff-roster"), (route) => json(route, 200, []));
  page.route(apiPath("/api/checklist-templates"), (route) => json(route, 200, {
    items: [{ label: "Alpha check" }, { label: "Bravo check" }],
  }));
  page.route(apiPath("/api/daily-track-am"), (route) => {
    if (route.request().method() !== "POST") return json(route, 404, { error: "unexpected" });
    state.posts.push(JSON.parse(route.request().postData()));
    const [status, body] = saveResponses.shift() ?? [500, { error: "no response queued" }];
    return json(route, status, body);
  });
  return state;
}

const checkbox = (page, name) => page.getByRole("checkbox", { name });
const isChecked = async (page, name) => (await checkbox(page, name).getAttribute("aria-checked")) === "true";

async function main() {
  const outDir = await buildHarness();
  const server = await serve(outDir);
  const base = `http://127.0.0.1:${server.address().port}/tests/browser/daily-checklist.html`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  const open = async (saveResponses = []) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    if (process.env.DEBUG_BROWSER) page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
    const state = mockApi(page, saveResponses);
    await page.goto(base);
    await checkbox(page, "Alpha check").waitFor();
    return { page, state };
  };
  try {
    await test("checklist lines are keyboard checkboxes (Tab, Space, Enter)", async () => {
      const { page } = await open();
      assert.equal(await page.getByRole("checkbox").count(), 2);
      assert.equal(await isChecked(page, "Alpha check"), false);
      await page.focus("#before");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Alpha check");
      await page.keyboard.press("Space");
      assert.equal(await isChecked(page, "Alpha check"), true, "Space ticks");
      await page.keyboard.press("Space");
      assert.equal(await isChecked(page, "Alpha check"), false, "Space unticks");
      await checkbox(page, "Bravo check").focus();
      await page.keyboard.press("Enter");
      assert.equal(await isChecked(page, "Bravo check"), true, "Enter ticks");
      await page.close();
    });

    await test("a failed save shows the server error and keeps the ticks", async () => {
      const { page, state } = await open([
        [500, { error: "Database unavailable" }],
        [201, { id: 7, checklistType: "kitchen_opening", checkDate: "2026-10-12", siteId: 5, items: [] }],
      ]);
      await checkbox(page, "Alpha check").click();
      await checkbox(page, "Bravo check").click();
      await page.getByRole("button", { name: "Save draft" }).click();
      await page.getByText("Database unavailable").waitFor();
      await page.getByText("Draft not saved").waitFor();
      assert.equal(await page.evaluate(() => window.savedCount), 0, "no reload after a failed save");
      assert.equal(await isChecked(page, "Alpha check"), true, "ticks survive a failed save");
      assert.equal(await isChecked(page, "Bravo check"), true, "ticks survive a failed save");
      assert.deepEqual(state.posts[0].items.map((i) => i.checked), [true, true]);

      await page.getByRole("button", { name: "Save draft" }).click();
      await page.getByText("Draft saved", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.savedCount), 1, "reload after a successful save");
      assert.equal(state.posts.length, 2);
      await page.close();
    });

    await test("a conflicting submit reports the error and reloads the stored copy", async () => {
      const { page } = await open([[409, { error: "Checklist already submitted", code: "CHECKLIST_ALREADY_SUBMITTED", id: 9 }]]);
      await checkbox(page, "Alpha check").click();
      await page.getByRole("button", { name: "Submit checklist" }).click();
      await page.getByText("Checklist already submitted").waitFor();
      await page.getByText("Checklist not submitted").waitFor();
      assert.equal(await page.evaluate(() => window.savedCount), 1);
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
  console.log(`${passed} daily checklist card browser checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
