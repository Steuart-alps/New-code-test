import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the Compliance Hub accountability profile
// (src/pages/compliance-hub.tsx): the stand-in text Business setup stores
// ("Not yet described", "Business owner or manager") shows as an empty box
// with a grey hint, so people type straight in; boxes holding a real
// default (the responsible person's name, the review cadence) select their
// text on entry, so typing replaces it. A stand-in left empty is sent back
// unchanged, so saving still works. The API is mocked.
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

const session = { services: ["core"] };
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

const storedProfile = {
  nation: "scotland", operationType: "Not yet described", responsiblePersonName: "Olive Owner",
  responsiblePersonRole: "Business owner or manager", responsiblePersonEmail: null, competentAppointments: [],
  reviewCadence: "Annual and after significant change", nextReviewDate: "2027-10-27", haccpSystemReviewed: false,
  waterWrittenSchemeReference: null,
};
const screenshotDir = process.env.SCREENSHOT_DIR;

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const saves = [];
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/api/auth/me")) return route.fulfill({ json: authMe() });
    if (path.endsWith("/api/auth/csrf")) return route.fulfill({ json: { csrfToken: "test" } });
    if (path.endsWith("/api/notifications")) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path.endsWith("/api/managed-by")) return route.fulfill({ json: null });
    if (path.endsWith("/api/storage/status")) {
      return route.fulfill({ json: { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null } });
    }
    if (path.endsWith("/api/compliance-hub/profile") && request.method() === "PUT") {
      const body = JSON.parse(request.postData() ?? "{}");
      saves.push(body);
      return route.fulfill({ json: body });
    }
    if (path.endsWith("/api/compliance-hub/profile")) return route.fulfill({ json: storedProfile });
    if (path.endsWith("/api/compliance-hub/guidance")) {
      return route.fulfill({ json: { guidance: [], disclaimer: "", reviewedAt: "2026-10-01", gaps: [] } });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto(`${baseUrl}/compliance-hub`);
  const box = label => page.locator("div.space-y-2").filter({ has: page.locator("label", { hasText: new RegExp(`^${label}$`) }) }).locator("input");
  const operation = box("Premises / operation type");
  const name = box("Responsible person");
  const role = box("Responsible person's role");
  const cadence = box("Review cadence");
  await name.and(page.locator('[value="Olive Owner"]')).waitFor();

  // Setup's stand-in text shows as a grey hint, not as text to delete.
  assert.equal(await operation.inputValue(), "", "Operation type stand-in is not in the box");
  assert.equal(await role.inputValue(), "", "Role stand-in is not in the box");
  assert.match(await role.getAttribute("placeholder"), /Business owner/, "Role box shows a hint instead");
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.locator("main").screenshot({ path: `${screenshotDir}/1-profile-boxes.png` });
  }

  // Clicking into a box with a real default selects it, so typing replaces it.
  await name.click();
  await page.keyboard.type("Sam Smith");
  assert.equal(await name.inputValue(), "Sam Smith", "Typing replaces the pre-filled name");
  await cadence.click();
  if (screenshotDir) await page.locator("main").screenshot({ path: `${screenshotDir}/2-click-selects-default.png` });
  await page.keyboard.type("Every six months");
  assert.equal(await cadence.inputValue(), "Every six months", "Typing replaces the pre-filled review cadence");
  // A second click places the cursor, for correcting the text instead.
  await cadence.click();
  await page.keyboard.type("!");
  assert.match(await cadence.inputValue(), /!/, "A second click edits rather than replaces");
  assert.notEqual(await cadence.inputValue(), "!", "A second click keeps the text");
  await cadence.fill("Every six months");

  // Typed text is saved; a stand-in left empty goes back as it was.
  await operation.click();
  await page.keyboard.type("Golf club with bar and kitchen");
  await page.getByRole("button", { name: "Save accountability profile" }).click();
  await page.getByText("Accountability profile saved").first().waitFor();
  assert.equal(saves[0].operationType, "Golf club with bar and kitchen");
  assert.equal(saves[0].responsiblePersonName, "Sam Smith");
  assert.equal(saves[0].responsiblePersonRole, "Business owner or manager", "Empty role sends the stand-in back");
  assert.equal(saves[0].reviewCadence, "Every six months");
  assert.equal(await role.inputValue(), "", "Role box is still empty after saving");
  assert.equal(await operation.inputValue(), "Golf club with bar and kitchen");

  // A role typed in is saved as typed.
  await role.click();
  await page.keyboard.type("Club manager");
  await page.getByRole("button", { name: "Save accountability profile" }).click();
  for (let attempt = 0; saves.length < 2 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(saves.at(-1).responsiblePersonRole, "Club manager");

  assert.deepEqual(pageErrors, [], "No page errors");
  console.log("Compliance Hub profile browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
