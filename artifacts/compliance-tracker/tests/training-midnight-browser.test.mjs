import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the TrainTrack certificates tab (src/pages/train-track.tsx)
// left open across local midnight. Expiry is date-only (src/lib/training-matrix.ts,
// src/lib/training-expiry.ts): a certificate expiring today is still "Expiring
// Soon", and one 30 days out has just entered the window. With the browser
// clock under test control, in Europe/London on the night the clocks go back:
//   - at local midnight the counts, banner, row colours, ordering and day
//     labels move to the new day without a reload,
//   - a tab that slept through midnight catches up when it is shown again,
//   - day labels are calendar days during BST ("Today", not "1d").

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

const CLIENT_ID = 31;
const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
const cert = (id, staff_name, expiry_date) => ({
  id, record_type: "certificate", staff_name, staff_roster_id: id, training_type: "First Aid", provider: "Red Cross",
  site_id: null, completed_date: "2024-01-01", expiry_date, document_title: null, trainer: null, notes: null,
  signed_at: null, signature: null, created_at: "2024-01-01T00:00:00Z",
});
const records = [
  cert(1, "Alex Today", "2026-10-24"),      // 24 Oct: due today. 25 Oct: expired.
  cert(2, "Blake Thirty", "2026-11-24"),    // 24 Oct: 31 days. 25 Oct: 30 days, expiring soon.
  cert(3, "Casey Later", "2027-06-01"),     // valid throughout
  cert(4, "Drew Thirty", "2026-11-25"),     // 25 Oct: 31 days. 26 Oct: 30 days, expiring soon.
];
const unexpectedRequests = [];
async function routeApi(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (method === "GET") {
    switch (url.pathname) {
      case "/api/auth/csrf-token": return json(route, { token: "training-midnight-csrf" });
      case "/api/auth/me": return json(route, {
        user: { id: 9, email: "manager@example.test", name: "Site Manager", role: "client_admin", clientId: CLIENT_ID, departmentId: null, active: true, totpEnabled: true },
        billingLocked: false, client: { id: CLIENT_ID, name: "Harbour Hotel Group", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
        services: ["traintrack"],
      });
      case "/api/billing/cancellation-status": return json(route, { accessEndsAt: null });
      case "/api/managed-by": return json(route, null);
      case "/api/form-options": return json(route, { options: {}, defaults: {}, disabled: {}, customised: {} });
      case "/api/train-track/records": return json(route, records);
      case "/api/sites": return json(route, []);
      case "/api/staff-roster": return json(route, []);
      case "/api/notifications": return json(route, { notifications: [], unreadCount: 0 });
    }
  }
  if (method === "POST" && url.pathname === "/api/analytics/events") return route.fulfill({ status: 204 });
  unexpectedRequests.push(`${method} ${url.pathname}`);
  return json(route, [], 200);
}

/** What the certificates tab shows: status card counts, the banner and the rows in order. */
async function certificateView(page) {
  return page.evaluate(() => {
    const count = label => {
      const card = [...document.querySelectorAll("button")].find(b => b.querySelector("span")?.textContent === label);
      return Number(card?.querySelector(".text-2xl")?.textContent);
    };
    const rows = [...document.querySelectorAll("tbody tr")].map(tr => {
      const cells = tr.querySelectorAll("td");
      return {
        name: cells[0]?.innerText.split("\n")[0].trim(),
        days: cells[6 - 1]?.innerText.split("\n")[1]?.trim() ?? null,
        status: cells[6]?.innerText.trim(),
        tint: tr.className.includes("bg-red-50") ? "red" : tr.className.includes("bg-amber-50") ? "amber" : "white",
      };
    });
    const banner = [...document.querySelectorAll("div")].find(d => d.textContent?.startsWith("Training certificates need attention"));
    return {
      expired: count("Expired"), expiringSoon: count("Expiring Soon"), valid: count("Valid"),
      banner: banner?.querySelector(".text-xs")?.textContent.trim() ?? null,
      rows,
    };
  });
}

const checks = [];
const pageErrors = [];
try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: chromiumPath() });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", routeApi);
  // Two minutes before midnight on Saturday 24 October 2026 (BST); the clocks
  // go back at 02:00 on the 25th.
  await page.clock.install({ time: new Date("2026-10-24T23:58:00+01:00") });
  await page.goto(`${baseUrl}/tests/training-midnight-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByText("Alex Today").waitFor({ timeout: 60_000 });

  assert.deepEqual(await certificateView(page), {
    expired: 0, expiringSoon: 1, valid: 3,
    banner: "1 certificate expires within the next 30 days.",
    rows: [
      { name: "Alex Today", days: "Today", status: "Expiring Soon", tint: "amber" },
      { name: "Blake Thirty", days: "31d", status: "Valid", tint: "white" },
      { name: "Drew Thirty", days: "32d", status: "Valid", tint: "white" },
      { name: "Casey Later", days: "220d", status: "Valid", tint: "white" },
    ],
  });
  checks.push("before midnight: due-today is Expiring Soon and labelled Today during BST");

  await page.clock.runFor("00:03:00");
  await page.waitForFunction(() => document.body.innerText.includes("1d ago"));
  assert.deepEqual(await certificateView(page), {
    expired: 1, expiringSoon: 1, valid: 2,
    banner: "1 certificate has expired. 1 certificate expires within the next 30 days.",
    rows: [
      { name: "Alex Today", days: "1d ago", status: "Expired", tint: "red" },
      { name: "Blake Thirty", days: "30d", status: "Expiring Soon", tint: "amber" },
      { name: "Drew Thirty", days: "31d", status: "Valid", tint: "white" },
      { name: "Casey Later", days: "219d", status: "Valid", tint: "white" },
    ],
  });
  checks.push("at local midnight the counts, banner, colours, order and day labels move on without a reload");

  // A laptop asleep over the next midnight: the clock jumps without the timer
  // firing, and the page stays on the old day until it is shown again.
  await page.clock.setSystemTime(new Date("2026-10-26T07:30:00Z"));
  await page.waitForTimeout(50);
  assert.equal((await certificateView(page)).expiringSoon, 1, "nothing changes while the tab is still hidden");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => document.body.innerText.includes("2d ago"));
  assert.deepEqual(await certificateView(page), {
    expired: 1, expiringSoon: 2, valid: 1,
    banner: "1 certificate has expired. 2 certificates expire within the next 30 days.",
    rows: [
      { name: "Alex Today", days: "2d ago", status: "Expired", tint: "red" },
      { name: "Blake Thirty", days: "29d", status: "Expiring Soon", tint: "amber" },
      { name: "Drew Thirty", days: "30d", status: "Expiring Soon", tint: "amber" },
      { name: "Casey Later", days: "218d", status: "Valid", tint: "white" },
    ],
  });
  checks.push("a tab that slept through midnight catches up when it is shown again");

  assert.deepEqual(pageErrors, []);
  console.log(`Training certificates across midnight checks passed (${checks.length}/${checks.length}):\n${checks.map(c => `  ✓ ${c}`).join("\n")}`);
  if (unexpectedRequests.length) console.log(`Other requests answered with []: ${[...new Set(unexpectedRequests)].join(", ")}`);
} catch (error) {
  console.error("TrainTrack page:", browser ? await browser.contexts()[0]?.pages()[0]?.locator("body").innerText().catch(() => "") : "");
  throw error;
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
