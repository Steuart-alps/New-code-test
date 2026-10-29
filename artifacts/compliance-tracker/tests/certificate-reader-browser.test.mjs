import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

// Browser regression for reading several certificate files at once
// (components/certificate-reader-dialog.tsx, lib/certificate-files.ts):
//   - the picker takes many files, including iPhone (HEIC) photos and scans;
//   - one request reads them all; each certificate found is checked and saved
//     in turn, and the pages of one certificate are stored as one joined PDF;
//   - a file that cannot be read is named with the reason, the rest go ahead;
//   - without the AI add-on the same files are filled in by hand.
// API responses mirror artifacts/api-server/src/routes/certificates.ts.
// SCREENSHOT_DIR=... saves screenshots of each step.
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const screenshotDir = process.env.SCREENSHOT_DIR;
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

// A 1x1 PNG stands in for each photographed page.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PDF = Buffer.from("%PDF-1.4\n%stand-in EICR\n");
const json = (route, data, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(data) });
const aiStatus = active => ({
  configured: true, active, plan: active ? "addon" : "none", percentUsed: 10, resetsAt: "2026-11-01T00:00:00.000Z", usedUp: false,
  carriedOverPercent: 0, nextLapseAt: null, nextLapsePercent: 0,
});
const items = [
  { id: 41, title: "Electrical Installation Condition Report (EICR)", siteName: "Clubhouse", categoryName: "Electrical", contractorId: null },
  { id: 42, title: "Gas Safety Inspection", siteName: "Clubhouse", categoryName: "Heating", contractorId: null },
];
const reading = overrides => ({
  certificateType: "", name: "", itemId: null, checkReason: "", newCheck: null, contractorName: null, issueDate: null,
  nextInspectionDate: null, nextInspectionSource: null, outcome: "satisfactory", summary: "", defects: [], unclear: [], ...overrides,
});
const READ = {
  certificates: [
    {
      ...reading({
        certificateType: "Oil boiler service record (OFTEC CD/11)", name: "Oil boiler service 2026 - clubhouse",
        checkReason: "No oil boiler check yet, so a new yearly check is suggested.", newCheck: { title: "Oil Boiler Service", frequencyMonths: 12 },
        contractorName: "Heatwise Oil Services", issueDate: "2026-09-15", nextInspectionDate: "2027-09-15", nextInspectionSource: "repeat",
        summary: "Boiler serviced and left safe to use. The tank bund holds rainwater and needs emptying.",
        defects: [{ code: "other", description: "Oil tank bund full of rainwater; empty and check for oil", location: "Oil tank", reference: null, needsWork: true }],
      }),
      fileIndexes: [0, 1],
    },
    {
      ...reading({
        certificateType: "Electrical Installation Condition Report (EICR)", name: "EICR 2026 - Clubhouse", itemId: 41,
        checkReason: "An EICR for the clubhouse.", contractorName: "Sparks Ltd", issueDate: "2026-10-01", nextInspectionDate: "2031-10-01",
        nextInspectionSource: "certificate", summary: "Satisfactory with two C3 recommendations.",
        defects: [{ code: "C3", description: "No surge protection", location: "Main board", reference: "1", needsWork: false }],
      }),
      fileIndexes: [2],
    },
  ],
  skipped: [],
};

async function open({ aiActive, viewport = { width: 1280, height: 900 } }) {
  const requests = [];
  const uploads = [];
  const context = await browser.newContext({ viewport, locale: "en-GB", isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/upload-target/**", async route => {
    uploads.push({ contentType: route.request().headers()["content-type"], body: route.request().postDataBuffer() });
    await route.fulfill({ status: 200, body: "" });
  });
  let nextUpload = 1, nextItem = 50, nextCertificate = 70;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    requests.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/auth/csrf-token") return json(route, { token: "browser-test-csrf" });
    if (url.pathname === "/api/auth/me") return json(route, {
      user: { id: 5, email: "owner@example.test", name: "Owner", role: "client_admin", clientId: 23, departmentId: null, active: true, totpEnabled: true },
      billingLocked: false, client: { id: 23, name: "Bramshaw Test", slug: "test", logoUrl: null, primaryColor: "#2F7C8C", active: true },
      services: [],
    });
    if (url.pathname === "/api/certificates/reading") return json(route, { available: true, ai: aiStatus(aiActive), fixTrack: true });
    if (url.pathname === "/api/compliance-items" && method === "GET") return json(route, items);
    if (url.pathname === "/api/compliance-items" && method === "POST") return json(route, { id: nextItem++, ...body }, 201);
    if (url.pathname === "/api/contractors" || url.pathname === "/api/sites") return json(route, []);
    if (url.pathname === "/api/certificates/read-files") return json(route, READ);
    if (url.pathname === "/api/storage/uploads/request-url") {
      const id = nextUpload++;
      return json(route, { uploadURL: `${baseUrl}/upload-target/${id}`, objectPath: `/objects/uploads/${id}` });
    }
    const filed = url.pathname.match(/^\/api\/items\/(\d+)\/certificates$/);
    if (filed && method === "POST") return json(route, { id: nextCertificate++, itemId: Number(filed[1]), ...body, defects: [] }, 201);
    return json(route, {});
  });
  await page.goto(`${baseUrl}/tests/certificate-reader-harness.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Read a certificate with AI" }).click();
  await page.getByRole("button", { name: "Choose files" }).waitFor();
  await page.waitForFunction(() => !document.querySelector("[role=dialog] button[disabled]"));
  return { page, context, requests, uploads, pageErrors };
}

const files = [
  { name: "oil service page 1.png", mimeType: "image/png", buffer: PNG },
  { name: "oil service page 2.png", mimeType: "image/png", buffer: PNG },
  { name: "EICR clubhouse.pdf", mimeType: "application/pdf", buffer: PDF },
];
const shot = async (page, name) => {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.locator("[role=dialog]").screenshot({ path: `${screenshotDir}/${name}.png` });
};
async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${what}`);
}

try {
  await waitForVite();
  browser = await chromium.launch({
    headless: true, args: ["--no-sandbox", "--lang=en-GB"], executablePath: chromiumPath(), env: { ...process.env, LANG: "en_GB.UTF-8", LANGUAGE: "en_GB" },
  });

  // With the AI add-on: three files, two certificates.
  {
    const { page, context, requests, uploads, pageErrors } = await open({ aiActive: true });
    const input = page.locator("input[type=file]");
    assert.equal(await input.getAttribute("multiple"), "", "the picker takes several files");
    const accept = (await input.getAttribute("accept")).split(",");
    for (const type of [".pdf", ".heic", ".tiff", "image/*", ".docx"]) assert.ok(accept.includes(type), `the picker lists ${type}`);
    await shot(page, "1-choose-files");

    await input.setInputFiles([...files, { name: "old notes.doc", mimeType: "application/msword", buffer: Buffer.from("doc") }]);
    await page.getByText("Certificate 1 of 2").waitFor();
    const reads = requests.filter(r => r.path === "/api/certificates/read-files");
    assert.equal(reads.length, 1, "one request reads every file");
    assert.deepEqual(reads[0].body.files.map(f => f.fileName), files.map(f => f.name), "the .doc is not sent");
    assert.equal(reads[0].body.itemId, null);
    assert.equal(requests.filter(r => r.path === "/api/certificates/read").length, 0);
    await page.getByText("old notes.doc: this is an older Word file (.doc). Save it as a PDF").waitFor();
    await page.getByRole("link", { name: "Open oil service page 1.png" }).waitFor();
    await page.getByRole("link", { name: "Open oil service page 2.png" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Open EICR clubhouse.pdf" }).count(), 0, "only this certificate's files");
    assert.equal(await page.locator("#reader-check").inputValue(), "new", "no oil check yet: a new one is offered");
    assert.equal(await page.locator("#reader-new-title").inputValue(), "Oil Boiler Service");
    await shot(page, "2-oil-certificate-from-two-photos");

    await page.getByText("I have checked these details against the certificate").click();
    await page.getByRole("checkbox", { name: /Ask for a quote/ }).click();
    await page.getByRole("button", { name: "Save certificate" }).click();
    await page.getByText("Certificate 2 of 2").waitFor();
    const created = requests.find(r => r.method === "POST" && r.path === "/api/compliance-items");
    assert.equal(created.body.title, "Oil Boiler Service");
    assert.equal(created.body.frequencyMonths, 12);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].contentType, "application/pdf", "two photos are stored as one PDF");
    const joined = await PDFDocument.load(uploads[0].body);
    assert.equal(joined.getPageCount(), 2, "one page per photo");
    const firstSaved = requests.find(r => r.method === "POST" && r.path === "/api/items/50/certificates");
    assert.equal(firstSaved.body.fileUrl, "/objects/uploads/1");
    assert.equal(firstSaved.body.readByAi, true);
    assert.equal(firstSaved.body.defects[0].needsWork, true);
    await page.getByText("1 saved so far.").waitFor();
    assert.equal(await page.locator("#reader-name").inputValue(), "EICR 2026 - Clubhouse");
    await shot(page, "3-next-certificate");

    await page.getByText("I have checked these details against the certificate").click();
    await page.getByRole("button", { name: "Save certificate" }).click();
    await waitFor(() => requests.some(r => r.method === "POST" && r.path === "/api/items/41/certificates"), "the EICR to be saved");
    await page.locator("[role=dialog]").waitFor({ state: "detached" });
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1].contentType, "application/pdf");
    assert.equal(uploads[1].body.toString(), PDF.toString(), "a certificate on one file is stored as it is");
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log("ok - several files are read in one go; each certificate is saved in turn, with its pages joined into one PDF");
  }

  // On a phone.
  if (screenshotDir) {
    const { page, context } = await open({ aiActive: true, viewport: { width: 390, height: 844 } });
    await shot(page, "4-phone-choose-files");
    await page.locator("input[type=file]").setInputFiles(files);
    await page.getByText("Certificate 1 of 2").waitFor();
    await shot(page, "5-phone-oil-certificate");
    await context.close();
  }

  // Without the AI add-on: the same files, filled in by hand.
  {
    const { page, context, requests, pageErrors } = await open({ aiActive: false });
    await page.getByText("You can still upload certificates and fill them in by hand.").waitFor();
    await page.locator("input[type=file]").setInputFiles(files.slice(0, 2));
    await page.getByText("Certificate 1 of 2").waitFor();
    assert.equal(requests.filter(r => r.method === "POST" && r.path.startsWith("/api/certificates/read")).length, 0, "nothing is sent to the AI");
    assert.equal(await page.locator("#reader-name").inputValue(), "oil service page 1");
    await page.getByRole("link", { name: "Open oil service page 1.png" }).waitFor();
    assert.equal(await page.locator("#reader-check").inputValue(), "", "the person chooses the check");
    await page.getByText("No defects added.").waitFor();
    await shot(page, "6-without-ai");
    await page.getByRole("button", { name: "Skip this one" }).click();
    await page.getByText("Certificate 2 of 2").waitFor();
    await page.getByRole("button", { name: "Skip and finish" }).click();
    await page.locator("[role=dialog]").waitFor({ state: "detached" });
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log("ok - without the AI add-on the files are filled in by hand, one by one");
  }

  console.log("Certificate reader browser checks passed.");
} finally {
  await browser?.close();
  vite.kill();
}
