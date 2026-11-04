// Real-browser (Chromium via Playwright) checks for the DailyTrack status
// month calendar:
//  - a failed or unreachable history request shows a retryable error, never an
//    all-grey "nothing started" month, and a retry that succeeds draws it;
//  - colours and counts follow the checks the client's services enable, so a
//    KitchenTrack-only site goes green on its three checks.
//
// The real calendar is mounted by tests/browser/daily-track-month.harness.tsx
// and built with the app's React and Tailwind setup. API requests are
// intercepted; the clock is fixed so the calendar opens on September 2026.
//
// Run with: pnpm --filter @workspace/compliance-tracker run test:daily-track-month-browser
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

// CHROMIUM_PATH, else the cloud sessions' preinstalled browser, else
// Playwright's own download (CI runs `playwright install chromium`).
const chromiumPath = () => process.env.CHROMIUM_PATH ||
  ["/opt/pw-browsers/chromium"].find((candidate) => existsSync(candidate));

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
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(harnessDir, "daily-track-month.html") } },
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

const ALL = ["kitchen_opening", "premises_opening", "kitchen_closing", "premises_closing", "signoff"];
const KITCHEN = ["kitchen_opening", "kitchen_closing", "signoff"];
const at = "2026-09-01T12:00:00.000Z";
const checklist = (checkDate, siteId, checklistType, submitted = true) =>
  ({ checkDate, siteId, checklistType, submittedAt: submitted ? at : null });
const signoff = (signoffDate, siteId, submitted = true) => ({ signoffDate, siteId, submittedAt: submitted ? at : null });
const kitchenDay = (date, siteId) => [checklist(date, siteId, "kitchen_opening"), checklist(date, siteId, "kitchen_closing")];

/** Answers history requests in order: [status, body], or "abort" for a network failure. */
function mockApi(page, responses) {
  const state = { requests: [] };
  page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  page.route((url) => url.pathname.includes("/api/daily-track-status/history"), (route) => {
    state.requests.push(new URL(route.request().url()).search);
    const next = responses.shift() ?? [500, { error: "no response queued" }];
    if (next === "abort") return route.abort("connectionrefused");
    const [status, body] = next;
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  page.route((url) => url.pathname.includes("/api/") && !url.pathname.includes("/daily-track-status/"),
    (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  return state;
}

// SCREENSHOT_DIR=<dir> saves the error and KitchenTrack-only states for review.
const shot = (page, name) => process.env.SCREENSHOT_DIR
  ? page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${name}.png`), fullPage: true })
  : undefined;

const dayButton = (page, date) => page.locator(`button[title^="${date} "]`);
const dayClass = (page, date) => dayButton(page, date).getAttribute("class");

async function main() {
  const outDir = await buildHarness();
  const server = await serve(outDir);
  const base = `http://127.0.0.1:${server.address().port}/tests/browser/daily-track-month.html`;
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const open = async (responses) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    if (process.env.DEBUG_BROWSER) page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
    await page.clock.setFixedTime(new Date("2026-10-16T12:00:00"));
    const state = mockApi(page, responses);
    await page.goto(base);
    return { page, state };
  };
  const everyServiceMonth = {
    requirements: ALL,
    checklists: [1, 2].flatMap((siteId) => ALL.slice(0, 4).map((type) => checklist("2026-09-02", siteId, type))),
    signoffs: [signoff("2026-09-02", 1), signoff("2026-09-02", 2)],
  };

  try {
    await test("a server error shows a retryable error, then the month after a retry", async () => {
      const { page, state } = await open([[500, { error: "Database unavailable" }], [200, everyServiceMonth]]);
      const alert = page.getByRole("alert");
      await alert.getByText("Couldn't load checklist history for September 2026").waitFor();
      await alert.getByText("Database unavailable", { exact: true }).waitFor();
      assert.equal(await page.locator("button[title]").count(), 0, "no day is drawn from a failed request");
      assert.equal(await page.getByText(/days? with gaps/).count(), 0, "no gap count from a failed request");
      assert.equal(state.requests[0], "?from=2026-09-01&to=2026-09-30");
      await shot(page, "month-load-failed");

      await alert.getByRole("button", { name: "Try again" }).click();
      await dayButton(page, "2026-09-02").waitFor();
      assert.equal(await page.getByRole("alert").count(), 0, "the error clears once the retry succeeds");
      assert.equal(await dayButton(page, "2026-09-02").getAttribute("title"), "2026-09-02 — 10/10 submitted, 10 started");
      assert.match(await dayClass(page, "2026-09-02"), /bg-emerald-100/);
      assert.match(await dayClass(page, "2026-09-03"), /bg-muted /);
      await page.getByText("29 days with gaps in September 2026").waitFor();
      assert.equal(state.requests.length, 2);
      await page.close();
    });

    await test("an unreachable API shows a retryable error, not an empty month", async () => {
      const { page } = await open(["abort", [200, everyServiceMonth]]);
      await page.getByRole("alert").getByText("Check your connection and try again.").waitFor();
      assert.equal(await page.locator("button[title]").count(), 0);
      await page.getByRole("button", { name: "Try again" }).click();
      await dayButton(page, "2026-09-02").waitFor();
      assert.match(await dayClass(page, "2026-09-02"), /bg-emerald-100/);
      await page.close();
    });

    await test("a failure after changing month is an error for that month, and recovers", async () => {
      const { page, state } = await open([[200, everyServiceMonth], [503, { error: "Service unavailable" }], [200, { ...everyServiceMonth, checklists: [], signoffs: [] }]]);
      await dayButton(page, "2026-09-02").waitFor();
      await page.getByRole("button", { name: "←" }).click();
      await page.getByRole("alert").getByText("Couldn't load checklist history for August 2026").waitFor();
      assert.equal(await page.locator("button[title]").count(), 0, "September's days are not shown under August");
      await page.getByRole("button", { name: "Try again" }).click();
      await dayButton(page, "2026-08-01").waitFor();
      assert.equal(state.requests.at(-1), "?from=2026-08-01&to=2026-08-31");
      await page.close();
    });

    await test("a KitchenTrack-only client goes green on its three checks per site", async () => {
      const { page } = await open([[200, {
        requirements: KITCHEN,
        checklists: [
          ...kitchenDay("2026-09-03", 1), ...kitchenDay("2026-09-03", 2),
          ...kitchenDay("2026-09-04", 1), ...kitchenDay("2026-09-04", 2),
          checklist("2026-09-05", 1, "premises_opening"),
        ],
        signoffs: [signoff("2026-09-03", 1), signoff("2026-09-03", 2), signoff("2026-09-04", 1), signoff("2026-09-04", 2, false)],
      }]]);
      await dayButton(page, "2026-09-03").waitFor();
      assert.equal(await dayButton(page, "2026-09-03").getAttribute("title"), "2026-09-03 — 6/6 submitted, 6 started");
      assert.match(await dayClass(page, "2026-09-03"), /bg-emerald-100/, "all three kitchen checks at both sites is green");
      assert.equal(await dayButton(page, "2026-09-04").getAttribute("title"), "2026-09-04 — 5/6 submitted, 6 started");
      assert.match(await dayClass(page, "2026-09-04"), /bg-amber-100/, "a draft sign-off keeps the day amber");
      assert.match(await dayClass(page, "2026-09-05"), /bg-muted /, "a premises checklist outside the plan does not start a day");
      await shot(page, "kitchentrack-only-month");

      await page.locator("#month-overview-site").selectOption("2");
      assert.equal(await dayButton(page, "2026-09-04").getAttribute("title"), "2026-09-04 — 2/3 submitted, 3 started");
      await page.locator("#month-overview-site").selectOption("1");
      assert.equal(await dayButton(page, "2026-09-04").getAttribute("title"), "2026-09-04 — 3/3 submitted, 3 started");
      assert.match(await dayClass(page, "2026-09-04"), /bg-emerald-100/);
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
  console.log(`${passed} DailyTrack month calendar browser checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
