// Real-browser (Chromium via Playwright) checks for the DailyTrack checklist
// card:
//  - each checklist line is a keyboard-operable Pass / Fail / N/A choice;
//  - "Pass all" at the end of the list passes only the unanswered lines;
//  - a failed save shows the server's error, keeps the user's answers and does
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
import { existsSync } from "node:fs";
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
  page.route(apiPath("/api/assignees"), (route) => json(route, 200, []));
  page.route(apiPath("/api/checklist-templates"), (route) => json(route, 200, {
    items: [{ label: "Alpha check" }, { label: "Bravo check" }, { label: "Charlie check" }],
  }));
  page.route(apiPath("/api/daily-track-am"), (route) => {
    if (route.request().method() !== "POST") return json(route, 404, { error: "unexpected" });
    state.posts.push(JSON.parse(route.request().postData()));
    const [status, body] = saveResponses.shift() ?? [500, { error: "no response queued" }];
    return json(route, status, body);
  });
  return state;
}

/** One line's Pass / Fail / N/A buttons. */
const answer = (page, line, option) => page.getByRole("radiogroup", { name: line }).getByRole("radio", { name: option });
const isAnswered = async (page, line, option) => (await answer(page, line, option).getAttribute("aria-checked")) === "true";
const passAll = (page) => page.getByTestId("button-pass-all");

async function main() {
  const outDir = await buildHarness();
  const server = await serve(outDir);
  const base = `http://127.0.0.1:${server.address().port}/tests/browser/daily-checklist.html`;
  // Cloud sessions have a preinstalled browser; CI uses Playwright's own.
  const executablePath = process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium"].find((p) => existsSync(p));
  const browser = await chromium.launch({ executablePath });
  const open = async (saveResponses = [], viewport) => {
    const page = await browser.newPage(viewport ? { viewport } : undefined);
    page.setDefaultTimeout(5_000);
    if (process.env.DEBUG_BROWSER) page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
    const state = mockApi(page, saveResponses);
    if (process.env.DEBUG_BROWSER) page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(base);
    await answer(page, "Alpha check", "Pass").waitFor();
    return { page, state };
  };
  try {
    await test("each line is a keyboard-operable Pass / Fail / N/A choice", async () => {
      const { page } = await open();
      assert.equal(await page.getByRole("radiogroup").count(), 3);
      assert.equal(await isAnswered(page, "Alpha check", "Pass"), false);
      await page.focus("#before");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Pass");
      await page.keyboard.press("Space");
      assert.equal(await isAnswered(page, "Alpha check", "Pass"), true, "Space answers Pass");
      await answer(page, "Bravo check", "N/A").focus();
      await page.keyboard.press("Enter");
      assert.equal(await isAnswered(page, "Bravo check", "N/A"), true, "Enter answers N/A");
      await page.close();
    });

    await test("Pass all shows before anything is answered and passes every line", async () => {
      const { page, state } = await open([[201, { id: 7, checklistType: "kitchen_opening", checkDate: "2026-10-12", siteId: 5, items: [] }]]);
      assert.equal((await passAll(page).textContent()).trim(), "Pass all");
      await passAll(page).click();
      for (const line of ["Alpha check", "Bravo check", "Charlie check"]) {
        assert.equal(await isAnswered(page, line, "Pass"), true, `${line} passed`);
      }
      assert.equal(await passAll(page).count(), 0, "hidden once every line is answered");
      await page.getByRole("button", { name: "Submit checklist" }).click();
      await page.getByText("Checklist submitted", { exact: true }).waitFor();
      assert.deepEqual(state.posts[0].items.map((i) => i.result), ["pass", "pass", "pass"]);
      assert.ok(state.posts[0].submittedAt, "sent as submitted");
      await page.close();
    });

    await test("Pass all leaves Fail and N/A answers alone, and a fail still needs a note", async () => {
      const { page } = await open();
      await answer(page, "Alpha check", "Fail").click();
      await answer(page, "Charlie check", "N/A").click();
      assert.equal((await passAll(page).textContent()).trim(), "Pass the other 1");
      await passAll(page).click();
      assert.equal(await isAnswered(page, "Alpha check", "Fail"), true, "fail kept");
      assert.equal(await isAnswered(page, "Bravo check", "Pass"), true, "unanswered line passed");
      assert.equal(await isAnswered(page, "Charlie check", "N/A"), true, "N/A kept");
      assert.equal(await page.getByRole("button", { name: "Submit checklist" }).isDisabled(), true, "fail without a note blocks submit");
      await page.getByLabel("Note for Alpha check").fill("Door sticks");
      assert.equal(await page.getByRole("button", { name: "Submit checklist" }).isDisabled(), false);
      await page.close();
    });

    await test("Pass all sits after the last line and fits a phone screen", async () => {
      const { page } = await open([], { width: 375, height: 740 });
      const lastLine = await page.getByRole("radiogroup", { name: "Charlie check" }).boundingBox();
      const button = await passAll(page).boundingBox();
      assert.ok(button.y > lastLine.y + lastLine.height - 1, "below the last line");
      assert.ok(button.x >= 0 && button.x + button.width <= 375, "inside the screen width");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll");
      await page.close();
    });

    await test("a failed save shows the server error and keeps the answers", async () => {
      const { page, state } = await open([
        [500, { error: "Database unavailable" }],
        [201, { id: 7, checklistType: "kitchen_opening", checkDate: "2026-10-12", siteId: 5, items: [] }],
      ]);
      await answer(page, "Alpha check", "Pass").click();
      await answer(page, "Bravo check", "Pass").click();
      await page.getByRole("button", { name: "Save draft" }).click();
      // Exact matches: Radix Toast also briefly mirrors the title and
      // description into a visually hidden live region for screen readers.
      await page.getByText("Database unavailable", { exact: true }).waitFor();
      await page.getByText("Draft not saved", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.savedCount), 0, "no reload after a failed save");
      assert.equal(await isAnswered(page, "Alpha check", "Pass"), true, "answers survive a failed save");
      assert.equal(await isAnswered(page, "Bravo check", "Pass"), true, "answers survive a failed save");
      assert.deepEqual(state.posts[0].items.map((i) => i.checked), [true, true, false]);

      await page.getByRole("button", { name: "Save draft" }).click();
      await page.getByText("Draft saved", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.savedCount), 1, "reload after a successful save");
      assert.equal(state.posts.length, 2);
      await page.close();
    });

    await test("a conflicting submit reports the error and reloads the stored copy", async () => {
      const { page } = await open([[409, { error: "Checklist already submitted", code: "CHECKLIST_ALREADY_SUBMITTED", id: 9 }]]);
      await passAll(page).click();
      await page.getByRole("button", { name: "Submit checklist" }).click();
      await page.getByText("Checklist already submitted", { exact: true }).waitFor();
      await page.getByText("Checklist not submitted", { exact: true }).waitFor();
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
