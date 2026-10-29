// Real-browser (Chromium via Playwright) checks for the site picker on the
// DailyTrack checklist pages:
//  - the page starts on a site: the link's ?siteId=, else the user's own
//    department's site, else the site last picked on this device, else the
//    first site; "No site filter" is gone once the business has sites;
//  - answers given before the site is changed are kept and saved against the
//    newly picked site, matched by wording when that site's list differs;
//  - a site whose checklist is already submitted shows it read-only, and the
//    unsaved answers come back on a site that is still open;
//  - RoomTrack room checks and KitchenTrack cleaning ticks also survive
//    picking a site after filling them in;
//  - a page's "All sites" filter starts on the user's working site: their
//    department's site; for a Manager over several sites, the one they pick
//    in the top bar (one of theirs only); for an Owner or Consultant, the one
//    they pick there, else the first site. All sites can still be chosen on
//    each page.
//
// The real page is mounted by tests/browser/daily-checklist-site.harness.tsx
// and built with the app's React and Tailwind setup. API requests are
// intercepted.
//
// Run with: pnpm --filter @workspace/compliance-tracker run test:daily-checklist-site-browser
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
        { find: "@/context/auth-context", replacement: path.join(harnessDir, "daily-checklist-site-auth.stub.ts") },
        { find: "@/components/layout", replacement: path.join(harnessDir, "app-layout.stub.tsx") },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(harnessDir, "daily-checklist-site.html") } },
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

const SITES = [
  { id: 1, name: "Clubhouse", clientId: 1 },
  { id: 2, name: "Pro Shop", clientId: 1 },
  { id: 3, name: "Halfway House", clientId: 1 },
];

/**
 * Answers the page's requests. `rows` are the stored checklists; Halfway
 * House's kitchen list has its own wording ("Charlie check" instead of
 * "Alpha check").
 */
function mockApi(page, { rows = [], sitesDelayMs = 0 } = {}) {
  const state = { posts: [], loads: [], rows };
  const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  const apiPath = (prefix) => (url) => url.pathname.includes(prefix);
  page.route(apiPath("/api/auth/csrf-token"), (route) => json(route, 200, { token: "harness-csrf" }));
  page.route(apiPath("/api/staff-roster"), (route) => json(route, 200, []));
  page.route(apiPath("/api/daily-checklists/"), (route) => json(route, 404, { error: "none" }));
  page.route(apiPath("/api/sites"), async (route) => {
    if (sitesDelayMs) await new Promise((r) => setTimeout(r, sitesDelayMs));
    return json(route, 200, SITES);
  });
  page.route(apiPath("/api/departments"), (route) => json(route, 200, [
    { id: 11, name: "Shop", siteId: 2, siteName: "Pro Shop" },
    { id: 12, name: "Office", siteId: null, siteName: null },
    { id: 13, name: "Maintenance", siteId: 3, siteName: "Halfway House" },
  ]));
  page.route(apiPath("/api/checklist-templates"), (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("type") === "premises_opening") return json(route, 200, { items: [{ label: "Zulu check" }] });
    const items = url.searchParams.get("siteId") === "3"
      ? [{ label: "Bravo check" }, { label: "Charlie check" }]
      : [{ label: "Alpha check" }, { label: "Bravo check" }];
    return json(route, 200, { items });
  });
  page.route(apiPath("/api/room-track/rooms"), async (route) => {
    const siteId = Number(new URL(route.request().url()).searchParams.get("siteId")) || null;
    // Slow enough that the page is visibly reloading when the site changes.
    await new Promise((r) => setTimeout(r, 300));
    const rooms = [{ id: 1, roomNumber: "101", siteId: 1 }, { id: 2, roomNumber: "201", siteId: 2 }];
    return json(route, 200, rooms.filter((room) => !siteId || room.siteId === siteId));
  });
  page.route(apiPath("/api/room-track/checks"), (route) => json(route, 200, []));
  page.route(apiPath("/api/kitchen-cleaning/"), async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/tasks")) {
      return json(route, 200, [{ id: 7, area: "Kitchen", task: "Wipe surfaces", frequency: "daily", method: null, product: null, responsible: null, sort_order: 0 }]);
    }
    if (url.pathname.endsWith("/history")) return json(route, 200, []);
    await new Promise((r) => setTimeout(r, 300));
    return json(route, 200, null);
  });
  page.route(apiPath("/api/daily-track-am"), (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      const siteId = Number(url.searchParams.get("siteId")) || null;
      state.loads.push(siteId);
      return json(route, 200, state.rows.filter((row) => row.siteId === siteId));
    }
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData());
      state.posts.push(body);
      const row = { id: 100 + state.posts.length, ...body };
      state.rows.push(row);
      return json(route, 201, row);
    }
    return json(route, 404, { error: "unexpected" });
  });
  return state;
}

const kitchenCard = (page) => page.locator(".bg-card", { has: page.getByRole("heading", { name: "Kitchen Opening" }) });
const answer = (page, label, option) => kitchenCard(page).getByRole("radiogroup", { name: label }).getByRole("radio", { name: option });
const isSelected = async (page, label, option) => (await answer(page, label, option).getAttribute("aria-checked")) === "true";
const siteSelect = (page) => page.getByRole("combobox", { name: "Site", exact: true });
const workingSite = (page) => page.getByRole("combobox", { name: "Site you're working at" });

async function pickSite(page, name) {
  await siteSelect(page).click();
  await page.getByRole("option", { name }).click();
}

async function main() {
  const outDir = await buildHarness();
  const server = await serve(outDir);
  const base = `http://127.0.0.1:${server.address().port}/tests/browser/daily-checklist-site.html`;
  const executablePath = process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium"].find((p) => existsSync(p));
  const browser = await chromium.launch({ executablePath });
  const open = async (query = "", options = {}, context = null, ready = (page) => page.getByRole("heading", { name: "Kitchen Opening" })) => {
    const page = await (context ?? browser).newPage();
    page.setDefaultTimeout(5_000);
    if (process.env.DEBUG_BROWSER) page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
    const state = mockApi(page, options);
    await page.goto(base + query);
    await ready(page).waitFor();
    return { page, state };
  };
  try {
    await test("starts on the site of the user's own department", async () => {
      const { page, state } = await open("?dept=11");
      assert.equal(await siteSelect(page).textContent(), "Pro Shop");
      assert.deepEqual(state.loads, [2], "only the department's site is loaded, never 'no site'");
      await siteSelect(page).click();
      assert.equal(await page.getByRole("option", { name: "No site filter" }).count(), 0);
      assert.deepEqual(await page.getByRole("option").allTextContents(), ["Clubhouse", "Pro Shop", "Halfway House"]);
      await page.close();
    });

    await test("the link's site wins; with no department the first site is used", async () => {
      const linked = await open("?dept=11&siteId=3");
      assert.equal(await siteSelect(linked.page).textContent(), "Halfway House");
      await linked.page.close();
      const plain = await open("", { sitesDelayMs: 300 });
      assert.equal(await siteSelect(plain.page).textContent(), "Clubhouse");
      assert.deepEqual(plain.state.loads, [1]);
      await plain.page.close();
    });

    await test("answers survive changing the site and save against the new site", async () => {
      const { page, state } = await open("?dept=11");
      await answer(page, "Alpha check", "Pass").click();
      await answer(page, "Bravo check", "Fail").click();
      await kitchenCard(page).getByRole("textbox", { name: "Note for Bravo check" }).fill("Door seal torn");
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "1-own-site-preselected.png"), fullPage: true });

      await pickSite(page, "Clubhouse");
      await page.getByText("Your unsaved ticks are filled in below").waitFor();
      assert.equal(await siteSelect(page).textContent(), "Clubhouse");
      assert.equal(await isSelected(page, "Alpha check", "Pass"), true, "Alpha still Pass");
      assert.equal(await isSelected(page, "Bravo check", "Fail"), true, "Bravo still Fail");
      assert.equal(await kitchenCard(page).getByRole("textbox", { name: "Note for Bravo check" }).inputValue(), "Door seal torn");
      assert.match(page.url(), /siteId=1/, "the chosen site is kept in the address");
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "2-site-changed-ticks-kept.png"), fullPage: true });

      await kitchenCard(page).getByRole("button", { name: "Save draft" }).click();
      await page.getByText("Draft saved", { exact: true }).waitFor();
      assert.equal(state.posts.length, 1);
      assert.equal(state.posts[0].siteId, 1);
      assert.equal(state.posts[0].checklistType, "kitchen_opening");
      assert.deepEqual(state.posts[0].items.map((i) => [i.label, i.result ?? null, i.notes ?? null]), [
        ["Alpha check", "pass", null],
        ["Bravo check", "fail", "Door seal torn"],
      ]);

      // Once saved, the answers belong to Clubhouse and don't follow to another site.
      await pickSite(page, "Pro Shop");
      await answer(page, "Alpha check", "Pass").waitFor();
      assert.equal(await isSelected(page, "Alpha check", "Pass"), false);
      assert.equal(await page.getByText("Your unsaved ticks are filled in below").count(), 0);
      await page.close();
    });

    await test("a site with different wording keeps the matching answers", async () => {
      const { page, state } = await open("?dept=11");
      await answer(page, "Alpha check", "Pass").click();
      await answer(page, "Bravo check", "N/A").click();
      await pickSite(page, "Halfway House");
      await answer(page, "Charlie check", "Pass").waitFor();
      assert.equal(await isSelected(page, "Bravo check", "N/A"), true, "Bravo carried over");
      assert.equal(await isSelected(page, "Charlie check", "Pass"), false, "Charlie still to answer");
      await answer(page, "Charlie check", "Pass").click();
      await kitchenCard(page).getByRole("button", { name: "Submit checklist" }).click();
      await page.getByText("Checklist submitted", { exact: true }).waitFor();
      assert.equal(state.posts[0].siteId, 3);
      assert.deepEqual(state.posts[0].items.map((i) => [i.label, i.result]), [["Bravo check", "na"], ["Charlie check", "pass"]]);
      await page.close();
    });

    await test("an already-submitted site keeps the unsaved answers for an open one", async () => {
      const submitted = {
        id: 9, checklistType: "kitchen_opening", checkDate: new Date().toISOString().slice(0, 10), siteId: 1,
        items: [{ label: "Alpha check", checked: true, result: "pass" }, { label: "Bravo check", checked: true, result: "pass" }],
        completedBy: "Morning Team", submittedAt: "2026-10-29T07:00:00.000Z",
      };
      const { page } = await open("?dept=11", { rows: [submitted] });
      await answer(page, "Alpha check", "Fail").click();
      await pickSite(page, "Clubhouse");
      await page.getByText("This checklist is already submitted. Your unsaved ticks are kept").waitFor();
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, "3-already-submitted-site.png"), fullPage: true });
      assert.equal(await isSelected(page, "Alpha check", "Pass"), true, "the stored submitted answers are shown");
      await pickSite(page, "Pro Shop");
      await page.getByText("Your unsaved ticks are filled in below").waitFor();
      assert.equal(await isSelected(page, "Alpha check", "Fail"), true, "the unsaved answer is back");
      await page.close();
    });

    await test("the site picked last is remembered on this device", async () => {
      const context = await browser.newContext();
      const first = await open("", {}, context);
      await pickSite(first.page, "Halfway House");
      await answer(first.page, "Charlie check", "Pass").waitFor();
      await first.page.close();
      const again = await open("", {}, context);
      assert.equal(await siteSelect(again.page).textContent(), "Halfway House");
      await again.page.close();
      await context.close();
    });

    await test("RoomTrack: room checks survive narrowing to a site", async () => {
      const { page } = await open("?page=room-track", {}, null, (p) => p.getByRole("heading", { name: "101" }));
      assert.equal(await page.getByRole("combobox", { name: "Filter rooms by site" }).textContent(), "Clubhouse", "starts on the first site");
      await page.getByRole("combobox", { name: "Filter rooms by site" }).click();
      await page.getByRole("option", { name: "All sites" }).click();
      await page.getByRole("heading", { name: "201" }).waitFor();
      const room = page.locator(".border-l-4", { has: page.getByRole("heading", { name: "201" }) });
      await room.getByRole("button", { name: "Clean" }).click();
      await room.getByRole("textbox", { name: "Notes" }).fill("Kettle missing");
      await page.getByRole("combobox", { name: "Filter rooms by site" }).click();
      await page.getByRole("option", { name: "Pro Shop" }).click();
      await page.getByRole("heading", { name: "101" }).waitFor({ state: "detached" });
      assert.equal(await room.getByRole("button", { name: "Clean" }).getAttribute("aria-pressed"), "true");
      assert.equal(await room.getByRole("textbox", { name: "Notes" }).inputValue(), "Kettle missing");
      await page.getByRole("button", { name: "Refresh" }).click();
      await page.waitForTimeout(500);
      assert.equal(await room.getByRole("button", { name: "Clean" }).getAttribute("aria-pressed"), "true", "Refresh keeps it too");
      await page.close();
    });

    await test("site filters start on the user's own site, an Owner or Consultant on the first site", async () => {
      const staff = await open("?page=room-track&dept=11", {}, null, (p) => p.getByRole("heading", { name: "201" }));
      assert.equal(await staff.page.getByRole("combobox", { name: "Filter rooms by site" }).textContent(), "Pro Shop");
      await staff.page.getByRole("heading", { name: "101" }).waitFor({ state: "detached" });
      await staff.page.getByRole("combobox", { name: "Filter rooms by site" }).click();
      await staff.page.getByRole("option", { name: "All sites" }).click();
      await staff.page.getByRole("heading", { name: "101" }).waitFor();
      await staff.page.close();
      for (const role of ["client_admin", "consultant"]) {
        const owner = await open(`?page=room-track&dept=11&role=${role}`, {}, null, (p) => p.getByRole("heading", { name: "101" }));
        assert.equal(await owner.page.getByRole("combobox", { name: "Filter rooms by site" }).textContent(), "Clubhouse", role);
        assert.equal(await workingSite(owner.page).textContent(), "Clubhouse", role);
        await owner.page.close();
      }
    });

    await test("a Manager over several sites starts on their department's site and can switch between theirs", async () => {
      const { page } = await open("?page=room-track&role=client_manager&dept=11&depts=11,13", {}, null, (p) => p.getByRole("heading", { name: "201" }));
      assert.equal(await page.getByRole("combobox", { name: "Filter rooms by site" }).textContent(), "Pro Shop");
      assert.equal(await workingSite(page).textContent(), "Pro Shop");
      await workingSite(page).click();
      assert.deepEqual(await page.getByRole("option").allTextContents(), ["Pro Shop", "Halfway House"], "only their own sites, no All sites");
      await page.getByRole("option", { name: "Halfway House" }).click();
      // Every page now starts on the new working site.
      await page.reload();
      await page.getByRole("heading", { name: "201" }).waitFor({ state: "detached" });
      assert.equal(await page.getByRole("combobox", { name: "Filter rooms by site" }).textContent(), "Halfway House");
      await page.close();
    });

    await test("an Owner picks a site in the top bar, then every page starts on it", async () => {
      const context = await browser.newContext();
      const first = await open("?page=room-track&role=client_admin", {}, context, (p) => p.getByRole("heading", { name: "101" }));
      assert.equal(await workingSite(first.page).textContent(), "Clubhouse");
      await workingSite(first.page).click();
      assert.deepEqual(await first.page.getByRole("option").allTextContents(), ["Clubhouse", "Pro Shop", "Halfway House"]);
      await first.page.getByRole("option", { name: "Pro Shop" }).click();
      await first.page.getByRole("heading", { name: "201" }).waitFor();
      assert.equal(await first.page.getByRole("combobox", { name: "Filter rooms by site" }).textContent(), "Pro Shop");
      await first.page.close();
      const later = await open("?page=daily-am&role=client_admin", {}, context);
      assert.equal(await siteSelect(later.page).textContent(), "Pro Shop");
      await later.page.close();
      await context.close();
    });

    await test("KitchenTrack cleaning: ticks survive changing the kitchen", async () => {
      const { page } = await open("?page=kitchen-cleaning", {}, null, (p) => p.getByRole("checkbox", { name: "Wipe surfaces" }));
      await page.getByRole("checkbox", { name: "Wipe surfaces" }).click();
      await page.getByPlaceholder("Notes (optional)").fill("Used blue cloth");
      await page.getByRole("combobox", { name: "Kitchen" }).click();
      await page.getByRole("option", { name: "Pro Shop" }).click();
      await page.getByRole("checkbox", { name: "Wipe surfaces" }).waitFor();
      await page.waitForTimeout(500);
      assert.equal(await page.getByRole("checkbox", { name: "Wipe surfaces" }).getAttribute("aria-checked"), "true");
      assert.equal(await page.getByPlaceholder("Notes (optional)").inputValue(), "Used blue cloth");
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
  console.log(`${passed} daily checklist site browser checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
