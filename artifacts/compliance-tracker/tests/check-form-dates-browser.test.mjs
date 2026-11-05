import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the add/edit compliance check form
// (src/components/item-form-dialog.tsx):
//   - a check with a contractor has no "Assigned to" box (the contractor does
//     it); with no contractor the box comes back for an in-house person;
//   - a repeating check has no "Due date" box: it asks when it was last done
//     and shows the next due date worked out from Repeat; saving sends
//     lastDone (the server works out the due date) or, with no date done and
//     a new interval, a due date counted from today;
//   - an unchanged check keeps its due date and the person already assigned;
//   - a one-off check (Repeat blank) still has its "Due date" box;
//   - on a phone the form fits without sideways scrolling.
// The API is mocked; anything not listed returns an empty list. Set
// SCREENSHOT_DIR to save screenshots.
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const screenshots = process.env.SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true });
const shot = async (page, name) => {
  if (!screenshots) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${screenshots}/${name}.png` });
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

async function waitForVite() {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`Vite exited: ${viteError}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start: ${viteError}`);
}
const chromiumPath = () => process.env.CHROMIUM_PATH
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find(path => existsSync(path));

const authMe = (role) => ({
  user: { id: 7, email: "person@example.test", name: "Olive Owner", role, clientId: 1, departmentId: null, active: true, totpEnabled: true },
  client: { id: 1, name: "Business 1", primaryColor: "#7FA8C9", logoUrl: null },
  services: ["core"],
  billingLocked: false,
  twoFactorRequired: false,
});
const item = {
  id: 5, clientId: 1, title: "Gas safety inspection", description: "Annual gas safety check of the kitchen appliances.",
  status: "pending", priority: "high", categoryId: null, siteId: 1, contractorId: 3,
  dueDate: "2026-12-14T09:00:00.000Z", leadTimeDays: 30, frequencyMonths: 12,
  assignedTo: "Mark Maintenance", assigneeUserId: null, notes: "Engineer needs access to the cellar.",
  needsAction: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const contractors = [{ id: 3, name: "Gary Gas", company: "Safe Gas Ltd", email: "gary@safegas.example", trades: ["gas"] }];

async function open(role, viewport = { width: 1280, height: 1000 }) {
  const context = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const requests = [];
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    if (request.method() !== "GET") requests.push({ method: request.method(), path, body });
    if (path.endsWith("/api/auth/me")) return route.fulfill({ json: authMe(role) });
    if (path.endsWith("/api/auth/csrf")) return route.fulfill({ json: { csrfToken: "test" } });
    if (path.endsWith("/api/notifications")) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path.endsWith("/api/managed-by")) return route.fulfill({ json: null });
    if (path.endsWith("/api/storage/status")) return route.fulfill({ json: { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null } });
    if (path.endsWith("/api/sites")) return route.fulfill({ json: [{ id: 1, name: "Harbour Hotel", clientId: 1 }] });
    if (path.endsWith("/api/contractors")) return route.fulfill({ json: contractors });
    if (path.endsWith("/api/compliance-items/5") && request.method() === "PUT") return route.fulfill({ json: { ...item, ...body } });
    if (path.endsWith("/api/compliance-items/5")) return route.fulfill({ json: item });
    return route.fulfill({ json: [] });
  });
  await page.goto(`${baseUrl}/items/5`);
  await page.getByRole("heading", { name: "Gas safety inspection" }).first().waitFor();
  await page.getByTitle("Edit", { exact: true }).click();
  await page.getByRole("dialog").getByText("Edit Compliance Check").waitFor();
  return { page, context, requests, pageErrors };
}

const today = new Date();
const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
function addMonthsToDay(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
const save = async (page) => {
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
};

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });

  // ── A repeating contractor check: no Assigned to, no Due date ──
  {
    const { page, context, requests, pageErrors } = await open("client_admin");
    const dialog = page.getByRole("dialog");
    assert.equal(await dialog.getByLabel("Assigned to").count(), 0, "no Assigned to with a contractor");
    assert.equal(await dialog.locator("#dueDate").count(), 0, "no Due date box on a repeating check");
    await dialog.getByLabel("Last done").waitFor();
    await dialog.getByText("Next due 14 Dec 2026, worked out from Repeat.").waitFor();
    await shot(page, "1-contractor-check-form");

    // Unchanged: keeps its due date and the person already assigned.
    await save(page);
    let put = requests.findLast(r => r.method === "PUT");
    assert.ok(put, "saved");
    assert.equal("dueDate" in put.body, false, "an unchanged check keeps its due date");
    assert.equal("lastDone" in put.body, false);
    assert.equal("assignedTo" in put.body || "assigneeUserId" in put.body, false, "the person already assigned is left alone");

    // Last done given: the server works the due date out from it.
    await page.getByTitle("Edit", { exact: true }).click();
    await dialog.getByText("Edit Compliance Check").waitFor();
    await dialog.getByLabel("Last done").fill("2026-09-30");
    await dialog.getByText("Next due 30 Sept 2027, worked out from Repeat.").or(dialog.getByText("Next due 30 Sep 2027, worked out from Repeat.")).waitFor();
    await shot(page, "2-last-done");
    await save(page);
    put = requests.findLast(r => r.method === "PUT");
    assert.equal(put.body.lastDone, "2026-09-30");
    assert.equal("dueDate" in put.body, false);

    // A future date is refused on the form.
    await page.getByTitle("Edit", { exact: true }).click();
    await dialog.getByText("Edit Compliance Check").waitFor();
    await dialog.getByLabel("Last done").fill(addMonthsToDay(localToday, 1));
    await dialog.getByText("The date last done cannot be in the future").waitFor();
    // New interval and no date done: counted from today.
    await dialog.getByLabel("Last done").fill("");
    await dialog.getByLabel("Repeat every (months)").fill("6");
    await save(page);
    put = requests.findLast(r => r.method === "PUT");
    assert.equal(put.body.frequencyMonths, 6);
    assert.equal(put.body.dueDate, `${addMonthsToDay(localToday, 6)}T00:00:00.000Z`);

    // No contractor: Assigned to comes back. One-off: Due date comes back.
    await page.getByTitle("Edit", { exact: true }).click();
    await dialog.getByText("Edit Compliance Check").waitFor();
    await dialog.locator("#item-contractor, button[role=combobox]").filter({ hasText: "Gary Gas" }).first().click();
    await page.getByRole("option", { name: "Unassigned" }).click();
    await dialog.getByLabel("Assigned to").waitFor();
    await dialog.getByLabel("Repeat every (months)").fill("");
    await dialog.locator("#dueDate").waitFor();
    assert.equal(await dialog.getByLabel("Last done").count(), 0, "a one-off check has no Last done");
    await shot(page, "3-in-house-one-off");
    await page.keyboard.press("Escape");
    assert.deepEqual(pageErrors, []);
    await context.close();
  }

  // ── Phone: the form fits ──
  {
    const { page, context, pageErrors } = await open("client_admin", { width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no sideways scroll on a phone (overflow ${overflow}px)`);
    await shot(page, "4-phone-form");
    assert.deepEqual(pageErrors, []);
    await context.close();
  }
  console.log("contractor check form browser test passed");
} finally {
  await browser?.close();
  vite.kill();
}
