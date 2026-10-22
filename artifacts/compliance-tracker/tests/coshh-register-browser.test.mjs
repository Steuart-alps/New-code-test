import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the COSHH register's two homes
// (src/components/coshh-register-panel.tsx):
//   - without COSHHTrack, the free COSHH Register page and menu link, with the
//     register's own assessment date, review date and controls;
//   - with COSHHTrack, no separate menu link, /coshh opens COSHHTrack's
//     Substances tab, each substance shows its COSHHTrack assessments (or an
//     "Assess" button that starts one with the register's controls), and
//     editing a substance there leaves the register's hidden fields unchanged.
// The API is mocked; anything not listed returns an empty list.
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

const substance = (id, productName, extra = {}) => ({
  id, siteId: 1, productName, supplier: null, hazardPictograms: ["ghs05"], whereUsed: "Kitchen",
  sdsObjectPath: null, sdsFileName: null, assessmentDate: null, reviewDue: null, controls: null,
  status: "in_use", reviewOverdue: false, ...extra,
});
const substances = [
  substance(1, "Oven cleaner", { assessmentDate: "2025-09-01", reviewDue: "2026-09-01", controls: "Gloves and goggles", reviewOverdue: true }),
  substance(2, "Bleach"),
];
const assessments = [{
  id: 50, siteId: 1, substanceId: 2, task: "Cleaning toilets", whoAtRisk: null, exposureRoutes: [], howOften: null,
  hazardStatements: null, signalWord: null, healthEffects: null, exposureLimits: null, controls: null, ppe: [],
  ppeDetails: null, riskLevel: "medium", healthSurveillanceRequired: false, monitoringRequired: false, levRequired: false,
  storage: null, spillProcedure: null, firstAid: null, disposal: null, assessor: "Olive Owner",
  assessmentDate: "2026-10-01", reviewDue: "2027-10-01", status: "current", documentObjectPath: null,
  documentFileName: null, notes: null, draftSource: null, checkedByName: null, checkedAt: null, revision: 1,
  signOffDepartments: [], reviewOverdue: false,
}];

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
    if (path.endsWith("/api/sites")) return route.fulfill({ json: [{ id: 1, name: "Harbour Hotel", clientId: 1 }] });
    if (/\/api\/registers\/coshh\/\d+$/.test(path) && request.method() === "PUT") {
      saves.push(JSON.parse(request.postData() ?? "{}"));
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/api/registers/coshh")) return route.fulfill({ json: substances });
    if (path.endsWith("/api/coshh-track/assessments")) return route.fulfill({ json: assessments });
    if (path.endsWith("/api/coshh-track/status")) {
      return route.fulfill({ json: { overdue: 0, dueSoon: 0, missing: 0, dueSoonDays: 30, items: [] } });
    }
    if (path.endsWith("/api/coshh-track/sign-offs")) return route.fulfill({ json: { assessments: [] } });
    return route.fulfill({ json: [] });
  });
  const sidebar = page.locator("aside");

  // ─── Without COSHHTrack: the free register ────────────────────────────────
  await page.goto(`${baseUrl}/coshh`);
  await page.getByRole("heading", { name: "COSHH register" }).first().waitFor();
  await sidebar.locator('a[href="/coshh"]').waitFor(); // the free register is in the menu
  await page.getByText("Oven cleaner").first().waitFor();
  assert.ok(await page.getByText("Gloves and goggles").first().isVisible(), "The register shows its own controls");
  await page.getByRole("button", { name: "Edit Oven cleaner" }).click();
  assert.ok(await page.locator("#coshh-assessed").isVisible(), "The free register edits its own assessment date");
  assert.ok(await page.locator("#coshh-controls").isVisible());
  await page.keyboard.press("Escape");

  // ─── With COSHHTrack: one register, inside COSHHTrack ─────────────────────
  session.services = ["core", "coshhtrack"];
  await page.goto(`${baseUrl}/coshh`);
  await page.waitForURL(/\/coshh-track\?tab=substances$/);
  await page.getByRole("tab", { name: "Substances", selected: true }).waitFor();
  await sidebar.locator('a[href="/coshh-track"]').waitFor();
  assert.equal(await sidebar.locator('a[href="/coshh"]').count(), 0, "No separate register link with COSHHTrack");

  const panel = page.getByRole("tabpanel");
  await panel.getByText("Oven cleaner").first().waitFor();
  assert.ok(await panel.getByText("Cleaning toilets").first().isVisible(), "A substance lists its COSHHTrack assessment");
  assert.ok(await panel.getByText("No COSHH assessment").first().isVisible(), "An unassessed substance says so");
  assert.ok(await panel.getByText("Register says assessed").first().isVisible(), "An earlier register date is still shown");
  assert.equal(await panel.getByText("Gloves and goggles").count(), 0, "Register controls aren't shown beside COSHHTrack's");

  // Editing keeps the register's hidden assessment fields as they were.
  await panel.getByRole("button", { name: "Edit Oven cleaner" }).click();
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.locator("#coshh-assessed").count(), 0, "No second assessment date inside COSHHTrack");
  await dialog.locator("#coshh-supplier").fill("Acme");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].supplier, "Acme");
  assert.equal(saves[0].assessmentDate, "2025-09-01", "Hidden assessment date is kept");
  assert.equal(saves[0].reviewDue, "2026-09-01", "Hidden review date is kept");
  assert.equal(saves[0].controls, "Gloves and goggles", "Hidden controls are kept");

  // "Assess" starts a COSHHTrack assessment for that substance.
  await panel.getByRole("button", { name: "Assess", exact: true }).click();
  await page.getByRole("dialog").getByText("New COSHH assessment").waitFor();
  assert.equal(await page.getByRole("dialog").locator("#coshh-controls").inputValue(), "Gloves and goggles",
    "The register's controls start the assessment");

  assert.deepEqual(pageErrors, [], "No page errors");
  console.log("COSHH register browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
