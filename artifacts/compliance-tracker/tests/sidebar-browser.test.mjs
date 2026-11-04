import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the grouped sidebar (src/components/layout.tsx and
// src/lib/nav-groups.ts), on the desktop sidebar and the phone drawer.
// Sections:
//   - Home, Set up and Compliance start open and the rest closed; a section of only locked links stays closed,
//   - the current page's section opens, on load and on navigation,
//   - open/closed choices survive a reload and are kept per user and per business.
// Pinned links:
//   - an available link can be pinned and unpinned; a locked one has no pin,
//   - pins show at the top on desktop and in the phone drawer, and survive a reload,
//   - pins are kept per user and per business,
//   - a pin for a module the business loses is removed for good,
//   - at most MAX_PINNED_NAV_ITEMS can be pinned.
// Scrolling (desktop):
//   - the sidebar and the page scroll separately; scrolling one never moves the other.
// The API is mocked: /api/auth/me returns the session below, everything else
// returns an empty list, which every page tolerates as "no records".
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
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
const chromiumPath = () => process.env.CHROMIUM_PATH
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(path => existsSync(path));

const session = { userId: 7, clientId: 1, role: "client_admin", services: ["firetrack", "kitchentrack"] };
function authMe() {
  return {
    user: {
      id: session.userId, email: "manager@example.test", name: "Morgan Manager", role: session.role,
      clientId: session.clientId, departmentId: null, active: true, totpEnabled: true,
    },
    client: { id: session.clientId, name: `Business ${session.clientId}`, primaryColor: "#7FA8C9", logoUrl: null },
    services: session.services,
    billingLocked: false,
    twoFactorRequired: false,
  };
}

const pinKey = () => `complytrack:nav-pins:${session.userId}:${session.clientId}`;
const storedPins = page => page.evaluate(key => JSON.parse(window.localStorage.getItem(key) ?? "[]"), pinKey());
const groupKey = id => `complytrack:nav:${session.userId}:${session.clientId}:${id}`;
const pinnedLabels = scope => scope.locator('[data-testid="nav-pinned"] a').allInnerTexts()
  .then(texts => texts.map(t => t.trim()));

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/auth/me")) return route.fulfill({ json: authMe() });
    if (path.endsWith("/api/auth/csrf")) return route.fulfill({ json: { csrfToken: "test" } });
    // The header's notification bell (#92) and the app-wide storage limit banner (#156).
    if (path.endsWith("/api/notifications")) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path.endsWith("/api/managed-by")) return route.fulfill({ json: null });
    if (path.endsWith("/api/storage/status")) {
      return route.fulfill({ json: { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null } });
    }
    // KitchenTrack's "This month" summary (#273) is an object, not a list; without it the card stays hidden.
    if (path.endsWith("/api/food-safety/month-summary")) return route.fulfill({ status: 404, json: { error: "Not found" } });
    return route.fulfill({ json: [] });
  });

  const desktop = page.locator("aside");
  async function load(path = "/asbestos") {
    await page.goto(`${baseUrl}${path}`);
    // The desktop sidebar is hidden (not just closed) at phone width.
    await desktop.getByRole("button", { name: "Home", exact: true, includeHidden: true }).waitFor({ state: "attached" });
  }

  const sectionTrigger = (scope, title) => scope.getByRole("button", { name: title, exact: true });
  const isOpen = (scope, title) => sectionTrigger(scope, title).getAttribute("aria-expanded").then(v => v === "true");
  const openStates = async scope => Object.fromEntries(await Promise.all(
    ["Home", "Set up", "Compliance", "Safety", "Food & Water", "Operations", "Greenkeeping", "People & Training", "Reporting", "Other", "Administration"]
      .map(async title => [title, await isOpen(scope, title)])));

  // ─── Sections ─────────────────────────────────────────────────────────────
  await load("/account-security");
  assert.deepEqual(await openStates(desktop), {
    // Greenkeeping starts open only when GreenTrack is unlocked; here it is locked.
    Home: true, "Set up": true, Compliance: true, Safety: false, "Food & Water": false, Operations: false,
    Greenkeeping: false, "People & Training": false, Reporting: false, Other: false, Administration: false,
  }, "Home, Set up and Compliance start open and the rest closed");

  // Sections run in the order a business sets up the service.
  const sectionOrder = await desktop.locator("nav button[aria-expanded]").allTextContents();
  assert.deepEqual(sectionOrder.map(t => t.trim()),
    ["Home", "Set up", "Compliance", "Safety", "Food & Water", "Operations", "Greenkeeping", "People & Training", "Reporting", "Other", "Administration"],
    "Sections follow the setup order");

  // The current page's section opens on load, even over a saved close.
  await page.evaluate(key => window.localStorage.setItem(key, "false"), groupKey("food-water"));
  await load("/kitchen");
  assert.ok(await isOpen(desktop, "Food & Water"), "The current page's section opens despite a saved close");

  // ...and on in-app navigation (as a page link or a pinned link does) into a closed section.
  assert.equal(await isOpen(desktop, "Safety"), false);
  await page.evaluate(() => {
    window.history.pushState(null, "", "/asbestos");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await desktop.locator('a[href="/asbestos"]').waitFor();
  assert.ok(await isOpen(desktop, "Safety"), "Navigating opens the new page's section");

  // A toggle is saved and survives a reload.
  await sectionTrigger(desktop, "Home").click();
  await sectionTrigger(desktop, "Reporting").click();
  assert.equal(await page.evaluate(key => window.localStorage.getItem(key), groupKey("core")), "false");
  await load("/account-security");
  assert.ok(!(await isOpen(desktop, "Home")) && await isOpen(desktop, "Reporting"), "Saved section state survives a reload");

  // Another business, and another user on the same business, start from the defaults.
  session.clientId = 2;
  await load("/account-security");
  assert.ok(await isOpen(desktop, "Home") && !(await isOpen(desktop, "Reporting")), "Section state is per business");
  session.clientId = 1;
  session.userId = 8;
  await load("/account-security");
  assert.ok(await isOpen(desktop, "Home") && !(await isOpen(desktop, "Reporting")), "Section state is per user");
  session.userId = 7;
  await load("/account-security");
  assert.ok(!(await isOpen(desktop, "Home")), "The first user's choice is still there");
  await sectionTrigger(desktop, "Home").click();
  await sectionTrigger(desktop, "Reporting").click();

  // A section whose links are all locked stays closed, even when saved open.
  session.role = "client_staff"; // no Users/Staff Roster, so People & Training is DocTrack + TrainTrack only
  await page.evaluate(key => window.localStorage.setItem(key, "true"), groupKey("people-training"));
  await load("/account-security");
  assert.equal(await isOpen(desktop, "People & Training"), false, "A locked-only section stays closed");
  assert.equal(await desktop.locator('a[href="/doc-track"]').count(), 0);
  session.services = ["firetrack", "kitchentrack", "doctrack"];
  await load("/account-security");
  assert.ok(await isOpen(desktop, "People & Training"), "It opens to the saved choice once a module in it is unlocked");
  session.services = ["firetrack", "kitchentrack"];
  session.role = "client_admin";
  await page.evaluate(key => window.localStorage.removeItem(key), groupKey("people-training"));

  // Phone drawer: same defaults and saved state as the desktop sidebar.
  await page.setViewportSize({ width: 390, height: 844 });
  await load("/account-security");
  await page.locator("header button").first().click();
  let drawer = page.getByRole("dialog");
  await sectionTrigger(drawer, "Home").waitFor();
  assert.ok(await isOpen(drawer, "Home") && !(await isOpen(drawer, "Operations")), "The drawer starts with the same sections open");
  await sectionTrigger(drawer, "Operations").click();
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  await page.locator("header button").first().click();
  drawer = page.getByRole("dialog");
  assert.ok(await isOpen(drawer, "Operations"), "A drawer toggle is kept when the drawer reopens");
  await drawer.locator('a[href="/fix-track"]').click();
  await page.waitForURL(`${baseUrl}/fix-track`);
  await drawer.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await load("/account-security");
  assert.ok(await isOpen(desktop, "Operations"), "The drawer and desktop sidebar share saved state");
  await sectionTrigger(desktop, "Operations").click();

  // ─── Pinned links ─────────────────────────────────────────────────────────
  await load();
  assert.equal(await desktop.locator('[data-testid="nav-pinned"]').count(), 0, "No pinned section until something is pinned");
  assert.equal(await desktop.getByRole("button", { name: "Pin LegionellaTrack" }).count(), 0,
    "A locked module has no pin button");
  assert.equal(await desktop.getByRole("button", { name: "Pin Asbestos Register" }).count(), 1,
    "Links without a service key can be pinned");

  // Pin FireTrack (Safety, open because /asbestos is in it) and Dashboard (Home).
  await desktop.locator('a[href="/fire-safety"]').hover();
  await desktop.getByRole("button", { name: "Pin FireTrack" }).click();
  await desktop.getByRole("button", { name: "Pin Dashboard" }).click();
  assert.deepEqual(await pinnedLabels(desktop), ["FireTrack", "Dashboard"], "Pins appear at the top in pin order");
  assert.deepEqual(await storedPins(page), ["/fire-safety", "/dashboard"]);
  assert.equal(await desktop.getByRole("button", { name: "Unpin FireTrack" }).count(), 2,
    "A pinned link can be unpinned from the pinned list or its group");

  await load();
  assert.deepEqual(await pinnedLabels(desktop), ["FireTrack", "Dashboard"], "Pins survive a reload");

  // Phone drawer: same pins, buttons always shown, a pinned link navigates and closes the drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("header button").first().click();
  drawer = page.getByRole("dialog");
  await drawer.locator('[data-testid="nav-pinned"]').waitFor();
  assert.deepEqual(await pinnedLabels(drawer), ["FireTrack", "Dashboard"], "The phone drawer shows the same pins");
  const drawerPinOpacity = await drawer.getByRole("button", { name: "Pin Asbestos Register" })
    .evaluate(el => Number(getComputedStyle(el).opacity));
  assert.ok(drawerPinOpacity > 0, "Pin buttons are visible in the drawer without hover");
  await drawer.locator('[data-testid="nav-pinned"] a[href="/fire-safety"]').click();
  await page.waitForURL(`${baseUrl}/fire-safety`);
  await drawer.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Unpin from the pinned list.
  await load();
  await desktop.locator('[data-testid="nav-pinned"]').getByRole("button", { name: "Unpin Dashboard" }).click();
  assert.deepEqual(await pinnedLabels(desktop), ["FireTrack"]);
  assert.deepEqual(await storedPins(page), ["/fire-safety"]);

  // Another business for the same user starts with no pins and keeps its own.
  session.clientId = 2;
  await load();
  assert.equal(await desktop.locator('[data-testid="nav-pinned"]').count(), 0, "Pins are per business");
  session.clientId = 1;

  // The business loses FireTrack: the pin goes, and stays gone if it comes back.
  session.services = ["kitchentrack"];
  await load();
  assert.equal(await desktop.locator('[data-testid="nav-pinned"]').count(), 0, "A pin for a lost module is hidden");
  assert.deepEqual(await storedPins(page), [], "A pin for a lost module is removed from storage");
  session.services = ["firetrack", "kitchentrack"];
  await load();
  assert.equal(await desktop.locator('[data-testid="nav-pinned"]').count(), 0, "A removed pin doesn't come back");

  // The limit: six pins, then the remaining pin buttons are disabled.
  await page.evaluate(([key]) => window.localStorage.setItem(key, JSON.stringify(
    ["/dashboard", "/tasks", "/compliance-hub", "/calendar", "/external", "/contractors"])), [pinKey()]);
  await load();
  assert.equal((await pinnedLabels(desktop)).length, 6);
  assert.ok(await desktop.getByRole("button", { name: "Pin Asbestos Register" }).isDisabled(),
    "A seventh pin is refused");
  assert.ok(await desktop.getByRole("button", { name: "Unpin Other reminders" }).first().isEnabled());

  // ─── Scrolling ────────────────────────────────────────────────────────────
  // A short window and a long page, so both the sidebar and the page overflow.
  await page.setViewportSize({ width: 1280, height: 500 });
  await load();
  const nav = page.getByTestId("desktop-sidebar-nav");
  const content = page.getByTestId("page-scroll");
  await content.evaluate(el => {
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    el.firstElementChild.appendChild(spacer);
  });
  const scrollTops = async () => ({
    nav: await nav.evaluate(el => el.scrollTop),
    content: await content.evaluate(el => el.scrollTop),
    window: await page.evaluate(() => window.scrollY),
  });
  assert.ok(await nav.evaluate(el => el.scrollHeight > el.clientHeight), "The sidebar overflows the short window");
  const navBox = await nav.boundingBox();
  await page.mouse.move(navBox.x + navBox.width / 2, navBox.y + navBox.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-sidebar-nav"]').scrollTop > 0);
  let tops = await scrollTops();
  assert.equal(tops.content, 0, "Scrolling the sidebar leaves the page where it was");
  assert.equal(tops.window, 0, "Scrolling the sidebar doesn't scroll the window");
  const navTop = tops.nav;
  const contentBox = await content.boundingBox();
  await page.mouse.move(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('[data-testid="page-scroll"]').scrollTop > 0);
  tops = await scrollTops();
  assert.equal(tops.nav, navTop, "Scrolling the page leaves the sidebar where it was");
  assert.equal(tops.window, 0, "The page scrolls inside its own column");
  // Scrolling the sidebar past its end doesn't carry on into the page.
  await page.mouse.move(navBox.x + navBox.width / 2, navBox.y + navBox.height / 2);
  await page.mouse.wheel(0, 5000);
  await page.waitForTimeout(300);
  assert.equal((await scrollTops()).content, tops.content, "The sidebar's end doesn't scroll the page");
  await page.setViewportSize({ width: 1280, height: 900 });

  assert.deepEqual(pageErrors, [], "No page errors");
  console.log("Sidebar sections, pinned links and scrolling browser tests passed.");
} finally {
  await browser?.close();
  vite.kill();
}
