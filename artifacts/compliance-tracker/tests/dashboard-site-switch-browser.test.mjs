// Real-browser (Chromium via Playwright) checks that rapid site switching on
// the dashboard never mixes sites: the selected site, the "Today's
// checklists" strip and the Daily AM / PM cards always describe the same
// site, whatever order the summary responses arrive in.
//
// The real dashboard page is mounted by tests/browser/dashboard.harness.tsx
// and built with the app's React and Tailwind setup. Every API request is
// intercepted; /api/dashboard/summary responses are held until the test
// releases them, so the test decides which site's answer lands first.
//
// Run with: pnpm --filter @workspace/compliance-tracker run test:dashboard-site-switch-browser
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
        { find: "@/context/auth-context", replacement: path.join(harnessDir, "dashboard-auth.stub.ts") },
        { find: "@/components/layout", replacement: path.join(harnessDir, "dashboard-layout.stub.tsx") },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(harnessDir, "dashboard.html") } },
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

// ── Fixture: three sites with different checklist progress today ────────────

const TODAY = "2026-10-16";
const SITES = [
  { id: 11, name: "Harbour Kitchen" },
  { id: 22, name: "Hilltop Cafe" },
  { id: 33, name: "Riverside Deli" },
];
// Harbour has done AM only, Hilltop PM only, Riverside neither, so every
// scope gives a different strip and different Daily AM / PM cards.
const DONE = { 11: { am: true, pm: false }, 22: { am: false, pm: true }, 33: { am: false, pm: false } };
const siteName = (scope) => (scope === "all" ? "All sites" : SITES.find((s) => String(s.id) === scope).name);
const sitesIn = (scope) => (scope === "all" ? SITES : SITES.filter((s) => String(s.id) === scope));

/** What the dashboard should show for a scope, built the way dashboard-summary.ts builds it. */
function expected(scope) {
  const sites = sitesIn(scope);
  const done = (branch) => sites.filter((s) => DONE[s.id][branch]).length;
  const missing = (branch) => sites.filter((s) => !DONE[s.id][branch]).map((s) => s.name);
  const badge = (branch) => (missing(branch).length === 0
    ? "All submitted"
    : `${missing(branch).length} site${missing(branch).length === 1 ? "" : "s"} not submitted`);
  return {
    selected: siteName(scope),
    am: `${done("am")}/${sites.length} AM complete`,
    pm: `${done("pm")}/${sites.length} PM complete`,
    total: `${done("am") + done("pm")}/${sites.length * 2} checklists complete`,
    amBadge: badge("am"),
    pmBadge: badge("pm"),
    amMissing: missing("am"),
    pmMissing: missing("pm"),
  };
}

/** The /api/dashboard/summary body for a scope (only the fields the page reads). */
function summaryFor(scope) {
  const sites = sitesIn(scope);
  const e = expected(scope);
  const daily = (branch) => {
    const missing = branch === "am" ? e.amMissing : e.pmMissing;
    const path = branch === "am" ? "/daily-track-am" : "/daily-track-pm";
    return {
      trackId: branch === "am" ? "daily_am" : "daily_pm",
      label: branch === "am" ? "Daily AM Checklist" : "Daily PM Sign-off",
      path,
      enabled: true,
      status: missing.length === 0 ? "ok" : branch === "am" ? "overdue" : "attention",
      health: missing.length === 0 ? "clear" : "action_required",
      badge: branch === "am" ? e.amBadge : e.pmBadge,
      items: missing.map((name) => ({
        label: name,
        detail: `${branch.toUpperCase()} checklist not submitted today`,
        path: `${path}?siteId=${SITES.find((s) => s.name === name).id}`,
      })),
    };
  };
  return {
    tracks: [daily("am"), daily("pm")],
    checklistTotals: {
      date: TODAY,
      available: true,
      expectedAmPairs: sites.length,
      completedAmPairs: sites.filter((s) => DONE[s.id].am).length,
      expectedPmPairs: sites.length,
      completedPmPairs: sites.filter((s) => DONE[s.id].pm).length,
      completedSitePairs: sites.filter((s) => DONE[s.id].am && DONE[s.id].pm).length,
      outstanding: sites
        .filter((s) => !DONE[s.id].am || !DONE[s.id].pm)
        .map((s) => ({ siteId: s.id, siteName: s.name, am: !DONE[s.id].am, pm: !DONE[s.id].pm })),
    },
  };
}

// ── API interception ─────────────────────────────────────────────────────────

/**
 * Answers the page's background reads at once and holds every dashboard
 * summary request until the test releases it with `nextSummary(scope)`.
 */
function mockApi(page, extra = {}) {
  const held = [];
  const waiters = [];
  const json = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const wake = () => {
    for (const waiter of [...waiters]) {
      const index = held.findIndex((h) => h.scope === waiter.scope);
      if (index === -1) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(held.splice(index, 1)[0]);
    }
  };
  page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  // A URL predicate, not a glob: generated hooks and apiFetch may append ?clientId=.
  page.route((url) => url.pathname.includes("/api/"), (route) => {
    const url = new URL(route.request().url());
    const apiPath = url.pathname.slice(url.pathname.indexOf("/api/") + 4);
    if (apiPath === "/dashboard/summary") {
      held.push({ scope: url.searchParams.get("siteId") ?? "all", route });
      wake();
      return;
    }
    if (apiPath in extra) return json(route, 200, extra[apiPath]);
    if (apiPath === "/sites") return json(route, 200, SITES);
    if (apiPath === "/setup/state") return json(route, 200, { needsSetup: false, canManage: false });
    if (apiPath === "/food-safety/status") return json(route, 200, []);
    return json(route, 200, []);
  });

  /** Waits for the next summary request for `scope` and returns controls to answer it. */
  async function nextSummary(scope) {
    const request = await Promise.race([
      new Promise((resolve) => { waiters.push({ scope, resolve }); wake(); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no dashboard summary request for ${scope}`)), 5_000)),
    ]);
    // Resolves to false when the page had already cancelled the request.
    const deliver = (status, body) => json(request.route, status, body).then(() => true, () => false);
    return {
      respond: () => deliver(200, summaryFor(scope)),
      fail: (status, error) => deliver(status, { error }),
    };
  }
  return { nextSummary, pending: () => held.map((h) => h.scope) };
}

// ── Reading the screen ───────────────────────────────────────────────────────

const strip = (page) => page.getByRole("region", { name: "Today's checklists" });
const dailyRow = (page, label) => page.getByRole("link", { name: new RegExp(`^Open ${label}:`) })
  .locator("xpath=ancestor::div[contains(@class, 'rounded-r-md')][1]");

/** Lets any response the test just released reach the page before a "nothing changed" check. */
const settle = (page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));

async function pickSite(page, name) {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name, exact: true }).click();
}

async function missingSites(page, label) {
  const row = dailyRow(page, label);
  const toggle = row.getByRole("button", { name: new RegExp(`${label} checks$`) });
  if (await toggle.count() === 0) return [];
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return row.locator("p.font-medium").allInnerTexts();
}

/** Asserts the selector, strip and Daily AM / PM cards all describe `scope`, and nothing else. */
async function expectShowing(page, scope, context) {
  const e = expected(scope);
  const at = `${context} (expected ${e.selected})`;
  await strip(page).getByText(e.total, { exact: true }).waitFor();
  assert.equal((await page.getByRole("combobox").innerText()).trim(), e.selected, `selected site, ${at}`);
  const stripText = await strip(page).innerText();
  assert.ok(stripText.includes(e.am), `strip AM count "${e.am}", ${at}; got: ${stripText}`);
  assert.ok(stripText.includes(e.pm), `strip PM count "${e.pm}", ${at}; got: ${stripText}`);
  assert.ok((await dailyRow(page, "Daily AM Checklist").innerText()).includes(e.amBadge), `AM card badge "${e.amBadge}", ${at}`);
  assert.ok((await dailyRow(page, "Daily PM Sign-off").innerText()).includes(e.pmBadge), `PM card badge "${e.pmBadge}", ${at}`);
  assert.deepEqual(await missingSites(page, "Daily AM Checklist"), e.amMissing, `AM card sites, ${at}`);
  assert.deepEqual(await missingSites(page, "Daily PM Sign-off"), e.pmMissing, `PM card sites, ${at}`);
  assert.equal(await page.getByRole("alert").count(), 0, `no error banner, ${at}`);
}

/** Asserts the page is loading `scope` and shows no site's results as current. */
async function expectLoading(page, scope, context) {
  const at = `${context} (loading ${siteName(scope)})`;
  assert.equal((await page.getByRole("combobox").innerText()).trim(), siteName(scope), `selected site, ${at}`);
  const stripText = await strip(page).innerText();
  assert.ok(stripText.includes("Loading"), `strip shows loading, ${at}; got: ${stripText}`);
  assert.doesNotMatch(stripText, /\d+\/\d+/, `strip shows no counts while loading, ${at}`);
  assert.doesNotMatch(stripText, /not applicable|unavailable/i, `strip shows no stale status while loading, ${at}`);
  assert.doesNotMatch(await strip(page).getAttribute("class"), /emerald|amber|rose/,
    `strip keeps no earlier status colour while loading, ${at}`);
  assert.equal(await page.getByRole("link", { name: /^Open Daily (AM|PM) / }).count(), 0, `no Daily AM / PM cards while loading, ${at}`);
  assert.equal(await page.getByRole("alert").count(), 0, `no error banner while loading, ${at}`);
}

async function main() {
  const outDir = await buildHarness();
  const server = await serve(outDir);
  const base = `http://127.0.0.1:${server.address().port}/tests/browser/dashboard.html`;
  const executablePath = process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium"].find((p) => existsSync(p));
  const browser = await chromium.launch({ executablePath });
  /** Opens the dashboard and lets the first (all sites) summary load. */
  const open = async (extra) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    if (process.env.DEBUG_BROWSER) page.on("console", (m) => console.log("[browser]", m.type(), m.text()));
    const api = mockApi(page, extra);
    await page.goto(base);
    await (await api.nextSummary("all")).respond();
    await expectShowing(page, "all", "first load");
    return { page, api };
  };
  try {
    await test("a late answer for the earlier site never replaces the latest site", async () => {
      const { page, api } = await open();
      await pickSite(page, "Harbour Kitchen");
      const harbour = await api.nextSummary("11");
      await pickSite(page, "Hilltop Cafe");
      const hilltop = await api.nextSummary("22");
      await expectLoading(page, "22", "both requests in flight");

      await hilltop.respond();
      await expectShowing(page, "22", "latest answer first");
      await harbour.respond();
      await settle(page);
      await expectShowing(page, "22", "after the earlier site's late answer");
      await page.close();
    });

    await test("an earlier site's answer arriving first is not shown while the latest site loads", async () => {
      const { page, api } = await open();
      await pickSite(page, "Hilltop Cafe");
      const hilltop = await api.nextSummary("22");
      await pickSite(page, "Riverside Deli");
      const riverside = await api.nextSummary("33");

      await hilltop.respond();
      await settle(page);
      await expectLoading(page, "33", "after the earlier site answered first");
      await riverside.respond();
      await expectShowing(page, "33", "latest answer last");
      await page.close();
    });

    await test("switching back and forth lands on the last site picked", async () => {
      const { page, api } = await open();
      const answers = [];
      for (const [name, id] of [["Harbour Kitchen", "11"], ["Riverside Deli", "33"], ["Harbour Kitchen", "11"], ["All sites", "all"], ["Hilltop Cafe", "22"]]) {
        await pickSite(page, name);
        answers.push(await api.nextSummary(id));
      }
      await expectLoading(page, "22", "after five quick switches");
      // Answer newest first, then the rest out of order.
      for (const index of [4, 0, 3, 1, 2]) await answers[index].respond();
      await settle(page);
      await expectShowing(page, "22", "after every answer arrived out of order");
      await page.close();
    });

    await test("loading a new site hides the previous site's strip and cards", async () => {
      const { page, api } = await open();
      await pickSite(page, "Harbour Kitchen");
      await (await api.nextSummary("11")).respond();
      await expectShowing(page, "11", "Harbour loaded");
      await pickSite(page, "Riverside Deli");
      const riverside = await api.nextSummary("33");
      await expectLoading(page, "33", "switched away from Harbour");
      await riverside.respond();
      await expectShowing(page, "33", "Riverside loaded");
      await page.close();
    });

    await test("an error for the latest site shows no earlier site's results", async () => {
      const { page, api } = await open();
      await pickSite(page, "Harbour Kitchen");
      const harbour = await api.nextSummary("11");
      await pickSite(page, "Hilltop Cafe");
      await (await api.nextSummary("22")).fail(500, "Database unavailable");
      await page.getByRole("alert").getByText("Database unavailable").waitFor();
      await harbour.respond();
      await settle(page);
      assert.equal((await page.getByRole("combobox").innerText()).trim(), "Hilltop Cafe");
      assert.equal(await strip(page).count(), 0, "no checklist strip beside the error");
      assert.equal(await page.getByRole("link", { name: /^Open Daily (AM|PM) / }).count(), 0, "no Daily AM / PM cards beside the error");
      assert.equal(await page.getByRole("alert").count(), 1, "the error stays");
      await page.close();
    });

    await test("an earlier site's late error does not replace the latest site's results", async () => {
      const { page, api } = await open();
      await pickSite(page, "Riverside Deli");
      const riverside = await api.nextSummary("33");
      await pickSite(page, "Harbour Kitchen");
      await (await api.nextSummary("11")).respond();
      await expectShowing(page, "11", "latest site loaded");
      await riverside.fail(500, "Riverside timed out");
      await settle(page);
      await expectShowing(page, "11", "after the earlier site's late error");
      await page.close();
    });

    await test("a retry still in flight when the site changes cannot overwrite the new site", async () => {
      const { page, api } = await open();
      await pickSite(page, "Harbour Kitchen");
      await (await api.nextSummary("11")).fail(503, "Service busy");
      await page.getByRole("button", { name: "Retry" }).click();
      const retry = await api.nextSummary("11");
      await expectLoading(page, "11", "retrying Harbour");
      await pickSite(page, "Hilltop Cafe");
      const hilltop = await api.nextSummary("22");
      await hilltop.respond();
      await expectShowing(page, "22", "switched during the retry");
      await retry.respond();
      await settle(page);
      await expectShowing(page, "22", "after the old retry answered");
      await page.close();
    });

    await test("each checklist still to do links to that site's checklist", async () => {
      const { page, api } = await open();
      const links = await strip(page).getByRole("link", { name: /^Open .* (AM|PM) checklist$/ })
        .evaluateAll((els) => els.map((el) => [el.getAttribute("aria-label"), el.getAttribute("href")]));
      assert.deepEqual(links, [
        ["Open Harbour Kitchen PM checklist", "/daily-track-pm?siteId=11"],
        ["Open Hilltop Cafe AM checklist", "/daily-track-am?siteId=22"],
        ["Open Riverside Deli AM checklist", "/daily-track-am?siteId=33"],
        ["Open Riverside Deli PM checklist", "/daily-track-pm?siteId=33"],
      ]);
      await pickSite(page, "Harbour Kitchen");
      await (await api.nextSummary("11")).respond();
      await expectShowing(page, "11", "Harbour loaded");
      assert.deepEqual(
        await strip(page).getByRole("link", { name: /checklist$/ }).evaluateAll((els) => els.map((el) => el.getAttribute("href"))),
        ["/daily-track-pm?siteId=11"],
        "only Harbour's PM checklist is still to do",
      );
      await page.close();
    });

    await test("a count in the summary bar lists those tracks with their checks open", async () => {
      const { page, api } = await open();
      await pickSite(page, "Harbour Kitchen");
      await (await api.nextSummary("11")).respond();
      await expectShowing(page, "11", "Harbour loaded");
      // Harbour: AM done (complete), PM missing (requires action).
      await page.getByRole("button", { name: "1 track requires action" }).click();
      assert.equal(await page.getByRole("link", { name: /^Open Daily AM Checklist:/ }).count(), 0, "AM card hidden by the filter");
      const pm = dailyRow(page, "Daily PM Sign-off");
      assert.equal(await pm.getByRole("button", { name: /PM Sign-off checks$/ }).getAttribute("aria-expanded"), "true", "PM checks open");
      const siteLink = pm.getByRole("link", { name: /Harbour Kitchen/ });
      assert.equal(await siteLink.getAttribute("href"), "/daily-track-pm?siteId=11", "second click opens Harbour's PM checklist");
      await page.getByRole("button", { name: "1 complete" }).click();
      assert.equal(await page.getByRole("link", { name: /^Open Daily PM Sign-off:/ }).count(), 0, "PM card hidden by the complete filter");
      assert.ok(await page.getByRole("link", { name: /^Open Daily AM Checklist:/ }).count() > 0, "AM card shown");
      await page.getByRole("button", { name: "Show all tracks" }).click();
      assert.ok(await page.getByRole("link", { name: /^Open Daily PM Sign-off:/ }).count() > 0, "PM card back");
      assert.ok(await page.getByRole("link", { name: /^Open Daily AM Checklist:/ }).count() > 0, "AM card still shown");
      await page.close();
    });

    await test("every department bar opens, even with nothing outstanding", async () => {
      const departments = { date: TODAY, groups: [{ siteId: 11, siteName: "Harbour Kitchen", rows: [
        { key: "1", kind: "department", departmentId: 1, name: "Kitchen", done: 1, todo: 1, failed: 0, moreItems: 0,
          items: [{ status: "todo", label: "Kitchen closing checks", detail: "Not submitted yet", path: "/daily-track-pm?siteId=11" }] },
        { key: "2", kind: "department", departmentId: 2, name: "Front of house", done: 2, todo: 0, failed: 0, moreItems: 0, items: [] },
      ] }] };
      const { page } = await open({ "/dashboard/today-by-department": departments });
      const card = page.getByTestId("card-today-by-department");
      await card.getByRole("button", { name: /^Kitchen/ }).click();
      assert.equal(await card.getByRole("link", { name: /Kitchen closing checks/ }).getAttribute("href"), "/daily-track-pm?siteId=11");
      const done = card.getByRole("button", { name: /^Front of house/ });
      assert.equal(await done.isEnabled(), true, "a bar with everything done can still be clicked");
      await done.click();
      await card.getByText("Everything due here today is done.").waitFor();
      assert.deepEqual(
        await card.getByRole("link", { name: /checklists|Tasks/ }).evaluateAll((els) => els.map((el) => el.getAttribute("href"))),
        ["/daily-track-am?siteId=11", "/daily-track-pm?siteId=11", "/tasks"],
      );
      await page.close();
    });

    await test("retry reloads the selected site", async () => {
      const { page, api } = await open();
      await pickSite(page, "Riverside Deli");
      await (await api.nextSummary("33")).fail(503, "Service busy");
      await page.getByRole("alert").getByText("Service busy").waitFor();
      await page.getByRole("button", { name: "Retry" }).click();
      await (await api.nextSummary("33")).respond();
      await expectShowing(page, "33", "after retry");
      assert.deepEqual(api.pending(), [], "no extra summary requests");
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    await rm(outDir, { recursive: true, force: true });
  }
  console.log(`${passed} dashboard site switching browser checks passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
