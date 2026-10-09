// Real API/storage browser round trip for staff photo uploads.
//
// Run through `pnpm --filter @workspace/api-server run test:photo-storage-roundtrip`
// (tests/run-photo-storage-roundtrip.sh), which boots a disposable database and
// the real API with production CSRF and mandatory 2FA, serving the web build
// from the same origin. Nothing here intercepts or mocks a request: the
// browser signs in, requests a presigned URL, PUTs the bytes straight to the
// storage endpoint (CORS), attaches the photo (content validation + tenant ACL
// finalization), reloads it, and deletes it through the real page.
//
// Storage is the dedicated test bucket, or — only with --in-process-fake — an
// in-process fake of the storage client, which is NOT the real round trip.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { createBucketInspector } from "../../api-server/tests/photo-roundtrip-bucket.mjs";

const appUrl = process.env.PHOTO_ROUNDTRIP_APP_URL;
assert.ok(appUrl, "Run through the api-server test:photo-storage-roundtrip script");
const storageMode = process.env.PHOTO_ROUNDTRIP_STORAGE;
const fakeStorage = storageMode === "in-process-fake";
const inspector = await createBucketInspector(process.env);
const prefix = inspector.prefix;
console.log(fakeStorage
  ? "Photo storage round trip against the IN-PROCESS FAKE storage client — proves the test logic, NOT real GCS."
  : `Photo storage round trip against the dedicated test bucket ${inspector.label}/${prefix}/`);

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// A real, fully checksummed 4x4 RGB PNG: the API decodes and re-encodes photos.
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
    Buffer.from([0, ...Array.from({ length: width }, (_, x) => [x * 60, y * 60, 200]).flat()])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const pngBytes = realPng(4, 4);
const spoofedPng = Buffer.from("<html><script>alert('not an image')</script></html>");

function currentTotp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Same-origin fetch from inside the signed-in page, with the session's CSRF token unless disabled. */
async function api(page, method, path, body, { csrf = true } = {}) {
  return page.evaluate(async ({ method, path, body, csrf }) => {
    const headers = { "Content-Type": "application/json" };
    if (csrf && method !== "GET") {
      const tokenResponse = await fetch("/api/auth/csrf-token", { credentials: "same-origin" });
      headers["x-csrf-token"] = (await tokenResponse.json()).token;
    }
    const response = await fetch(`/api${path}`, {
      method, headers, credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, data, text: text.slice(0, 500), contentType: response.headers.get("content-type") };
  }, { method, path, body, csrf });
}

/** Register an isolated tenant through the real auth flow, including mandatory 2FA enrolment. */
async function createTenant(context, label) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const landing = await page.goto(`${appUrl}/login`);
  assert.ok(landing?.ok(), `${label}: web app served by the API (${landing?.status()})`);
  const email = `photo-roundtrip-${label}-${suffix}@test.local`;
  const password = `pw-${suffix}-${label}`;
  const registered = await api(page, "POST", "/auth/register", { name: `Photo ${label} admin`, email, password }, { csrf: false });
  assert.equal(registered.status, 200, `${label} registration: ${registered.text}`);
  const verified = await api(page, "GET", `/auth/verify-email?token=${encodeURIComponent(registered.data.verificationToken)}`);
  assert.equal(verified.status, 200, `${label} email verification: ${verified.text}`);
  const login = await api(page, "POST", "/auth/login", { email, password }, { csrf: false });
  assert.equal(login.data?.requires2faSetup, true, `${label} login must hold the session for mandatory 2FA: ${login.text}`);
  assert.equal((await api(page, "GET", "/incidents")).status, 401, `${label}: app routes stay closed until 2FA is enrolled`);
  const setup = await api(page, "GET", "/auth/2fa/setup");
  assert.equal(setup.status, 200, `${label} 2FA setup: ${setup.text}`);
  const enabled = await api(page, "POST", "/auth/2fa/enable", { code: currentTotp(setup.data.secret) });
  assert.equal(enabled.status, 200, `${label} 2FA enrolment: ${enabled.text}`);
  const me = await api(page, "GET", "/auth/me");
  const clientId = me.data?.user?.clientId;
  assert.ok(Number.isInteger(clientId), `${label} needs its own client`);
  const involvedName = `Photo ${label} person ${suffix}`;
  const incident = await api(page, "POST", "/incidents", {
    incidentDate: new Date().toISOString().slice(0, 10),
    location: `Photo ${label} yard`,
    description: "Photo storage round-trip fixture",
    involvedName,
    reportedBy: `Photo ${label} admin`,
    riddorRationale: "Synthetic test fixture: minor, not reportable",
  });
  assert.equal(incident.status, 201, `${label} incident fixture: ${incident.text}`);
  return { page, clientId, incidentId: incident.data.id, involvedName };
}

async function waitForToast(page, title) {
  await page.getByText(title, { exact: true }).first().waitFor({ state: "visible" });
}

let browser;
let pageA;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
    // Fake mode only: resolve the storage host to the in-process fake inside
    // this browser. Real mode talks to storage.googleapis.com unchanged.
    args: fakeStorage
      ? [`--host-resolver-rules=MAP storage.googleapis.com:443 127.0.0.1:${process.env.PHOTO_ROUNDTRIP_FAKE_UPLOAD_PORT}`, "--no-proxy-server"]
      : [],
  });
  const contextOptions = { viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: fakeStorage };
  const contextA = await browser.newContext(contextOptions);
  const contextB = await browser.newContext(contextOptions);
  const tenantA = await createTenant(contextA, "a");
  const tenantB = await createTenant(contextB, "b");
  assert.notEqual(tenantA.clientId, tenantB.clientId, "tenants must be isolated clients");
  pageA = tenantA.page;

  // ── Observe (never alter) the browser's traffic ──────────────────────────
  const pageErrors = [];
  pageA.on("pageerror", error => pageErrors.push(error.message));
  const storageRequests = [];
  const photoMutations = [];
  pageA.on("request", async request => {
    const url = new URL(request.url());
    if (url.hostname === "storage.googleapis.com") {
      const headers = await request.allHeaders();
      storageRequests.push({
        method: request.method(), pathname: url.pathname, headers,
        response: request.response().then(response => response && ({ status: response.status(), headers: response.headers() })),
      });
    } else if (url.origin === appUrl && url.pathname.startsWith("/api/photos") && request.method() !== "GET") {
      photoMutations.push({ method: request.method(), pathname: url.pathname, headers: await request.allHeaders() });
    }
  });
  pageA.on("dialog", dialog => dialog.accept());

  const navigation = await pageA.goto(`${appUrl}/incidents`);
  assert.ok(navigation?.ok(), `incidents page: ${navigation?.status()}`);
  const row = pageA.getByRole("row").filter({ hasText: tenantA.involvedName });
  await row.waitFor({ state: "visible" });
  const input = row.locator('input[type="file"]');
  assert.equal(await input.count(), 1, "the incident row renders the real photo uploader");

  // ── 1. Valid photo: presign → browser PUT (CORS) → attach/finalize → list ──
  const attachResponse = pageA.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/photos");
  const thumbnailResponse = pageA.waitForResponse(response =>
    new URL(response.url()).pathname.startsWith("/api/storage/objects/finalized/"));
  // Both are awaited below; this only stops an abandoned wait surfacing as an unhandled rejection.
  attachResponse.catch(() => {});
  thumbnailResponse.catch(() => {});
  await input.setInputFiles({ name: "staff-photo.png", mimeType: "image/png", buffer: pngBytes });
  const uploadFailed = pageA.getByText("Upload failed", { exact: true }).first();
  const firstOutcome = await Promise.race([
    attachResponse,
    uploadFailed.waitFor({ state: "visible" }).then(() => null),
  ]);
  if (!firstOutcome) {
    const toast = await uploadFailed.locator("xpath=..").innerText().catch(() => "");
    const storageStatuses = await Promise.all(storageRequests.map(async request =>
      `${request.method} ${(await request.response.catch(() => null))?.status ?? "no response (blocked by CORS or network)"}`));
    assert.fail(`The browser upload failed before attach: ${toast.replace(/\s+/g, " ")}; storage requests: ${storageStatuses.join(", ") || "none"}. `
      + "Check the test bucket's CORS origin matches PHOTO_ROUNDTRIP_WEB_PORT.");
  }
  const attached = firstOutcome;
  assert.equal(attached.status(), 201, `photo attach: ${await attached.text()}`);
  const photo = await attached.json();
  await waitForToast(pageA, "Photo added");
  const thumbnail = await thumbnailResponse;
  assert.equal(thumbnail.status(), 200, "the finalized photo is served back to its tenant");
  assert.equal(thumbnail.headers()["content-type"], "image/png");
  const viewButton = row.getByRole("button", { name: "View photo 1 of 1" });
  await viewButton.waitFor({ state: "visible" });
  await pageA.waitForFunction(
    () => [...document.querySelectorAll('img[src*="/api/storage/objects/finalized/"]')].some(img => img.complete && img.naturalWidth > 0),
  );

  const finalizedPath = photo.object_path;
  assert.match(finalizedPath, new RegExp(`^/objects/finalized/tenant-${tenantA.clientId}/[0-9a-f-]{36}\\.png$`),
    "the attachment stores a fresh immutable tenant key, not the signed staging key");

  // Session credentials never reach object storage; CSRF guards every API mutation.
  const puts = storageRequests.filter(request => request.method === "PUT");
  assert.equal(puts.length, 1, "exactly one direct browser upload to storage");
  const put = puts[0];
  assert.match(put.pathname, new RegExp(`/${prefix}/uploads/tenant-${tenantA.clientId}/`), "upload goes to this tenant's reserved staging key");
  for (const header of ["cookie", "x-csrf-token", "authorization"]) {
    assert.equal(put.headers[header], undefined, `storage PUT must not carry ${header}`);
  }
  assert.equal(put.headers["content-type"], "image/png", "the signed content type is sent with the upload");
  const putResponse = await put.response;
  assert.equal(putResponse?.status, 200, "storage accepted the signed PUT");
  assert.ok(
    [appUrl, "*"].includes(putResponse.headers["access-control-allow-origin"]),
    `storage answered the browser's CORS check for ${appUrl}`,
  );
  const csrfMutations = photoMutations.filter(mutation => mutation.method === "POST");
  assert.ok(csrfMutations.length >= 2, "request-upload and attach were both sent");
  for (const mutation of csrfMutations) {
    assert.match(mutation.headers["x-csrf-token"] ?? "", /^[0-9a-f]{64}$/, `${mutation.pathname} carries the session CSRF token`);
  }

  // Storage state: tenant ACL on the finalized key, staging generation removed.
  const finalizedObjects = await inspector.list(`finalized/tenant-${tenantA.clientId}/`);
  assert.equal(finalizedObjects.length, 1, "one finalized object for tenant A");
  const finalizedObject = finalizedObjects[0];
  assert.equal(`/objects/${finalizedObject.name.slice(prefix.length + 1)}`, finalizedPath);
  assert.equal(finalizedObject.contentType, "image/png");
  assert.deepEqual(
    JSON.parse(finalizedObject.metadata["custom:aclPolicy"]),
    { owner: String(tenantA.clientId), visibility: "private" },
    "ACL finalization tags the object with its tenant",
  );
  assert.deepEqual(await inspector.list(`uploads/tenant-${tenantA.clientId}/`), [], "the validated staging upload is deleted");

  // ── 2. Reload visibility ────────────────────────────────────────────────
  const reloadedThumbnail = pageA.waitForResponse(response =>
    new URL(response.url()).pathname === `/api/storage${finalizedPath}`);
  await pageA.reload();
  await row.waitFor({ state: "visible" });
  assert.equal((await reloadedThumbnail).status(), 200, "the photo is still served after a full reload");
  await viewButton.click();
  const lightbox = pageA.getByRole("dialog", { name: "Photo 1 of 1" });
  await lightbox.waitFor({ state: "visible" });
  await pageA.waitForFunction(() => {
    const img = document.querySelector('[role="dialog"] img');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  });
  await pageA.keyboard.press("Escape");
  await lightbox.waitFor({ state: "hidden" });

  // ── 3. Content validation: image metadata over non-image bytes ───────────
  const rejectedAttach = pageA.waitForResponse(response =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/photos");
  await input.setInputFiles({ name: "spoofed.png", mimeType: "image/png", buffer: spoofedPng });
  const rejected = await rejectedAttach;
  assert.equal(rejected.status(), 400, "spoofed bytes are rejected at attach time");
  assert.equal((await rejected.json()).error, "Photo contents must be a valid JPEG or PNG");
  await waitForToast(pageA, "Upload failed");
  assert.equal(storageRequests.filter(request => request.method === "PUT").length, 2, "the spoofed file did reach storage");
  assert.deepEqual(await inspector.list(`uploads/tenant-${tenantA.clientId}/`), [], "rejected staging bytes are discarded");
  assert.equal((await inspector.list(`finalized/tenant-${tenantA.clientId}/`)).length, 1, "nothing new was finalized");
  const listed = await api(pageA, "GET", `/photos?entityType=incident&entityId=${tenantA.incidentId}`);
  assert.deepEqual(listed.data.map(entry => entry.id), [photo.id], "only the valid photo is attached");

  // ── 4. CSRF: a cookie-authenticated mutation without the token is refused ─
  const noCsrf = await api(pageA, "POST", "/photos/request-upload", {
    entityType: "incident", entityId: tenantA.incidentId, name: "x.png", contentType: "image/png",
  }, { csrf: false });
  assert.equal(noCsrf.status, 403, "request-upload without the session CSRF token is refused");
  assert.equal(noCsrf.data?.error, "CSRF validation failed");

  // ── 5. Tenant boundaries (tenant B against tenant A's photo) ─────────────
  const pageB = tenantB.page;
  const foreignView = await api(pageB, "GET", `/storage${finalizedPath}`);
  assert.equal(foreignView.status, 403, "another tenant cannot read the finalized object");
  assert.equal((await api(pageB, "GET", `/photos?entityType=incident&entityId=${tenantA.incidentId}`)).status, 404,
    "another tenant cannot list photos on tenant A's record");
  assert.equal((await api(pageB, "POST", "/photos/request-upload", {
    entityType: "incident", entityId: tenantA.incidentId, name: "x.png", contentType: "image/png",
  })).status, 404, "another tenant cannot reserve an upload on tenant A's record");
  const reservedForA = await api(pageA, "POST", "/photos/request-upload", {
    entityType: "incident", entityId: tenantA.incidentId, name: "unused.png", contentType: "image/png",
  });
  assert.equal(reservedForA.status, 200, `tenant A reservation: ${reservedForA.text}`);
  const stolen = await api(pageB, "POST", "/photos", {
    entityType: "incident", entityId: tenantB.incidentId, objectPath: reservedForA.data.objectPath,
  });
  assert.equal(stolen.status, 403, "tenant B cannot attach tenant A's reserved upload to its own record");
  assert.equal((await api(pageB, "DELETE", `/photos/${photo.id}`)).status, 404, "tenant B cannot delete tenant A's photo");
  assert.equal((await inspector.list(`finalized/tenant-${tenantA.clientId}/`)).length, 1, "tenant A's object survives");

  // ── 6. Delete through the page; the object is removed from storage ───────
  const deleteResponse = pageA.waitForResponse(response =>
    response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/photos/${photo.id}`);
  await row.getByRole("button", { name: "Remove photo 1 of 1" }).click();
  assert.equal((await deleteResponse).status(), 200);
  await waitForToast(pageA, "Photo removed");
  await viewButton.waitFor({ state: "detached" });
  const deleteMutation = photoMutations.find(mutation => mutation.method === "DELETE");
  assert.match(deleteMutation?.headers["x-csrf-token"] ?? "", /^[0-9a-f]{64}$/, "delete carries the session CSRF token");
  assert.deepEqual(await inspector.list(), [], "deleting the photo removes its object; the run leaves nothing behind");
  await pageA.reload();
  await row.waitFor({ state: "visible" });
  await row.getByRole("button", { name: "Add photo" }).waitFor({ state: "visible" });
  assert.equal(await row.getByRole("button", { name: /^View photo/ }).count(), 0, "the deleted photo stays gone after reload");

  if (fakeStorage) {
    const received = await inspector.storageRequests();
    assert.ok(received.some(entry => entry.method === "OPTIONS" && entry.status === 200), "the browser made a CORS preflight");
    assert.ok(received.every(entry => !entry.hasCookie && !entry.hasCsrfHeader && !entry.hasAuthorization),
      "the storage endpoint never received session credentials");
  }
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("; ")}`);
  console.log(fakeStorage
    ? "Photo storage round trip passed against the IN-PROCESS FAKE storage client (test logic only; not a real GCS round trip)."
    : `Photo storage round trip passed against ${inspector.label}: session CSRF, presigned CORS upload, content validation, ACL finalization, reload, tenant boundaries and deletion.`);
} catch (error) {
  if (pageA) {
    console.error("Page:", pageA.url());
    console.error("Visible text:", (await pageA.locator("body").innerText().catch(() => "")).slice(0, 3000));
  }
  throw error;
} finally {
  await browser?.close();
}
