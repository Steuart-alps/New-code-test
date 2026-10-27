// Real API/storage browser round trip for photos and videos on track actions.
//
// Run through `pnpm --filter @workspace/api-server run test:track-action-media-roundtrip`
// (tests/run-photo-storage-roundtrip.sh --track-action-media), which boots a
// disposable database and the real API with production CSRF and mandatory 2FA,
// serving the web build from the same origin. On the Report actions page an
// owner drags a photo and a video onto an action; the browser PUTs them
// straight to storage, the API checks and copies each one to an immutable
// tenant key, and the action shows them before and after a reload. The
// evidence panel on that page must load, and a resolved action, another
// tenant and a viewer cannot add files.
//
// Storage is the dedicated test bucket, or — only with --in-process-fake — an
// in-process fake of the storage client, which is NOT the real round trip.
//
// Set PHOTO_ROUNDTRIP_SCREENSHOT_DIR to save screenshots of the page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { createBucketInspector } from "../../api-server/tests/photo-roundtrip-bucket.mjs";
import { api, signIn, signUpTenant } from "./storage-roundtrip-session.mjs";

const appUrl = process.env.PHOTO_ROUNDTRIP_APP_URL;
assert.ok(appUrl, "Run through the api-server test:track-action-media-roundtrip script");
const fakeStorage = process.env.PHOTO_ROUNDTRIP_STORAGE === "in-process-fake";
const screenshotDir = process.env.PHOTO_ROUNDTRIP_SCREENSHOT_DIR || "";
const inspector = await createBucketInspector(process.env);
console.log(fakeStorage
  ? "Track action media round trip against the IN-PROCESS FAKE storage client — proves the test logic, NOT real GCS."
  : `Track action media round trip against the dedicated test bucket ${inspector.label}/${inspector.prefix}/`);

// A real, fully checksummed RGB PNG: the API decodes and re-encodes photos.
function pngChunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])), body.length + 8);
  return out;
}
function realPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) =>
    Buffer.from([0, ...Array.from({ length: width }, (_, x) => [(x * 7) % 256, (y * 5) % 256, 180]).flat()])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const photo = { name: "fire-door.png", type: "image/png", bytes: realPng(48, 36) };
const video = { name: "walk-round.mp4", type: "video/mp4", bytes: readFileSync(new URL("./fixtures/fixtrack-video/issue-video.mp4", import.meta.url)) };

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// A 1x1 transparent PNG, enough for the drawn-signature format check.
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function shot(page, name) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, name), fullPage: false });
}

/** Drag files onto an element, as a person dragging from their desktop would. */
async function dropFiles(page, selector, files) {
  await page.evaluate(({ selector, files }) => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    const zone = document.querySelector(selector);
    if (!zone) throw new Error(`no drop zone ${selector}`);
    for (const type of ["dragenter", "dragover", "drop"]) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, { selector, files: files.map(file => ({ name: file.name, type: file.type, bytes: Array.from(file.bytes) })) });
}

async function objectRead(page, objectPath) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    return { status: response.status, contentType: response.headers.get("content-type"), length: (await response.arrayBuffer()).byteLength };
  }, `/api/storage${objectPath}`);
}

let browser;
let staffPage;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: fakeStorage
      ? [`--host-resolver-rules=MAP storage.googleapis.com:443 127.0.0.1:${process.env.PHOTO_ROUNDTRIP_FAKE_UPLOAD_PORT}`, "--no-proxy-server"]
      : [],
  });
  const contextOptions = { viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: fakeStorage };
  const contextA = await browser.newContext(contextOptions);
  const contextB = await browser.newContext(contextOptions);
  const contextViewer = await browser.newContext(contextOptions);

  const tenantA = await signUpTenant(contextA, {
    appUrl, label: "a", email: `action-media-a-${suffix}@test.local`, password: `pw-${suffix}-a`, name: "Action media owner",
  });
  const tenantB = await signUpTenant(contextB, {
    appUrl, label: "b", email: `action-media-b-${suffix}@test.local`, password: `pw-${suffix}-b`, name: "Other owner",
  });
  staffPage = tenantA.page;
  const pageErrors = [];
  staffPage.on("pageerror", error => pageErrors.push(error.message));

  const created = await api(staffPage, "POST", "/track-actions", {
    module: "audit", title: "Repair the self-closer on the first-floor fire door", severity: "action_required",
    instruction: "Fire risk assessment, item 4.2",
  });
  assert.equal(created.status, 201, `create a Report actions action: ${created.text}`);
  const actionId = created.data.id;
  assert.deepEqual(created.data.mediaUrls, [], "a new action has no photos or videos");
  const otherAction = await api(tenantB.page, "POST", "/track-actions", { module: "audit", title: "Other tenant action", severity: "monitor" });
  assert.equal(otherAction.status, 201);

  // ── 1. The Report actions page loads its actions and evidence panel ──────
  const evidenceResponses = [];
  staffPage.on("response", response => {
    if (new URL(response.url()).pathname.startsWith("/api/track-evidence")) evidenceResponses.push(response.status());
  });
  const navigation = await staffPage.goto(`${appUrl}/report-actions`);
  assert.ok(navigation?.ok(), `Report actions page: ${navigation?.status()}`);
  const zone = `[data-testid="action-media-${actionId}"]`;
  await staffPage.locator(zone).waitFor({ state: "visible" });
  await staffPage.waitForLoadState("networkidle");
  assert.ok(evidenceResponses.length > 0 && evidenceResponses.every(status => status === 200),
    `the evidence panel loads for Report actions: ${JSON.stringify(evidenceResponses)}`);
  assert.equal(await staffPage.getByText("Couldn't load evidence requirements").count(), 0, "no evidence load error");
  await staffPage.locator(zone).scrollIntoViewIfNeeded();
  await shot(staffPage, "1-action-before.png");

  // ── 2. Drag a photo and a video onto the action ─────────────────────────
  const storagePuts = [];
  staffPage.on("request", request => {
    const url = new URL(request.url());
    if (url.hostname === "storage.googleapis.com" && request.method() === "PUT") storagePuts.push(url.pathname);
  });
  await dropFiles(staffPage, zone, [photo, video]);
  await staffPage.getByText("2 photos and videos added", { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(storagePuts.length, 2, "both files go straight from the browser to storage");
  for (const put of storagePuts) assert.match(put, new RegExp(`/uploads/tenant-${tenantA.clientId}/`), "uploads land in this tenant's staging area");

  const listed = await api(staffPage, "GET", "/track-actions?module=audit");
  const action = listed.data.find(item => item.id === actionId);
  assert.equal(action.mediaUrls.length, 2, `the action lists both files: ${JSON.stringify(action.mediaUrls)}`);
  assert.match(action.mediaUrls[0], new RegExp(`^/objects/finalized/tenant-${tenantA.clientId}/[0-9a-f-]{36}\\.png$`), "the photo is finalised for this tenant");
  assert.match(action.mediaUrls[1], new RegExp(`^/objects/finalized/tenant-${tenantA.clientId}/[0-9a-f-]{36}\\.mp4$`), "the video is finalised for this tenant");
  assert.deepEqual(await inspector.list(`uploads/tenant-${tenantA.clientId}/`), [], "staging uploads are cleared");
  const photoRead = await objectRead(staffPage, action.mediaUrls[0]);
  assert.equal(photoRead.status, 200, "the photo can be shown");
  assert.equal(photoRead.contentType, "image/png");
  const videoRead = await objectRead(staffPage, action.mediaUrls[1]);
  assert.equal(videoRead.status, 200, "the video can be played");
  assert.equal(videoRead.length, video.bytes.length, "the video is stored whole");
  await staffPage.getByTestId(`button-open-action-media-${actionId}-1`).waitFor({ state: "visible" });
  await shot(staffPage, "2-action-with-photo-and-video.png");

  // ── 3. They are still there after a reload, and the resolve form accepts them as evidence ──
  await staffPage.reload();
  await staffPage.getByTestId(`button-open-action-media-${actionId}-1`).waitFor({ state: "visible" });
  await staffPage.locator(zone).locator("xpath=ancestor::article").getByRole("button", { name: "Resolve action" }).click();
  await staffPage.getByText("(optional, photos are attached)").waitFor({ state: "visible" });
  await staffPage.locator(zone).locator("xpath=ancestor::article").getByRole("button", { name: "Resolve action" }).scrollIntoViewIfNeeded();
  await shot(staffPage, "3-resolve-with-photos.png");

  // ── 4. Other tenants and viewers cannot add files ───────────────────────
  assert.equal((await api(tenantB.page, "POST", `/track-actions/${actionId}/request-upload`, { name: "x.jpg", contentType: "image/jpeg" })).status, 404,
    "another tenant cannot get an upload link for this action");
  assert.equal((await objectRead(tenantB.page, action.mediaUrls[0])).status, 403, "another tenant cannot open the photo");
  assert.equal((await api(tenantB.page, "POST", `/track-actions/${otherAction.data.id}/media`, { objectPath: action.mediaUrls[0] })).status, 403,
    "another tenant cannot attach this tenant's photo to its own action");
  for (const contentType of ["text/html", "image/svg+xml", "application/pdf"]) {
    assert.equal((await api(staffPage, "POST", `/track-actions/${actionId}/request-upload`, { name: "x", contentType })).status, 400,
      `no upload link is signed for ${contentType}`);
  }
  const viewerEmail = `action-media-viewer-${suffix}@test.local`;
  const viewerPassword = `pw-${suffix}-viewer`;
  const viewerCreated = await api(staffPage, "POST", "/users", {
    name: "Action media viewer", email: viewerEmail, password: viewerPassword, role: "client_viewer", clientId: tenantA.clientId,
  });
  assert.equal(viewerCreated.status, 201, `create viewer: ${viewerCreated.text}`);
  const viewerPage = await contextViewer.newPage();
  viewerPage.setDefaultTimeout(20_000);
  await viewerPage.goto(`${appUrl}/login`);
  await signIn(viewerPage, "viewer", viewerEmail, viewerPassword);
  assert.equal((await api(viewerPage, "POST", `/track-actions/${actionId}/request-upload`, { name: "v.jpg", contentType: "image/jpeg" })).status, 403,
    "a viewer cannot add files");

  // ── 5. A resolved action keeps its files but takes no more ──────────────
  const resolved = await api(staffPage, "PATCH", `/track-actions/${actionId}`, {
    status: "resolved", remedialAction: "Self-closer replaced", evidenceReference: "2 photos and videos attached in ComplyTrack",
    resolutionNotes: "Door closes fully from 90 degrees", resolverSignature: SIGNATURE,
  });
  assert.equal(resolved.status, 200, `resolve: ${resolved.text}`);
  assert.equal(resolved.data.mediaUrls.length, 2, "resolving keeps the files");
  assert.equal((await api(staffPage, "POST", `/track-actions/${actionId}/request-upload`, { name: "late.jpg", contentType: "image/jpeg" })).status, 409,
    "no files can be added once the action is resolved");

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("; ")}`);
  console.log(fakeStorage
    ? "Track action media round trip passed against the IN-PROCESS FAKE storage client (test logic only; not a real GCS round trip)."
    : `Track action media round trip passed against ${inspector.label}: drag-and-drop photo and video, finalisation, reload, evidence panel, tenant and viewer refusal, resolved actions closed.`);
} catch (error) {
  if (staffPage) {
    console.error("Page:", staffPage.url());
    console.error("Visible text:", (await staffPage.locator("body").innerText().catch(() => "")).slice(0, 3000));
  }
  throw error;
} finally {
  await browser?.close();
}
