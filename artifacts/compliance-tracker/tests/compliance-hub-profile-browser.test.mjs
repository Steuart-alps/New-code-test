import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for the Compliance Hub accountability profile
// (src/pages/compliance-hub.tsx). Its answers are dropdowns: operation type,
// responsible person (people with a login; picking one fills their email),
// role, review cadence and competent-person appointments (area, and person
// or contractor), each with "Other" to type an answer. The stand-in text
// Business setup stores ("Not yet described", "Business owner or manager")
// shows as an unanswered dropdown and is sent back if left so; a value not in
// a list shows in the typing box. The HACCP review (now KitchenTrack) and
// water written scheme (now LegionellaTrack) are no longer shown but are
// saved back unchanged. Corrective actions are no longer logged here; open
// ones logged here before (other than IncidentTrack's, shown on the incident)
// stay under "Earlier actions" until closed. The API is mocked.
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
  reviewCadence: "Annual and after significant change", nextReviewDate: "2027-10-27", haccpSystemReviewed: true,
  waterWrittenSchemeReference: "Water scheme rev 3",
};
const people = [{ id: 7, name: "Olive Owner", role: "client_admin" }, { id: 8, name: "Sam Smith", role: "client_manager" }];
const users = [
  { id: 7, name: "Olive Owner", email: "owner@example.test", role: "client_admin", active: true },
  { id: 8, name: "Sam Smith", email: "sam@example.test", role: "client_manager", active: true },
];
const contractors = [{ id: 3, name: "Wendy Water", company: "AquaCare Ltd" }];
const action = (id, sourceTrack, title) => ({
  id, sourceTrack, sourceRecordId: null, title, severity: "high", status: "open", ownerName: "Sam Smith",
  dueDate: null, interimControl: null, correctiveAction: "Fix it", evidenceReference: null, verificationNotes: null, fixTrackIssueId: null,
});
const hubActions = [action(1, "FireTrack", "Fire door wedged open"), action(2, "IncidentTrack", "Slip in kitchen")];
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
    if (path.endsWith("/api/compliance-hub/actions")) return route.fulfill({ json: hubActions });
    if (path.endsWith("/api/assignees")) return route.fulfill({ json: people });
    if (path.endsWith("/api/users")) return route.fulfill({ json: users });
    if (path.endsWith("/api/contractors")) return route.fulfill({ json: contractors });
    if (path.endsWith("/api/compliance-hub/guidance")) {
      return route.fulfill({ json: { guidance: [], disclaimer: "", reviewedAt: "2026-10-01", gaps: [] } });
    }
    return route.fulfill({ json: [] });
  });

  await page.goto(`${baseUrl}/compliance-hub`);
  const dropdown = label => page.getByRole("combobox", { name: label, exact: true });
  const choose = async (label, option) => {
    await dropdown(label).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  const typed = label => page.getByRole("textbox", { name: label, exact: true });
  const operation = dropdown("Premises / operation type");
  const name = dropdown("Responsible person");
  const role = dropdown("Responsible person's role");
  const cadence = dropdown("Review cadence");
  await name.filter({ hasText: "Olive Owner" }).waitFor();

  // Setup's stand-in text shows as an unanswered dropdown.
  assert.match(await operation.innerText(), /Choose/, "Operation type stand-in is not shown as an answer");
  assert.match(await role.innerText(), /Choose/, "Role stand-in is not shown as an answer");
  // A value that is not in the list shows in the typing box under "Other".
  assert.match(await cadence.innerText(), /Other/, "Typed cadence shows as Other");
  assert.equal(await typed("Review cadence").inputValue(), "Annual and after significant change");
  // Moved to their tracks.
  assert.equal(await page.getByText("HACCP system review").count(), 0, "HACCP review is no longer on the Hub");
  assert.equal(await page.getByText(/written-scheme reference/i).count(), 0, "Water written scheme is no longer on the Hub");
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await page.locator("main").screenshot({ path: `${screenshotDir}/1-profile-dropdowns.png` });
  }

  // The lists read A to Z, with Other last.
  await operation.click();
  const operationOptions = await page.getByRole("option").allInnerTexts();
  assert.equal(operationOptions.at(-1), "Other (type it in)");
  assert.ok(operationOptions.indexOf("Golf Club") < operationOptions.indexOf("Retail"), "Operation types are A to Z");
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/2-operation-type-list.png` });
  await page.getByRole("option", { name: "Golf Club", exact: true }).click();

  // Picking a person with a login fills in their email.
  await choose("Responsible person", "Sam Smith");
  assert.equal(await page.locator('input[type="email"]').inputValue(), "sam@example.test");

  // "Other" opens a box to type in, with the cursor in it.
  await choose("Responsible person's role", "Other (type it in)");
  await page.keyboard.type("Head greenkeeper");
  assert.equal(await typed("Responsible person's role").inputValue(), "Head greenkeeper");
  await choose("Review cadence", "Every 6 months and after material change");
  assert.equal(await typed("Review cadence").count(), 0, "Picking from the list closes the typing box");

  // Competent-person appointment: area, then a person or contractor.
  await page.getByRole("button", { name: "Add appointment" }).click();
  const appointment = page.locator("div.grid").filter({ has: page.getByPlaceholder("Evidence reference") }).last();
  await appointment.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Legionella / water hygiene", exact: true }).click();
  await appointment.getByRole("combobox").nth(1).click();
  assert.ok(await page.getByRole("option", { name: "Wendy Water, AquaCare Ltd" }).isVisible(), "Contractors are listed");
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/3-appointment-person-list.png` });
  await page.getByRole("option", { name: "Wendy Water, AquaCare Ltd", exact: true }).click();

  await page.getByRole("button", { name: "Save accountability profile" }).click();
  await page.getByText("Accountability profile saved").first().waitFor();
  assert.equal(saves[0].operationType, "Golf Club");
  assert.equal(saves[0].responsiblePersonName, "Sam Smith");
  assert.equal(saves[0].responsiblePersonEmail, "sam@example.test");
  assert.equal(saves[0].responsiblePersonRole, "Head greenkeeper");
  assert.equal(saves[0].reviewCadence, "Every 6 months and after material change");
  assert.deepEqual(saves[0].competentAppointments, [{ area: "Legionella / water hygiene", person: "Wendy Water, AquaCare Ltd", evidence: "" }]);
  assert.equal(saves[0].haccpSystemReviewed, true, "The hidden HACCP answer is kept");
  assert.equal(saves[0].waterWrittenSchemeReference, "Water scheme rev 3", "The hidden written scheme is kept");

  // A stand-in left unanswered goes back as it was.
  saves.length = 0;
  storedProfile.operationType = "Not yet described";
  await page.reload();
  await name.filter({ hasText: "Olive Owner" }).waitFor();
  await page.getByRole("button", { name: "Save accountability profile" }).click();
  for (let attempt = 0; saves.length < 1 && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(saves[0].operationType, "Not yet described", "Unanswered operation type sends the stand-in back");
  assert.equal(saves[0].responsiblePersonRole, "Business owner or manager", "Unanswered role sends the stand-in back");

  // No corrective-action logging; earlier non-incident actions can be finished.
  assert.equal(await page.getByText("Log a corrective action").count(), 0);
  await page.getByRole("tab", { name: "Earlier actions (1)" }).click();
  await page.getByText("Fire door wedged open").waitFor();
  assert.equal(await page.getByText("Slip in kitchen").count(), 0, "IncidentTrack actions are on the incident");
  if (screenshotDir) await page.locator("main").screenshot({ path: `${screenshotDir}/4-earlier-actions.png` });

  assert.deepEqual(pageErrors, [], "No page errors");
  console.log("Compliance Hub profile browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
