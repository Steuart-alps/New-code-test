// Real API/storage browser round trip for FixTrack issue videos.
//
// Run through `pnpm --filter @workspace/api-server run test:fixtrack-video-roundtrip`
// (tests/run-photo-storage-roundtrip.sh --suite fixtrack-video), which boots a
// disposable database and the real API with production CSRF and mandatory 2FA,
// serving the web build from the same origin. Nothing here intercepts or mocks
// a request: staff choose MP4, MOV and WebM files on the issue page, the
// browser PUTs them straight to storage, the API signature-checks and copies
// each one to an immutable tenant key, and the gallery plays and seeks them
// with byte-range reads, before and after a reload. It then checks that range
// reads stay inside the tenant and that a viewer cannot upload or attach.
//
// Storage is the dedicated test bucket, or — only with --in-process-fake — an
// in-process fake of the storage client, which is NOT the real round trip.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createBucketInspector } from "../../api-server/tests/photo-roundtrip-bucket.mjs";
import { api, signIn, signUpTenant } from "./storage-roundtrip-session.mjs";

const appUrl = process.env.PHOTO_ROUNDTRIP_APP_URL;
assert.ok(appUrl, "Run through the api-server test:fixtrack-video-roundtrip script");
const fakeStorage = process.env.PHOTO_ROUNDTRIP_STORAGE === "in-process-fake";
const inspector = await createBucketInspector(process.env);
const prefix = inspector.prefix;
console.log(fakeStorage
  ? "FixTrack video round trip against the IN-PROCESS FAKE storage client — proves the test logic, NOT real GCS."
  : `FixTrack video round trip against the dedicated test bucket ${inspector.label}/${prefix}/`);

const fixture = name => readFileSync(new URL(`./fixtures/fixtrack-video/${name}`, import.meta.url));
// Upload order is gallery order. See fixtures/fixtrack-video/generate.sh.
const VIDEOS = [
  { label: "MP4", name: "issue-video.mp4", mimeType: "video/mp4", extension: ".mp4" },
  { label: "MOV", name: "issue-video.mov", mimeType: "video/quicktime", extension: ".mov" },
  { label: "WebM", name: "issue-video.webm", mimeType: "video/webm", extension: ".webm" },
].map(video => ({ ...video, bytes: fixture(video.name) }));
const h264Mov = fixture("issue-video-h264.mov");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const SEEK_TO = 3.2;

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const today = new Date().toISOString().slice(0, 10);

async function createIssue(page, title) {
  const created = await api(page, "POST", "/fix-track/issues", {
    title, issueType: "general", location: "Plant room", reportedBy: "Facilities", reportedDate: today,
  });
  assert.equal(created.status, 201, `create FixTrack issue: ${created.text}`);
  return created.data.id;
}

/** Ranged GET of a private object from inside a signed-in page. */
async function rangedGet(page, objectPath, range) {
  return page.evaluate(async ({ url, range }) => {
    // no-store: the browser cache must not answer a range from an earlier full read.
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: range ? { Range: range } : {} });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      contentRange: response.headers.get("content-range"),
      acceptRanges: response.headers.get("accept-ranges"),
      length: bytes.length,
      bytes: response.ok ? Array.from(bytes.slice(0, 256)) : [],
    };
  }, { url: `/api/storage${objectPath}`, range });
}

/**
 * Reserve, upload (direct browser PUT to the signed URL) and attach one file
 * through the API, as a client would. Returns each step's response.
 */
async function uploadThroughApi(page, issueId, { name, contentType, bytes }) {
  const reserved = await api(page, "POST", `/fix-track/issues/${issueId}/request-upload`, { name, contentType });
  if (reserved.status !== 200) return { reserved };
  const put = await page.evaluate(async ({ url, contentType, bytes }) =>
    (await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(bytes) })).status,
  { url: reserved.data.uploadUrl, contentType, bytes: Array.from(bytes) });
  assert.equal(put, 200, `direct storage PUT for ${name}`);
  const attached = await api(page, "POST", `/fix-track/issues/${issueId}/media`, { objectPath: reserved.data.objectPath });
  return { reserved, attached };
}

/**
 * Open each video in the issue gallery, play it, seek near the end and confirm
 * a decoded frame is available at the new position.
 */
async function playAndSeekEach(page, mediaPaths, stage) {
  for (const [index, video] of VIDEOS.entries()) {
    await page.getByTestId(`button-open-issue-media-${index}`).click();
    await page.getByText("Media Viewer", { exact: true }).waitFor({ state: "visible" });
    const result = await page.evaluate(async ({ objectPath, seekTo }) => {
      const element = [...document.querySelectorAll("video")]
        .find(candidate => new URL(candidate.src).pathname.endsWith(objectPath));
      if (!element) return { error: "no <video> for this object in the viewer" };
      const waitFor = (predicate, events, what) => new Promise((resolve, reject) => {
        if (predicate()) return resolve();
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for ${what} (readyState ${element.readyState}, error ${element.error?.code ?? "none"})`));
        }, 15_000);
        const check = () => { if (predicate()) { cleanup(); resolve(); } };
        const fail = () => { cleanup(); reject(new Error(`media error ${element.error?.code}: ${element.error?.message}`)); };
        const cleanup = () => {
          clearTimeout(timer);
          events.forEach(event => element.removeEventListener(event, check));
          element.removeEventListener("error", fail);
        };
        events.forEach(event => element.addEventListener(event, check));
        element.addEventListener("error", fail);
      });
      try {
        await waitFor(() => element.readyState >= 1, ["loadedmetadata"], "metadata");
        const duration = element.duration;
        element.muted = true;
        await element.play();
        await waitFor(() => element.currentTime > 0.2, ["timeupdate"], "playback to advance");
        element.pause();
        let seekedEvents = 0;
        element.addEventListener("seeked", () => { seekedEvents += 1; });
        element.currentTime = seekTo;
        await waitFor(() => seekedEvents > 0 && !element.seeking && element.readyState >= 2,
          ["seeked", "canplay", "loadeddata"], "the seek to finish with a decoded frame");
        return {
          duration,
          width: element.videoWidth,
          height: element.videoHeight,
          positionAfterSeek: element.currentTime,
          readyState: element.readyState,
          seekable: element.seekable.length ? [element.seekable.start(0), element.seekable.end(0)] : null,
        };
      } catch (error) {
        return { error: error.message };
      }
    }, { objectPath: mediaPaths[index], seekTo: SEEK_TO });
    assert.equal(result.error, undefined, `${stage}: ${video.label} plays and seeks in the gallery: ${result.error}`);
    assert.ok(Math.abs(result.duration - 4) < 0.25, `${stage}: ${video.label} reports its 4 s duration (${result.duration})`);
    assert.deepEqual([result.width, result.height], [128, 96], `${stage}: ${video.label} decodes frames`);
    assert.ok(Math.abs(result.positionAfterSeek - SEEK_TO) < 0.15,
      `${stage}: ${video.label} lands at the seek target (${result.positionAfterSeek})`);
    assert.ok(result.seekable && result.seekable[1] >= 3.9,
      `${stage}: ${video.label} is seekable to the end (${JSON.stringify(result.seekable)})`);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByText("Media Viewer", { exact: true }).waitFor({ state: "detached" });
  }
}

let browser;
let staffPage;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
    args: [
      "--autoplay-policy=no-user-gesture-required",
      // Fake mode only: resolve the storage host to the in-process fake inside
      // this browser. Real mode talks to storage.googleapis.com unchanged.
      ...(fakeStorage
        ? [`--host-resolver-rules=MAP storage.googleapis.com:443 127.0.0.1:${process.env.PHOTO_ROUNDTRIP_FAKE_UPLOAD_PORT}`, "--no-proxy-server"]
        : []),
    ],
  });
  const contextOptions = { viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: fakeStorage };
  const contextA = await browser.newContext(contextOptions);
  const contextB = await browser.newContext(contextOptions);
  const contextViewer = await browser.newContext(contextOptions);
  const contextAnonymous = await browser.newContext(contextOptions);

  const tenantA = await signUpTenant(contextA, {
    appUrl, label: "a", email: `fixtrack-video-a-${suffix}@test.local`, password: `pw-${suffix}-a`, name: "FixTrack video admin",
  });
  const tenantB = await signUpTenant(contextB, {
    appUrl, label: "b", email: `fixtrack-video-b-${suffix}@test.local`, password: `pw-${suffix}-b`, name: "FixTrack other admin",
  });
  assert.notEqual(tenantA.clientId, tenantB.clientId, "tenants must be isolated clients");
  staffPage = tenantA.page;
  const issueId = await createIssue(staffPage, `Leaking valve video evidence ${suffix}`);
  const otherIssueId = await createIssue(tenantB.page, `Other tenant issue ${suffix}`);

  // A read-only viewer in tenant A, signed in through the same 2FA flow.
  const viewerEmail = `fixtrack-video-viewer-${suffix}@test.local`;
  const viewerPassword = `pw-${suffix}-viewer`;
  const viewerCreated = await api(staffPage, "POST", "/users", {
    name: "FixTrack video viewer", email: viewerEmail, password: viewerPassword, role: "client_viewer", clientId: tenantA.clientId,
  });
  assert.equal(viewerCreated.status, 201, `create viewer: ${viewerCreated.text}`);
  const viewerPage = await contextViewer.newPage();
  viewerPage.setDefaultTimeout(20_000);
  await viewerPage.goto(`${appUrl}/login`);
  await signIn(viewerPage, "viewer", viewerEmail, viewerPassword);

  // ── Observe (never alter) the staff browser's traffic ────────────────────
  const pageErrors = [];
  staffPage.on("pageerror", error => pageErrors.push(error.message));
  const storagePuts = [];
  const objectReads = [];
  staffPage.on("request", async request => {
    const url = new URL(request.url());
    if (url.hostname === "storage.googleapis.com" && request.method() === "PUT") {
      storagePuts.push({ pathname: url.pathname, headers: await request.allHeaders() });
    }
  });
  staffPage.on("response", async response => {
    const url = new URL(response.url());
    if (url.origin === appUrl && url.pathname.startsWith("/api/storage/objects/")) {
      const headers = await response.allHeaders();
      objectReads.push({
        pathname: url.pathname,
        range: (await response.request().allHeaders()).range ?? null,
        status: response.status(),
        contentRange: headers["content-range"] ?? null,
        contentType: headers["content-type"] ?? null,
      });
    }
  });

  // ── 1. Staff upload MP4, MOV and WebM through the issue page ─────────────
  const navigation = await staffPage.goto(`${appUrl}/fix-track/${issueId}`);
  assert.ok(navigation?.ok(), `issue page: ${navigation?.status()}`);
  const chooser = staffPage.getByTestId("input-select-issue-media");
  await chooser.waitFor({ state: "attached" });
  const attachResponses = [];
  const onAttach = response => {
    if (response.request().method() === "POST" && new URL(response.url()).pathname === `/api/fix-track/issues/${issueId}/media`) {
      attachResponses.push(response);
    }
  };
  staffPage.on("response", onAttach);
  await chooser.setInputFiles(VIDEOS.map(({ name, mimeType, bytes }) => ({ name, mimeType, buffer: bytes })));
  await staffPage.getByText("3 media items added", { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  staffPage.off("response", onAttach);
  assert.equal(attachResponses.length, 3, "each video was attached");
  for (const response of attachResponses) assert.equal(response.status(), 200, `attach: ${await response.text()}`);

  assert.equal(storagePuts.length, 3, "three direct browser uploads to storage");
  for (const [index, put] of storagePuts.entries()) {
    assert.match(put.pathname, new RegExp(`/${prefix}/uploads/tenant-${tenantA.clientId}/[0-9a-f-]{36}\\${VIDEOS[index].extension}$`),
      `${VIDEOS[index].label} goes to this tenant's reserved staging key`);
    assert.equal(put.headers["content-type"], VIDEOS[index].mimeType, `${VIDEOS[index].label} upload carries its signed type`);
    for (const header of ["cookie", "x-csrf-token", "authorization"]) {
      assert.equal(put.headers[header], undefined, `storage PUT must not carry ${header}`);
    }
  }

  const detail = await api(staffPage, "GET", `/fix-track/issues/${issueId}`);
  const mediaPaths = detail.data.mediaUrls;
  assert.equal(mediaPaths.length, 3, `issue lists the three videos: ${JSON.stringify(mediaPaths)}`);
  for (const [index, video] of VIDEOS.entries()) {
    assert.match(mediaPaths[index], new RegExp(`^/objects/finalized/tenant-${tenantA.clientId}/[0-9a-f-]{36}\\${video.extension}$`),
      `${video.label} is stored under a fresh immutable tenant key, not its signed staging key`);
  }

  // Storage: byte-identical immutable copies with the tenant ACL; staging gone.
  const finalized = await inspector.list(`finalized/tenant-${tenantA.clientId}/`);
  assert.equal(finalized.length, 3, "three finalized objects for tenant A");
  for (const [index, video] of VIDEOS.entries()) {
    const stored = finalized.find(object => `/objects/${object.name.slice(prefix.length + 1)}` === mediaPaths[index]);
    assert.ok(stored, `${video.label} finalized object exists`);
    assert.equal(stored.contentType, video.mimeType, `${video.label} keeps its verified content type`);
    assert.equal(stored.size, video.bytes.length, `${video.label} is stored at its full size`);
    if (stored.sha256) assert.equal(stored.sha256, sha256(video.bytes), `${video.label} is copied byte for byte`);
    assert.deepEqual(JSON.parse(stored.metadata["custom:aclPolicy"]), { owner: String(tenantA.clientId), visibility: "private" },
      `${video.label} carries tenant A's private ACL`);
  }
  assert.deepEqual(await inspector.list(`uploads/tenant-${tenantA.clientId}/`), [], "validated staging uploads are deleted");

  // ── 2. Play and seek each format in the gallery, then again after reload ──
  await playAndSeekEach(staffPage, mediaPaths, "after upload");
  await staffPage.reload();
  await staffPage.getByTestId("button-open-issue-media-2").waitFor({ state: "visible" });
  await playAndSeekEach(staffPage, mediaPaths, "after reload");

  for (const [index, video] of VIDEOS.entries()) {
    const reads = objectReads.filter(read => read.pathname === `/api/storage${mediaPaths[index]}`);
    assert.ok(reads.length > 0, `${video.label}: the gallery read the video from the API`);
    assert.deepEqual(reads.filter(read => read.status >= 400), [], `${video.label}: no failed reads`);
    const ranged = reads.filter(read => read.range);
    assert.ok(ranged.length > 0 && ranged.every(read => read.status === 206 && /^bytes \d+-\d+\/\d+$/.test(read.contentRange ?? "")),
      `${video.label}: the player's range requests get 206 partial content: ${JSON.stringify(reads)}`);
    assert.ok(reads.every(read => read.contentType === video.mimeType), `${video.label}: served with its own content type`);
  }

  // ── 3. Byte ranges served by the API match the uploaded bytes ─────────────
  for (const [index, video] of VIDEOS.entries()) {
    const size = video.bytes.length;
    const objectPath = mediaPaths[index];
    const head = await rangedGet(staffPage, objectPath, "bytes=0-99");
    assert.equal(head.status, 206, `${video.label}: leading range`);
    assert.equal(head.contentRange, `bytes 0-99/${size}`);
    assert.equal(head.acceptRanges, "bytes", `${video.label}: advertises byte ranges`);
    assert.deepEqual(head.bytes, Array.from(video.bytes.subarray(0, 100)), `${video.label}: leading bytes match the upload`);
    const middle = await rangedGet(staffPage, objectPath, `bytes=${size - 300}-${size - 101}`);
    assert.equal(middle.status, 206);
    assert.equal(middle.length, 200);
    assert.deepEqual(middle.bytes, Array.from(video.bytes.subarray(size - 300, size - 300 + 200)), `${video.label}: mid-file range`);
    const tail = await rangedGet(staffPage, objectPath, "bytes=-64");
    assert.equal(tail.contentRange, `bytes ${size - 64}-${size - 1}/${size}`, `${video.label}: suffix range`);
    assert.deepEqual(tail.bytes, Array.from(video.bytes.subarray(size - 64)), `${video.label}: trailing bytes match`);
    const open = await rangedGet(staffPage, objectPath, `bytes=${size - 10}-`);
    assert.equal(open.contentRange, `bytes ${size - 10}-${size - 1}/${size}`, `${video.label}: open-ended range`);
    const whole = await rangedGet(staffPage, objectPath);
    assert.equal(whole.status, 200);
    assert.equal(whole.length, size, `${video.label}: whole-file read`);
    assert.equal((await rangedGet(staffPage, objectPath, `bytes=${size}-`)).status, 416, `${video.label}: unsatisfiable range`);
  }

  // A genuine QuickTime recording (H.264, like a phone's) is accepted and served
  // the same way. The test Chromium cannot decode H.264, so it is not played.
  const h264IssueId = await createIssue(staffPage, `Phone recording ${suffix}`);
  const h264 = await uploadThroughApi(staffPage, h264IssueId, { name: "phone.mov", contentType: "video/quicktime", bytes: h264Mov });
  assert.equal(h264.attached.status, 200, `H.264 QuickTime attach: ${h264.attached.text}`);
  const [h264Path] = h264.attached.data.mediaUrls;
  assert.match(h264Path, /\.mov$/, "the QuickTime recording keeps a .mov key");
  const h264Range = await rangedGet(staffPage, h264Path, "bytes=0-31");
  assert.equal(h264Range.status, 206);
  assert.equal(h264Range.contentType, "video/quicktime");
  assert.deepEqual(h264Range.bytes, Array.from(h264Mov.subarray(0, 32)), "QuickTime range bytes match the upload");

  // ── 4. Rejections: mislabelled video, active content ─────────────────────
  const mislabelled = await uploadThroughApi(staffPage, issueId, {
    name: "mislabelled.mp4", contentType: "video/mp4", bytes: VIDEOS[2].bytes,
  });
  assert.equal(mislabelled.attached.status, 400, "WebM bytes declared as MP4 are refused at attach");
  assert.equal(mislabelled.attached.data?.error, "Video contents do not match their declared format");
  assert.deepEqual(await inspector.list(`uploads/tenant-${tenantA.clientId}/`), [], "refused staging bytes are discarded");
  for (const contentType of ["text/html", "image/svg+xml", "application/javascript"]) {
    const refused = await api(staffPage, "POST", `/fix-track/issues/${issueId}/request-upload`, { name: "page", contentType });
    assert.equal(refused.status, 400, `no upload URL is signed for ${contentType}: ${refused.text}`);
  }

  // ── 5. Byte-range reads stay inside the tenant ────────────────────────────
  for (const [index, video] of VIDEOS.entries()) {
    const foreign = await rangedGet(tenantB.page, mediaPaths[index], "bytes=0-99");
    assert.equal(foreign.status, 403, `${video.label}: another tenant cannot range-read the video`);
    assert.equal(foreign.length < 100 && !foreign.bytes.length, true, `${video.label}: no video bytes leak to another tenant`);
    const foreignWhole = await rangedGet(tenantB.page, mediaPaths[index]);
    assert.equal(foreignWhole.status, 403, `${video.label}: another tenant cannot read the whole video`);
    const foreignAsClient = await rangedGet(tenantB.page, `${mediaPaths[index]}?clientId=${tenantA.clientId}`, "bytes=0-99");
    assert.ok([400, 403].includes(foreignAsClient.status), `${video.label}: naming tenant A's client id does not help (${foreignAsClient.status})`);
  }
  const anonymousPage = await contextAnonymous.newPage();
  await anonymousPage.goto(`${appUrl}/login`);
  assert.equal((await rangedGet(anonymousPage, mediaPaths[0], "bytes=0-99")).status, 401, "signed-out range reads are refused");
  assert.equal((await api(tenantB.page, "GET", `/fix-track/issues/${issueId}`)).status, 404, "another tenant cannot see the issue");
  assert.equal((await api(tenantB.page, "POST", `/fix-track/issues/${issueId}/request-upload`, {
    name: "x.mp4", contentType: "video/mp4",
  })).status, 404, "another tenant cannot reserve an upload on tenant A's issue");
  const stagingForA = await api(staffPage, "POST", `/fix-track/issues/${issueId}/request-upload`, { name: "a.mp4", contentType: "video/mp4" });
  assert.equal(stagingForA.status, 200);
  assert.equal((await api(tenantB.page, "POST", `/fix-track/issues/${otherIssueId}/media`, {
    objectPath: stagingForA.data.objectPath,
  })).status, 403, "tenant B cannot attach tenant A's reserved upload to its own issue");
  assert.equal((await api(tenantB.page, "POST", `/fix-track/issues/${otherIssueId}/media`, {
    objectPath: mediaPaths[0],
  })).status, 403, "tenant B cannot attach tenant A's finalized video to its own issue");
  assert.deepEqual((await api(tenantB.page, "GET", `/fix-track/issues/${otherIssueId}`)).data.mediaUrls ?? [], [],
    "tenant B's issue gained no media");

  // ── 6. Viewers can watch but cannot upload or attach ──────────────────────
  const viewerRead = await rangedGet(viewerPage, mediaPaths[1], "bytes=0-99");
  assert.equal(viewerRead.status, 206, "a viewer in the tenant can still play the evidence");
  const viewerReserve = await api(viewerPage, "POST", `/fix-track/issues/${issueId}/request-upload`, {
    name: "viewer.mp4", contentType: "video/mp4",
  });
  assert.equal(viewerReserve.status, 403, `viewer cannot request an upload URL: ${viewerReserve.text}`);
  const stagedByStaff = await api(staffPage, "POST", `/fix-track/issues/${issueId}/request-upload`, { name: "v.mp4", contentType: "video/mp4" });
  await staffPage.evaluate(async ({ url, bytes }) => {
    await fetch(url, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: new Uint8Array(bytes) });
  }, { url: stagedByStaff.data.uploadUrl, bytes: Array.from(VIDEOS[0].bytes) });
  const viewerAttach = await api(viewerPage, "POST", `/fix-track/issues/${issueId}/media`, { objectPath: stagedByStaff.data.objectPath });
  assert.equal(viewerAttach.status, 403, `viewer cannot attach even a real uploaded video: ${viewerAttach.text}`);
  const viewerReplace = await api(viewerPage, "PUT", `/fix-track/issues/${issueId}`, { mediaUrls: [stagedByStaff.data.objectPath] });
  assert.equal(viewerReplace.status, 403, "viewer cannot attach media through an issue update");
  assert.deepEqual((await api(staffPage, "GET", `/fix-track/issues/${issueId}`)).data.mediaUrls, mediaPaths,
    "the viewer's attempts changed nothing");
  await viewerPage.goto(`${appUrl}/fix-track/${issueId}`);
  await viewerPage.getByTestId("button-open-issue-media-2").waitFor({ state: "visible" });
  assert.equal(await viewerPage.getByTestId("button-select-issue-media").count(), 0, "viewers get no upload controls");
  assert.equal(await viewerPage.getByTestId("input-select-issue-media").count(), 0, "viewers get no file input");

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("; ")}`);
  console.log(fakeStorage
    ? "FixTrack video round trip passed against the IN-PROCESS FAKE storage client (test logic only; not a real GCS round trip)."
    : `FixTrack video round trip passed against ${inspector.label}: MP4/MOV/WebM upload, immutable finalization, gallery play and seek before and after reload, byte ranges, tenant boundaries and viewer refusal.`);
} catch (error) {
  if (staffPage) {
    console.error("Page:", staffPage.url());
    console.error("Visible text:", (await staffPage.locator("body").innerText().catch(() => "")).slice(0, 3000));
  }
  throw error;
} finally {
  await browser?.close();
}
