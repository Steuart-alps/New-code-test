import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for N/A on a track's Contractor checks box
// (src/components/track-contractor-checks.tsx), shown on FireTrack here:
//   - an Owner sees N/A on every line;
//   - N/A on a line with a compliance check marks that check not required
//     (PUT /compliance-items/:id/not-required); it is kept, not deleted;
//   - N/A on a line with no check yet marks it "No contractor needed"
//     (PUT /contractor-visits), as on the Contractors page;
//   - N/A lines fold into "marked N/A (not required here)", where Add back
//     undoes it;
//   - Staff see the lines but no N/A or Add back buttons.
// The API is mocked and stateful. Set SCREENSHOT_DIR to save screenshots.
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
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find(path => existsSync(path));

async function waitForVite() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SITE = { id: 1, name: "Harbour Hotel", clientId: 1 };
const TYPES = [
  { key: "fire:alarm_service", module: "fire", trackLabel: "FireTrack", title: "Fire Alarm Maintenance", label: "Fire alarm service (6-monthly)", description: "", dueFrom: "check" },
  { key: "fire:sprinkler_service", module: "fire", trackLabel: "FireTrack", title: "Sprinkler System Service", label: "Sprinkler system service", description: "", dueFrom: "check" },
  { key: "fire:aov_service", module: "fire", trackLabel: "FireTrack", title: "AOV Service", label: "Smoke vent (AOV) service", description: "", dueFrom: "check" },
];
const item = (id, title, fields) => ({
  id, title, status: "pending", priority: "high", siteId: 1, siteName: SITE.name, categoryId: null, categoryName: null, categoryColor: null,
  contractorId: null, contractorName: null, contractorEmail: null, assignedTo: null, assigneeUserId: null, dueDate: null,
  leadTimeDays: 14, frequencyMonths: 12, notificationSentAt: null, completedAt: null, completedInHouseBy: null, notes: null,
  notRequiredAt: null, needsAction: false, needsActionReason: null, openDefectCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...fields,
});

async function open(role) {
  // Fresh state each time: the alarm service and sprinkler checks exist; the
  // smoke vent line has no check yet.
  const items = [
    item(61, "Fire Alarm Maintenance", { frequencyMonths: 6, contractorId: 3, contractorName: "Alarm Co", dueDate: `${day(20)}T00:00:00.000Z` }),
    item(62, "Sprinkler System Service", { dueDate: `${day(-3)}T00:00:00.000Z` }),
  ];
  const visits = TYPES.map(type => ({ visitKey: type.key, siteId: SITE.id, contractorId: type.key === "fire:alarm_service" ? 3 : null, notNeeded: false }));
  const puts = [];
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    const json = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (method === "PUT") {
      puts.push({ path, body });
      const notRequired = path.match(/^\/api\/compliance-items\/(\d+)\/not-required$/);
      if (notRequired) {
        const target = items.find(i => i.id === Number(notRequired[1]));
        target.notRequiredAt = body.notRequired ? new Date().toISOString() : null;
        return json({ ok: true, notRequiredAt: target.notRequiredAt });
      }
      if (path === "/api/contractor-visits") {
        visits.find(v => v.visitKey === body.visitKey && v.siteId === body.siteId).notNeeded = body.notNeeded;
        return json({ ok: true });
      }
      return json({ error: "Not in the fixture" }, 404);
    }
    switch (path) {
      case "/api/auth/csrf-token": return json({ token: "csrf" });
      case "/api/auth/me": return json({
        user: { id: 7, email: "owner@example.test", name: "Olive Owner", role, clientId: 1, departmentId: null, active: true, totpEnabled: true },
        billingLocked: false, client: { id: 1, name: "Harbour Hotel Group", slug: "harbour", logoUrl: null, primaryColor: "#2F7C8C", active: true },
        services: ["firetrack"],
      });
      case "/api/sites": return json([SITE]);
      case "/api/contractor-visits": return json({ types: TYPES, visits, checks: [] });
      case "/api/compliance-items": return json(items);
      default: return json([]);
    }
  });
  await page.goto(`${baseUrl}/tests/track-contractor-na-harness.html`, { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("track-contractor-checks-fire");
  await card.getByTestId("contractor-check-row").first().waitFor({ timeout: 30000 });
  return { page, context, card, puts, items, pageErrors };
}

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });

  {
    const { page, context, card, puts, items, pageErrors } = await open("client_admin");
    const rows = card.getByTestId("contractor-check-row");
    assert.equal(await rows.count(), 3, "every FireTrack contractor line is listed");
    assert.equal(await card.getByTestId("contractor-check-na").count(), 3, "each line has N/A");
    await shot(page, "1-na-on-each-line");

    // A line with a check: the check is marked not required, not deleted.
    await card.getByRole("button", { name: "N/A, not required: Sprinkler system service" }).click();
    await card.getByTestId("contractor-checks-hidden").waitFor();
    assert.deepEqual(puts.at(-1), { path: "/api/compliance-items/62/not-required", body: { notRequired: true } });
    assert.ok(items.find(i => i.id === 62).notRequiredAt, "the check is kept, marked not required");
    await page.getByText("Sprinkler system service: marked N/A", { exact: true }).waitFor();
    assert.equal(await rows.count(), 2, "the line moves out of the list");
    console.log("ok - N/A on a line with a check marks the check not required");

    // A line with no check yet: "No contractor needed", as on the Contractors page.
    await card.getByRole("button", { name: "N/A, not required: Smoke vent (AOV) service" }).click();
    await card.getByText("2 marked N/A (not required here): show to add back").waitFor();
    assert.deepEqual(puts.at(-1), { path: "/api/contractor-visits", body: { visitKey: "fire:aov_service", siteId: 1, contractorId: null, notNeeded: true } });
    assert.equal(await rows.count(), 1);
    console.log("ok - N/A on a line with no check yet marks it no contractor needed");

    await card.getByText("show to add back").click();
    const naRows = card.getByTestId("contractor-check-na-row");
    assert.equal(await naRows.count(), 2);
    assert.match(await naRows.filter({ hasText: "Sprinkler system service" }).innerText(), /Not required: kept with its history, no reminders/);
    await card.scrollIntoViewIfNeeded();
    await shot(page, "2-na-list-with-add-back");

    await card.getByRole("button", { name: "Add back: Sprinkler system service" }).click();
    await card.getByText("1 marked N/A (not required here): show to add back").waitFor();
    assert.deepEqual(puts.at(-1), { path: "/api/compliance-items/62/not-required", body: { notRequired: false } });
    assert.equal(items.find(i => i.id === 62).notRequiredAt, null);
    assert.equal(await rows.count(), 2, "the line is back");
    assert.equal(await rows.filter({ hasText: "Sprinkler system service" }).getAttribute("data-rag"), "red", "with its overdue status");

    await card.getByRole("button", { name: "Add back: Smoke vent (AOV) service" }).click();
    await card.getByTestId("contractor-checks-hidden").waitFor({ state: "detached" });
    assert.deepEqual(puts.at(-1), { path: "/api/contractor-visits", body: { visitKey: "fire:aov_service", siteId: 1, contractorId: null, notNeeded: false } });
    assert.equal(await rows.count(), 3);
    assert.deepEqual(pageErrors, []);
    console.log("ok - Add back puts each line back");

    // Phone width.
    await page.setViewportSize({ width: 390, height: 844 });
    await card.getByRole("button", { name: "N/A, not required: Sprinkler system service" }).click();
    await card.getByTestId("contractor-checks-hidden").waitFor();
    await card.getByText("show to add back").click();
    await shot(page, "3-phone");
    await context.close();
  }

  {
    const { context, card, pageErrors } = await open("client_staff");
    assert.equal(await card.getByTestId("contractor-check-row").count(), 3);
    assert.equal(await card.getByTestId("contractor-check-na").count(), 0, "staff cannot mark lines N/A");
    assert.deepEqual(pageErrors, []);
    console.log("ok - staff see the lines without N/A");
    await context.close();
  }
} finally {
  await browser?.close();
  vite.kill();
}
