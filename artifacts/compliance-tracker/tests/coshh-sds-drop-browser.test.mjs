import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";

// Browser regression for dropping a safety data sheet on COSHHTrack's New
// assessment form (src/components/coshh-sds-drop.tsx, pages/coshh-track.tsx):
//   - with "Fill it in with AI" on, the sheet is attached and read, the form
//     is filled in, the "checked against the sheet" tick is required, and a
//     product not on the Substances list is added to it (with the sheet) and
//     linked on save;
//   - a product already on the list is linked instead;
//   - with the switch off the sheet is only attached (nothing read), and it
//     can still be read afterwards; the choice is remembered;
//   - without the AI features add-on the switch is off and can't be turned on.
// The API is mocked; anything not listed returns an empty list. Set
// SCREENSHOT_DIR to save screenshots.
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const screenshots = process.env.SCREENSHOT_DIR;
if (screenshots) mkdirSync(screenshots, { recursive: true });
/** A screenshot once the dialog has finished opening, when SCREENSHOT_DIR is set. */
const shot = async (page, name) => {
  if (!screenshots) return;
  await page.waitForTimeout(500);
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

const authMe = {
  user: { id: 7, email: "owner@example.test", name: "Olive Owner", role: "client_admin", clientId: 1, departmentId: null, active: true, totpEnabled: true },
  client: { id: 1, name: "Business 1", primaryColor: "#7FA8C9", logoUrl: null },
  services: ["core", "coshhtrack"],
  billingLocked: false,
  twoFactorRequired: false,
};
const aiStatus = (active) => ({
  configured: true, active, plan: active ? "addon" : "none", percentUsed: 12, resetsAt: null, usedUp: false,
  carriedOverPercent: 0, nextLapseAt: null, nextLapsePercent: 0,
});
const substances = [{
  id: 1, siteId: 1, productName: "Oven Cleaner Pro", supplier: null, hazardPictograms: ["ghs05"], whereUsed: "Kitchen",
  sdsObjectPath: null, sdsFileName: null, assessmentDate: null, reviewDue: null, controls: null, status: "in_use", reviewOverdue: false,
}];
const draft = (productName) => ({
  productName, supplier: "Clean Co Ltd", sdsDate: "2025-03-14", hazardPictograms: ["ghs05", "ghs07"], signalWord: "danger",
  hazardStatements: "H314 Causes severe skin burns and eye damage\nH290 May be corrosive to metals",
  healthEffects: "Burns to skin and eyes. Mist irritates the nose and throat.", exposureLimits: "Sodium hydroxide: STEL 2 mg/m3 (EH40)",
  exposureRoutes: ["inhalation", "skin", "eyes"], ppe: ["gloves", "eye_protection"], ppeDetails: "Nitrile gloves (EN ISO 374); goggles (EN 166)",
  controls: "Use diluted from the dispenser.\nNever mix with bleach.\nGood ventilation.", storage: "Locked chemical store, away from acids.",
  spillProcedure: "Absorb with sand and put in a sealed container.", firstAid: "Eyes: rinse with water for 15 minutes and get medical help.",
  disposal: "Through a licensed waste contractor.", task: "Cleaning kitchen surfaces and equipment with the degreaser",
  whoAtRisk: "Kitchen staff and cleaners using it; others nearby", riskLevel: "medium", healthSurveillanceRequired: false,
  monitoringRequired: false, levRequired: false, summary: "A corrosive alkaline degreaser: burns skin and eyes.",
  unclear: ["Glove breakthrough time not given"],
});
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

async function open({ aiActive = true, product = "Heavy Duty Degreaser", storage } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  if (storage) await context.addInitScript((value) => localStorage.setItem("complytrack.coshh-sds-ai", value), storage);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const requests = [];
  await page.route("**/fake-upload/**", route => route.fulfill({ status: 200, body: "" }));
  let uploads = 0;
  await page.route("**/api/**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    if (request.method() !== "GET") requests.push({ path, body });
    if (path.endsWith("/api/auth/me")) return route.fulfill({ json: authMe });
    if (path.endsWith("/api/auth/csrf")) return route.fulfill({ json: { csrfToken: "test" } });
    if (path.endsWith("/api/notifications")) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (path.endsWith("/api/managed-by")) return route.fulfill({ json: null });
    if (path.endsWith("/api/storage/status")) return route.fulfill({ json: { state: "not_limited", canManage: true, autoTopUp: false, usedBytes: 0, capacityBytes: null } });
    if (path.endsWith("/api/sites")) return route.fulfill({ json: [{ id: 1, name: "Harbour Hotel", clientId: 1 }] });
    if (path.endsWith("/api/registers/uploads/request-url")) {
      uploads += 1;
      return route.fulfill({ json: { uploadUrl: `${baseUrl}/fake-upload/${uploads}`, objectPath: `/objects/uploads/sheet-${uploads}` } });
    }
    if (path.endsWith("/api/registers/coshh") && request.method() === "POST") return route.fulfill({ status: 201, json: { ...substances[0], id: 9, productName: body.productName } });
    if (path.endsWith("/api/registers/coshh")) return route.fulfill({ json: substances });
    if (path.endsWith("/api/coshh-track/sds-reading")) return route.fulfill({ json: { available: true, ai: aiStatus(aiActive) } });
    if (path.endsWith("/api/coshh-track/assessments/read-sds")) return route.fulfill({ json: draft(product) });
    if (path.endsWith("/api/coshh-track/assessments") && request.method() === "POST") return route.fulfill({ status: 201, json: {} });
    if (path.endsWith("/api/coshh-track/status")) return route.fulfill({ json: { overdue: 0, dueSoon: 0, missing: 0, dueSoonDays: 30, items: [] } });
    if (path.endsWith("/api/coshh-track/sign-offs")) return route.fulfill({ json: { assessments: [] } });
    return route.fulfill({ json: [] });
  });
  await page.goto(`${baseUrl}/coshh-track`);
  await page.getByRole("button", { name: "New assessment" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Drag the safety data sheet here").waitFor();
  return { page, context, dialog, requests, pageErrors };
}

/** A real file drop, as from Finder or Explorer, on the drop box. */
async function dropSheet(page, name = "Degreaser SDS.pdf") {
  return page.evaluate(({ name, bytes }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
    const target = document.querySelector("[data-testid='coshh-sds-drop'] [data-file-drop-zone]");
    let taken = false;
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(event);
      if (type === "drop") taken = event.defaultPrevented;
    }
    return taken;
  }, { name, bytes: [...PDF] });
}

try {
  await waitForVite();
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });

  // ── AI on: the sheet fills in the form; a new product joins the Substances list ──
  {
    const { page, context, dialog, requests, pageErrors } = await open();
    const aiSwitch = dialog.getByRole("switch", { name: "Fill it in with AI" });
    assert.equal(await aiSwitch.getAttribute("aria-checked"), "true", "the AI switch starts on with the add-on");
    await shot(page, "1-drop-box");
    assert.equal(await dropSheet(page), true, "the box takes the dropped file");
    await dialog.getByText("Read from the safety data sheet (dated 14 Mar 2025)").waitFor();
    const reads = requests.filter(r => r.path === "/api/coshh-track/assessments/read-sds");
    assert.equal(reads.length, 1, "the sheet is read once");
    assert.equal(reads[0].body.files[0].fileName, "Degreaser SDS.pdf");
    assert.equal(Buffer.from(reads[0].body.files[0].data, "base64").toString(), PDF.toString(), "the file is sent as it is");
    assert.equal(await dialog.locator("#coshh-task").inputValue(), "Cleaning kitchen surfaces and equipment with the degreaser");
    assert.match(await dialog.locator("#coshh-hazards").inputValue(), /H314/);
    assert.match(await dialog.locator("#coshh-controls").inputValue(), /Never mix with bleach/);
    assert.equal(await dialog.locator("#coshh-first-aid").inputValue(), "Eyes: rinse with water for 15 minutes and get medical help.");
    await dialog.getByText("Glove breakthrough time not given").waitFor();
    await dialog.getByText("Degreaser SDS.pdf").first().waitFor();
    const addToList = dialog.getByRole("checkbox", { name: /Add Heavy Duty Degreaser \(Clean Co Ltd\) to this site's Substances list/ });
    assert.equal(await addToList.getAttribute("aria-checked"), "true", "a new product is added to the list by default");
    await shot(page, "2-filled-in-from-sheet");

    // Saving needs the "checked against the sheet" tick.
    await dialog.getByRole("button", { name: "Save" }).click();
    await page.getByText("Tick that you have checked this draft against the safety data sheet").first().waitFor();
    assert.equal(requests.filter(r => r.path === "/api/coshh-track/assessments").length, 0, "nothing saved without the tick");
    await dialog.getByText("This was drafted automatically from the safety data sheet").click();
    // The "tick that you have checked" message can sit over the button.
    await dialog.getByRole("button", { name: "Save" }).evaluate((button) => button.click());
    await dialog.waitFor({ state: "hidden" });
    const substance = requests.find(r => r.path === "/api/registers/coshh");
    assert.equal(substance.body.productName, "Heavy Duty Degreaser");
    assert.equal(substance.body.supplier, "Clean Co Ltd");
    assert.deepEqual(substance.body.hazardPictograms, ["ghs05", "ghs07"]);
    assert.match(substance.body.objectPath, /^\/objects\/uploads\/sheet-/, "the sheet is the substance's SDS");
    const saved = requests.find(r => r.path === "/api/coshh-track/assessments").body;
    assert.equal(saved.substanceId, 9, "the assessment is linked to the new substance");
    assert.equal(saved.draftSource, "ai");
    assert.equal(saved.checkedAgainstSds, true);
    assert.ok(saved.draftedAt);
    assert.equal(saved.objectPath, "/objects/uploads/sheet-1", "the sheet is also kept with the assessment");
    assert.notEqual(substance.body.objectPath, saved.objectPath, "each record gets its own copy");
    assert.deepEqual(saved.ppe, ["gloves", "eye_protection"]);
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log("ok - with AI on, a dropped sheet fills in the assessment and adds the product to the Substances list");
  }

  // ── A product already on the list is linked to it ──────────────────────────
  {
    const { page, context, dialog, pageErrors } = await open({ product: "OVEN CLEANER PRO" });
    await dropSheet(page, "oven.pdf");
    await dialog.getByText("Read from the safety data sheet").waitFor();
    await dialog.locator("#coshh-assessment-substance").getByText("Oven Cleaner Pro").waitFor();
    assert.equal(await dialog.getByText(/to this site's Substances list/).count(), 0, "no second entry offered");
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log("ok - a product already on the Substances list is linked instead");
  }

  // ── AI off: attached only, read later on request; the choice is remembered ──
  {
    const { page, context, dialog, requests, pageErrors } = await open();
    await dialog.getByRole("switch", { name: "Fill it in with AI" }).click();
    await dialog.getByText("Off: the sheet is attached and you fill the form in by hand").waitFor();
    await dropSheet(page);
    await dialog.getByText("Safety data sheet: Degreaser SDS.pdf").waitFor();
    await page.getByText("Safety data sheet attached").first().waitFor();
    assert.equal(requests.filter(r => r.path === "/api/coshh-track/assessments/read-sds").length, 0, "nothing is read with the AI off");
    assert.equal(await dialog.locator("#coshh-task").inputValue(), "", "the form is left to fill in by hand");
    assert.equal(await dialog.getByText("This was drafted automatically").count(), 0);
    await dialog.getByRole("link", { name: "Open the sheet" }).waitFor();
    await shot(page, "3-ai-off-attached");
    await dialog.getByRole("button", { name: "Fill in from the sheet with AI" }).click();
    await dialog.getByText("Read from the safety data sheet").waitFor();
    assert.equal(requests.filter(r => r.path === "/api/coshh-track/assessments/read-sds").length, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem("complytrack.coshh-sds-ai")), "off", "the choice is remembered");
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log("ok - with AI off the sheet is only attached, and can still be read afterwards");
  }

  // ── Without the AI add-on: attach and fill by hand ─────────────────────────
  {
    const { page, context, dialog, requests, pageErrors } = await open({ aiActive: false });
    const aiSwitch = dialog.getByRole("switch", { name: "Fill it in with AI" });
    await dialog.getByText("This needs the AI features add-on").waitFor();
    assert.equal(await aiSwitch.getAttribute("aria-checked"), "false");
    assert.equal(await aiSwitch.isDisabled(), true);
    await shot(page, "4-without-ai-add-on");
    await dropSheet(page);
    await dialog.getByText("Safety data sheet: Degreaser SDS.pdf").waitFor();
    assert.equal(requests.filter(r => r.path === "/api/coshh-track/assessments/read-sds").length, 0);
    assert.equal(await dialog.getByRole("button", { name: "Fill in from the sheet with AI" }).count(), 0);
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log("ok - without the AI add-on the sheet is attached to fill in by hand");
  }

  console.log("COSHH safety data sheet drop browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
