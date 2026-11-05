import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the Contractors page opened from a track's
// Contractor checks box (src/components/track-contractor-checks.tsx links to
// /contractors?track=<module>[&visit=<key>]; pages/contractors.tsx):
//   - only that track's inspection lines are listed (no other tracks, no
//     compliance check register);
//   - only contractors with one of the track's trades, or already chosen for
//     one of its lines, are listed;
//   - "Show all contractors" brings everything back;
//   - a bare /contractors shows everything;
//   - "+ Add a new contractor" in a line's contractor list adds one there,
//     with the line's trades ticked, and chooses them for that line.
// The API is mocked; anything not listed returns an empty list. Set
// SCREENSHOT_DIR to save screenshots.
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const screenshots = process.env.SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true });
const shot = async (page, name) => {
  if (!screenshots) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
};
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
const chromiumPath = () => process.env.CHROMIUM_PATH
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(path => existsSync(path));

async function waitForVite() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}

const authMe = {
  user: { id: 7, email: "owner@example.test", name: "Olive Owner", role: "client_admin", clientId: 1, departmentId: null, active: true, totpEnabled: true },
  client: { id: 1, name: "Business 1", primaryColor: "#7FA8C9", logoUrl: null },
  services: ["core", "greentrack", "firetrack"],
  billingLocked: false,
  twoFactorRequired: false,
};
const contractor = (id, name, trades) => ({
  id, clientId: 1, name, company: null, email: `${name.split(" ")[0].toLowerCase()}@example.test`, phone: null,
  trades, publicLiabilityExpiry: "2030-01-01", dbsExpiryDate: "2030-01-01",
});
const contractors = [
  contractor(1, "Mower Mechanics", ["grounds_machinery"]),
  contractor(2, "Lift Inspectors Ltd", ["loler_puwer_inspection"]),
  contractor(3, "Blaze Fire Alarms", ["fire_alarm"]),
  contractor(4, "Handy Harry", []),
  contractor(5, "Sparks Electrical", ["electrical"]),
];
const types = [
  { key: "green:service", module: "green", trackLabel: "GreenTrack", title: "GreenTrack Machine Servicing", label: "Machine servicing", description: "", dueFrom: "track", trades: ["grounds_machinery", "equipment"] },
  { key: "green:puwer", module: "green", trackLabel: "GreenTrack", title: "GreenTrack PUWER Inspection", label: "PUWER inspection", description: "", dueFrom: "track", trades: ["loler_puwer_inspection"] },
  { key: "fire:alarm_service", module: "fire", trackLabel: "FireTrack", title: "Fire Alarm Service", label: "Fire alarm service", description: "", dueFrom: "check", trades: ["fire_alarm"] },
];
const visit = (visitKey, contractorId = null) => ({
  visitKey, siteId: 1, siteName: "Golf Club", trackDueDate: null, checkId: null, dueDate: null, status: null,
  contractorId, contractorName: contractors.find(c => c.id === contractorId)?.name ?? null, reminderSentAt: null,
});
const visitData = {
  types,
  // Handy Harry (no trades ticked) already does the PUWER inspection.
  visits: [visit("green:service"), visit("green:puwer", 4), visit("fire:alarm_service", 3)],
  checks: [{ checkId: 9, title: "Gas Safety Certificate", siteId: 1, siteName: "Golf Club", dueDate: null, status: "pending", contractorId: null, contractorName: null, reminderSentAt: null, notNeeded: false }],
};

async function open(path) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(() => {
    for (let id = 0; id < 20; id++) localStorage.setItem(`complytrack:quickTutorialSeen:${id}`, "true");
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const requests = [];
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    if (request.method() !== "GET") requests.push({ method: request.method(), path, body });
    if (path.endsWith("/api/contractors") && request.method() === "POST") {
      return route.fulfill({ status: 201, json: { ...contractor(6, body.name, body.trades), email: body.email } });
    }
    if (path.endsWith("/api/contractor-visits") && request.method() === "PUT") return route.fulfill({ json: { ok: true } });
    if (path.endsWith("/api/form-options")) {
      return route.fulfill({ json: { options: { fixtrack_trades: ["electrical", "equipment", "fire_alarm", "grounds_machinery", "loler_puwer_inspection"] } } });
    }
    if (path.endsWith("/api/auth/me")) return route.fulfill({ json: authMe });
    if (path.endsWith("/api/auth/csrf")) return route.fulfill({ json: { csrfToken: "test" } });
    if (path.endsWith("/api/notifications")) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path.endsWith("/api/managed-by")) return route.fulfill({ json: null });
    if (path.endsWith("/api/storage/status")) return route.fulfill({ json: { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null } });
    if (path.endsWith("/api/setup/state")) return route.fulfill({ json: { needsSetup: false, canManage: true, team: { recorders: 2, aloneAt: null, ready: true } } });
    if (path.endsWith("/api/sites")) return route.fulfill({ json: [{ id: 1, name: "Golf Club", clientId: 1 }] });
    if (path.endsWith("/api/contractors")) return route.fulfill({ json: contractors });
    if (path.endsWith("/api/contractor-visits")) return route.fulfill({ json: visitData });
    if (path.endsWith("/api/certificates-outstanding")) return route.fulfill({ json: { certificates: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto(`${baseUrl}${path}`);
  try {
    await page.getByRole("heading", { name: "Contractor inspections and visits" }).waitFor({ timeout: 20000 });
  } catch (error) {
    if (screenshots) await page.screenshot({ path: `${screenshots}/failed-open.png` });
    console.error(pageErrors, await page.locator("body").innerText());
    throw error;
  }
  return { page, context, pageErrors, requests };
}

const listed = async (page) => (await page.locator("a[href^='/contractors/'] h3").allInnerTexts()).sort();
const sections = async (page) => page.locator("section[aria-label]").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")));

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });

  {
    const { page, context, pageErrors } = await open("/contractors?track=green&visit=green%3Aservice&site=1");
    await page.getByTestId("contractors-track-filter").getByText("Showing GreenTrack only").waitFor();
    await page.locator("h3", { hasText: "Mower Mechanics" }).waitFor();
    assert.deepEqual(await sections(page), ["GreenTrack"], "only the GreenTrack lines are listed");
    assert.deepEqual(await listed(page), ["Handy Harry", "Lift Inspectors Ltd", "Mower Mechanics"],
      "GreenTrack trades plus the contractor already chosen for a GreenTrack line");
    await shot(page, "1-greentrack-only");
    console.log("ok - from GreenTrack, only GreenTrack lines and contractors are shown");

    await page.getByRole("button", { name: "Show all contractors" }).click();
    await page.locator("h3", { hasText: "Blaze Fire Alarms" }).waitFor();
    assert.equal(await page.getByTestId("contractors-track-filter").count(), 0);
    assert.deepEqual(await sections(page), ["GreenTrack", "FireTrack", "Compliance checks"]);
    assert.equal((await listed(page)).length, contractors.length);
    await shot(page, "2-show-all");
    console.log("ok - Show all contractors brings every track and contractor back");
    assert.deepEqual(pageErrors, []);
    await context.close();
  }

  {
    // An older link with only ?visit= still finds its track.
    const { page, context } = await open("/contractors?visit=fire%3Aalarm_service");
    await page.getByText("Showing FireTrack only").waitFor();
    assert.deepEqual(await sections(page), ["FireTrack"]);
    assert.deepEqual(await listed(page), ["Blaze Fire Alarms"]);
    console.log("ok - a ?visit= link filters to that line's track");
    await context.close();
  }

  {
    const { page, context, requests, pageErrors } = await open("/contractors?track=green");
    await page.getByRole("combobox", { name: "Contractor: Machine servicing" }).click();
    await page.getByRole("option", { name: "+ Add a new contractor" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Add Contractor").waitFor();
    for (const trade of ["Grounds Machinery / Greenkeeping Equipment", "Equipment"]) {
      const button = dialog.getByRole("button", { name: trade, exact: true });
      if (await button.count()) assert.equal(await button.getAttribute("aria-pressed"), "true", `${trade} ticked`);
    }
    await dialog.getByLabel("Contact Name *").fill("Greens Kit Servicing");
    await dialog.getByLabel("Email *").fill("kit@example.test");
    await shot(page, "3-add-from-line");
    await page.locator("button[type=submit][form=contractor-form]").click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const created = requests.find(r => r.method === "POST" && r.path.endsWith("/api/contractors"));
    assert.ok(created, "contractor created");
    assert.deepEqual([...created.body.trades].sort(), ["equipment", "grounds_machinery"], "the line's trades are ticked");
    const chosen = requests.find(r => r.method === "PUT" && r.path.endsWith("/api/contractor-visits"));
    assert.deepEqual(chosen?.body, { visitKey: "green:service", siteId: 1, contractorId: 6, notNeeded: false },
      "the new contractor is chosen for the line");
    assert.deepEqual(pageErrors, []);
    console.log("ok - + Add a new contractor on a line adds them and chooses them there");
    await context.close();
  }

  {
    const { page, context } = await open("/contractors");
    await page.locator("h3", { hasText: "Blaze Fire Alarms" }).waitFor();
    assert.equal(await page.getByTestId("contractors-track-filter").count(), 0);
    assert.equal((await listed(page)).length, contractors.length);
    console.log("ok - the Contractors page on its own lists everything");
    await context.close();
  }

  console.log("Contractors track filter browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
