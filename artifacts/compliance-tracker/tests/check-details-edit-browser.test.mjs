import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for changing a compliance check from its own page
// (src/pages/item-detail.tsx, src/components/item-form-dialog.tsx):
//   - Owners see a labelled "Make changes" button, and every detail box
//     (Due date, Repeats, Contractor...) says "Change" and opens the form with
//     that box ready to type in; saving sends the new due date;
//   - the contractor's name still opens the contractor, not the form;
//   - Managers (and Maintenance managers) can change a check too, but not
//     delete it or copy it to every site;
//   - Staff, who can't change a check, see neither the button nor "Change";
//   - on a phone the button and boxes fit without sideways scrolling.
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
  ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find(path => existsSync(path));

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
  await page.getByTestId("page-scroll").getByRole("heading", { name: "Gas safety inspection" }).waitFor();
  return { page, context, requests, pageErrors };
}

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });

  // ── Owner: a labelled button, and each box opens the form on that box ──
  {
    const { page, context, requests, pageErrors } = await open("client_admin");
    await page.getByRole("button", { name: "Make changes" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit", exact: true }).count(), 0, "the unlabelled pencil has gone");
    await page.getByText("Tap any box below to change it.").waitFor();
    assert.equal(await page.getByText("Change", { exact: true }).count(), 7, "every detail box (and Notes) says Change");
    await shot(page, "1-desktop-check-page");

    await page.getByRole("button", { name: "Make changes" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByText("Edit Compliance Check").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Change due date" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByText("Edit Compliance Check").waitFor();
    // A repeating check asks when it was last done; the due date follows from Repeat.
    await page.waitForFunction(() => document.activeElement?.id === "lastDone");
    await shot(page, "2-due-date-ready-to-change");
    await dialog.locator("#lastDone").fill("2026-10-20");
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "hidden" });
    const put = requests.find(r => r.method === "PUT" && r.path === "/api/compliance-items/5");
    assert.ok(put, "saving sends the change");
    assert.equal(put.body.lastDone, "2026-10-20");

    for (const [box, id] of [["Change repeats", "frequencyMonths"], ["Change reminder lead time", "leadTimeDays"], ["Change contractor", "item-contractor"], ["Change site", "item-site"], ["Change assigned to", "item-contractor"], ["Change notes", "notes"]]) {
      await page.getByRole("button", { name: box }).click();
      await page.waitForFunction((want) => document.activeElement?.id === want, id);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }

    // The contractor's name is still a link to the contractor.
    await page.getByRole("link", { name: "Gary Gas — Safe Gas Ltd" }).click();
    await page.waitForURL(/\/contractors\/3$/);
    assert.equal(await page.getByRole("dialog").count(), 0, "the link does not open the form");
    assert.deepEqual(pageErrors, []);
    await context.close();
  }

  // ── Managers change a check too, but don't delete it or copy it to every site ──
  {
    const { page, context, pageErrors } = await open("client_manager");
    await page.getByRole("button", { name: "Make changes" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Delete check" }).count(), 0, "Managers can't delete a check");
    await page.getByRole("button", { name: "Change site" }).click();
    await page.waitForFunction(() => document.activeElement?.id === "item-site");
    await page.locator("#item-site").click();
    await page.getByRole("option", { name: "Harbour Hotel" }).waitFor();
    assert.equal(await page.getByRole("option", { name: /All Sites/ }).count(), 0, "no copying to every site");
    assert.deepEqual(pageErrors, []);
    await context.close();
  }

  // ── Staff can't change a check, so nothing offers to ──
  {
    const { page, context, pageErrors } = await open("client_staff");
    await page.getByRole("button", { name: "Mark done" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Make changes" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Change due date" }).count(), 0);
    assert.equal(await page.getByText("Change", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Tap any box below to change it.").count(), 0);
    assert.deepEqual(pageErrors, []);
    await context.close();
  }

  // ── Phone: everything fits, and a tap on a box opens the form ──
  {
    const { page, context, pageErrors } = await open("client_admin", { width: 390, height: 844 });
    await page.getByRole("button", { name: "Make changes" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no sideways scroll on a phone (overflow ${overflow}px)`);
    await shot(page, "3-phone-check-page");
    await page.getByRole("button", { name: "Change due date" }).tap();
    await page.getByRole("dialog").getByText("Edit Compliance Check").waitFor();
    // A repeating check asks when it was last done; the due date follows from Repeat.
    await page.waitForFunction(() => document.activeElement?.id === "lastDone");
    await shot(page, "4-phone-due-date");
    assert.deepEqual(pageErrors, []);
    await context.close();
  }
  console.log("check details edit browser test passed");
} finally {
  await browser?.close();
  vite.kill();
}
