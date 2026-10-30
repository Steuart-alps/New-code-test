import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the department dropdowns (components/
// department-name-select.tsx). DocTrack's upload and the Staff Roster's form
// list "All departments" / "No department", the departments set up for the
// chosen site (and ones for every site), then names already used on the
// roster or earlier documents, then "Other" to type a new one. The API is
// mocked.
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

const session = { services: ["core", "doctrack", "traintrack"] };
const authMe = () => ({
  user: {
    id: 7, email: "owner@example.test", name: "Olive Owner", role: "client_admin",
    clientId: 1, departmentId: null, active: true, totpEnabled: true,
  },
  client: { id: 1, name: "Business 1", primaryColor: "#7FA8C9", logoUrl: null },
  services: session.services,
  billingLocked: false,
  twoFactorRequired: false,
});

const sites = [{ id: 1, name: "Golf Club", clientId: 1 }, { id: 2, name: "Hotel", clientId: 1 }];
// Set up in Settings: two at the golf club, one at the hotel, one for every site.
const departments = [
  { id: 1, name: "Kitchen", siteId: 1, siteName: "Golf Club" },
  { id: 2, name: "Greenkeeping", siteId: 1, siteName: "Golf Club" },
  { id: 3, name: "Housekeeping", siteId: 2, siteName: "Hotel" },
  { id: 4, name: "Office", siteId: null, siteName: null },
];
// "Bar" is only on the roster (typed before departments were set up).
const roster = [
  { id: 1, client_id: 1, site_id: 1, name: "Ann Chef", department: "Kitchen", active: true, site_name: "Golf Club" },
  { id: 2, client_id: 1, site_id: 1, name: "Ben Bar", department: "Bar", active: true, site_name: "Golf Club" },
  { id: 3, client_id: 1, site_id: 2, name: "Cara Clean", department: "Housekeeping", active: true, site_name: "Hotel" },
];
const screenshotDir = process.env.SCREENSHOT_DIR;

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const savedDocs = [];
  const savedStaff = [];
  await page.route("**/upload-put", route => route.fulfill({ status: 200, body: "" }));
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/api/auth/me")) return route.fulfill({ json: authMe() });
    if (path.endsWith("/api/auth/csrf")) return route.fulfill({ json: { csrfToken: "test" } });
    if (path.endsWith("/api/notifications")) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path.endsWith("/api/managed-by")) return route.fulfill({ json: null });
    if (path.endsWith("/api/setup/state")) return route.fulfill({ json: { teamConfirmed: true, complete: true } });
    if (path.endsWith("/api/storage/status")) {
      return route.fulfill({ json: { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null } });
    }
    if (path.endsWith("/api/sites")) return route.fulfill({ json: sites });
    if (path.endsWith("/api/departments")) return route.fulfill({ json: departments });
    if (path.endsWith("/api/staff-roster") && request.method() === "POST") {
      savedStaff.push(JSON.parse(request.postData() ?? "{}"));
      return route.fulfill({ json: { id: 9 } });
    }
    if (path.endsWith("/api/staff-roster")) return route.fulfill({ json: roster });
    if (path.endsWith("/api/doc-track/documents/request-upload")) {
      return route.fulfill({ json: { uploadUrl: `${baseUrl}/upload-put`, objectPath: "/objects/uploads/test" } });
    }
    if (path.endsWith("/api/doc-track/documents") && request.method() === "POST") {
      savedDocs.push(JSON.parse(request.postData() ?? "{}"));
      return route.fulfill({ json: { id: savedDocs.length } });
    }
    if (path.endsWith("/api/doc-track/documents")) {
      return route.fulfill({ json: [{ id: 50, title: "Old SOP", category: "sop", department: "Front of House", site_id: null, file_name: "sop.pdf", file_size: 10, mime_type: "application/pdf", uploaded_by: "Olive", created_at: "2026-10-01T10:00:00Z", requires_acknowledgement: false }] });
    }
    if (path.endsWith("/api/doc-track/sign-off-info")) return route.fulfill({ json: null });
    return route.fulfill({ json: [] });
  });

  const dropdown = label => page.getByRole("combobox", { name: label, exact: true });
  const options = async label => {
    await dropdown(label).click();
    const texts = await page.getByRole("option").allInnerTexts();
    return texts;
  };
  const pick = async option => page.getByRole("option", { name: option, exact: true }).click();

  // ─── DocTrack upload ───
  await page.goto(`${baseUrl}/doc-track`);
  await page.getByRole("button", { name: "Upload Document" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "kitchen-sop.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  assert.match(await dropdown("Department").innerText(), /All departments/, "Starts on All departments");

  // Not site-specific: every department set up, then names used before, then Other.
  // (The Site box is the second dropdown; it may start on the working site.)
  const siteBox = () => dialog.getByRole("combobox").nth(1);
  await siteBox().click();
  await pick("Not site-specific");
  let listed = await options("Department");
  assert.deepEqual(listed, [
    "All departments", "Greenkeeping", "Housekeeping", "Kitchen", "Office",
    "Bar", "Front of House", "Other (type a new department)",
  ]);
  await page.keyboard.press("Escape");

  // A site narrows the list to its own departments (and ones for every site).
  await siteBox().click();
  await pick("Golf Club");
  listed = await options("Department");
  assert.deepEqual(listed, [
    "All departments", "Greenkeeping", "Kitchen", "Office",
    "Bar", "Front of House", "Other (type a new department)",
  ]);
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/1-doctrack-department-list.png` });
  }
  await pick("Kitchen");
  await dialog.getByTestId("upload-signers").filter({ hasText: "1 member of staff will be asked to sign." }).waitFor();
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/2-doctrack-kitchen-chosen.png` });
  await dialog.getByRole("button", { name: /^Upload/ }).last().click();
  for (let attempt = 0; savedDocs.length < 1 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(savedDocs[0].department, "Kitchen");
  assert.equal(savedDocs[0].siteId, 1);

  // "All departments" saves no department: everyone at the site signs.
  await page.getByRole("button", { name: "Upload Document" }).first().click();
  await dialog.locator('input[type="file"]').setInputFiles({ name: "fire-policy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
  await siteBox().click();
  await pick("Not site-specific");
  await dropdown("Department").click();
  await pick("Kitchen");
  await dropdown("Department").click();
  await pick("All departments");
  await dialog.getByTestId("upload-signers").filter({ hasText: "3 members of staff will be asked to sign." }).waitFor();
  // A new department can still be typed.
  await dropdown("Department").click();
  await pick("Other (type a new department)");
  await page.keyboard.type("Spa");
  await dialog.getByTestId("upload-signers").filter({ hasText: "No active staff" }).waitFor();
  await dropdown("Department").click();
  await pick("All departments");
  await dialog.getByRole("button", { name: /^Upload/ }).last().click();
  for (let attempt = 0; savedDocs.length < 2 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(savedDocs[1].department, null, "All departments saves no department");

  // ─── Staff Roster ───
  await page.goto(`${baseUrl}/staff-roster`);
  await page.getByRole("button", { name: "Add Staff" }).first().click();
  const staffDialog = page.getByRole("dialog");
  await staffDialog.getByPlaceholder("Full name").fill("Dan Green");
  assert.match(await dropdown("Department").innerText(), /No department/);
  await staffDialog.getByRole("combobox").first().click();
  await pick("Hotel");
  listed = await options("Department");
  assert.deepEqual(listed, ["No department", "Housekeeping", "Office", "Bar", "Other (type a new department)"]);
  await pick("Housekeeping");
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/3-staff-roster-department.png` });
  await staffDialog.getByRole("button", { name: "Add Staff Member" }).click();
  for (let attempt = 0; savedStaff.length < 1 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(savedStaff[0].department, "Housekeeping");
  assert.equal(savedStaff[0].siteId, 2);

  assert.deepEqual(pageErrors, [], "No page errors");
  console.log("Department dropdown browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
