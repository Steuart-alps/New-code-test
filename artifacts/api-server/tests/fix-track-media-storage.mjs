// FixTrack issue media against the dedicated test bucket (run through
// tests/run-storage-happy-path.sh; never application storage).
//
// Photos: a JPEG carrying EXIF rotation (what an iPhone hands the web picker)
// and an AVIF are finalized as upright JPEGs and show in the issue after a
// reload. A real HEVC-coded HEIC, a truncated JPEG, a GIF and text posing as
// MP4 are refused with a message and never attached.
// Videos: MP4, MOV and WebM clips are attached unchanged, served with byte
// ranges, readable by staff but not by a Viewer (Viewers see only their own
// training) or another tenant, and play and seek in Chromium from the issue's
// media list after a reload. Viewers cannot reserve or attach media.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { chromium } from "@playwright/test";
import { skipWhenStorageUnavailable } from "./storage-test-availability.mjs";
import { openStorageFixture, storageFixtureConfigured } from "./storage-happy-path-fixture.mjs";
import { BASE, createRun, sha256 } from "./storage-acl-session.mjs";

const SUITE = "FixTrack media";
const run = createRun("fixtrack-media");
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fix-track-media");
const ORIGIN = new URL(BASE).origin;
const HEIC_MESSAGE = "HEIC photos can't be read. Save the photo as JPEG and upload it again.";

function ok(response, status, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.data ?? response.text)}`);
  return response.data;
}

const mediaOf = (issue) => issue?.mediaUrls ?? issue?.media_urls ?? [];

async function stagingExists(objectPath) {
  if (!storageFixtureConfigured()) return null;
  const [exists] = await openStorageFixture().fileFor(objectPath).exists();
  return exists;
}

/** Reserve, upload and attach one file as `user`; returns the attach response. */
async function attach(user, issueId, { name, contentType, bytes }) {
  const reserved = ok(await user.request("POST", `/fix-track/issues/${issueId}/request-upload`, { name, contentType }), 200, `${name}: upload URL`);
  const uploaded = await fetch(reserved.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  assert.equal(uploaded.ok, true, `${name}: signed upload (${uploaded.status})`);
  const attached = await user.request("POST", `/fix-track/issues/${issueId}/media`, { objectPath: reserved.objectPath });
  return { reserved, attached };
}

async function raw(user, objectPath, headers = {}) {
  const response = await fetch(`${BASE}/storage${objectPath}`, { headers: { cookie: user.request.cookie(), ...headers } });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function main() {
  const owner = await run.registerTenant("owner");
  const foreign = await run.registerTenant("foreign");
  const staff = await run.addSameClientUser(owner, "staff");
  const viewer = await run.addSameClientUser(owner, "viewer", "client_viewer");

  const issue = ok(await owner.request("POST", "/fix-track/issues", {
    title: "Leaking radiator valve", issueType: "general", location: "Plant room",
    reportedBy: "Facilities team", reportedDate: new Date().toISOString().slice(0, 10),
  }), 201, "create issue");

  // ── Viewers cannot reserve or attach ──────────────────────────────────────
  let response = await viewer.request("POST", `/fix-track/issues/${issue.id}/request-upload`, { name: "clip.webm", contentType: "video/webm" });
  if (skipWhenStorageUnavailable(response, SUITE)) return;
  assert.equal(response.status, 403, "viewer cannot reserve an upload");

  // ── Photos ─────────────────────────────────────────────────────────────────
  // EXIF orientation 6: stored landscape, shown portrait once rotated.
  const iphoneJpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const avif = await sharp({ create: { width: 40, height: 24, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .avif({ quality: 50 }).toBuffer();
  const photos = [];
  for (const photo of [
    { name: "IMG_0001.jpg", contentType: "image/jpeg", bytes: iphoneJpeg, width: 32, height: 48 },
    { name: "photo.avif", contentType: "image/avif", bytes: avif, width: 40, height: 24 },
  ]) {
    const { reserved, attached } = await attach(staff, issue.id, photo);
    const media = ok(attached, 200, `${photo.name}: attach`).mediaUrls;
    const finalized = media.at(-1);
    assert.match(finalized, /^\/objects\/finalized\/tenant-\d+\/[0-9a-f-]+\.jpg$/, `${photo.name}: finalized as an immutable JPEG`);
    assert.equal(await stagingExists(reserved.objectPath), storageFixtureConfigured() ? false : null, `${photo.name}: staging copy removed`);
    const served = await raw(staff, finalized);
    assert.equal(served.status, 200, `${photo.name}: served to staff`);
    assert.equal(served.headers.get("content-type"), "image/jpeg", `${photo.name}: served as JPEG`);
    const meta = await sharp(served.bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.orientation ?? 1], ["jpeg", photo.width, photo.height, 1], `${photo.name}: upright JPEG`);
    await run.assertProviderAcl(finalized, { ownerClientId: owner.clientId, bytes: served.bytes });
    photos.push(finalized);
  }

  // ── Refused files are reported and never attached ──────────────────────────
  const before = mediaOf(ok(await staff.request("GET", `/fix-track/issues/${issue.id}`), 200, "issue before refusals"));
  const heic = await readFile(path.join(fixtures, "photo.heic"));
  const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).gif().toBuffer();
  for (const refused of [
    { name: "IMG_0002.HEIC", contentType: "image/heic", bytes: heic, message: HEIC_MESSAGE },
    { name: "cut-off.jpg", contentType: "image/jpeg", bytes: iphoneJpeg.subarray(0, Math.floor(iphoneJpeg.length / 2)) },
    { name: "anim.gif", contentType: "image/gif", bytes: gif, message: "Choose a JPEG, PNG, WebP, MP4, MOV, or WebM file" },
    { name: "not-a-video.mp4", contentType: "video/mp4", bytes: Buffer.from("this is plain text, not an MP4 file\n".repeat(4)), message: "Video contents do not match their declared format" },
  ]) {
    const { reserved, attached } = await attach(staff, issue.id, refused);
    assert.equal(attached.status, 400, `${refused.name}: refused (${JSON.stringify(attached.data)})`);
    assert.equal(typeof attached.data?.error, "string", `${refused.name}: refusal has a message`);
    if (refused.message) assert.equal(attached.data.error, refused.message, `${refused.name}: refusal explains why`);
    assert.equal(await stagingExists(reserved.objectPath), storageFixtureConfigured() ? false : null, `${refused.name}: refused upload discarded`);
  }
  const after = mediaOf(ok(await staff.request("GET", `/fix-track/issues/${issue.id}`), 200, "issue after refusals"));
  assert.deepEqual(after, before, "refused files are not attached");

  // ── Videos ─────────────────────────────────────────────────────────────────
  const videos = [];
  for (const [file, contentType, extension] of [
    ["clip.mp4", "video/mp4", "mp4"], ["clip.mov", "video/quicktime", "mov"], ["clip.webm", "video/webm", "webm"],
  ]) {
    const bytes = await readFile(path.join(fixtures, file));
    const { reserved, attached } = await attach(staff, issue.id, { name: file, contentType, bytes });
    const finalized = ok(attached, 200, `${file}: attach`).mediaUrls.at(-1);
    assert.match(finalized, new RegExp(`/finalized/tenant-\\d+/[0-9a-f-]+\\.${extension}$`), `${file}: finalized under a fresh key`);
    assert.equal(await stagingExists(reserved.objectPath), storageFixtureConfigured() ? false : null, `${file}: staging copy removed`);
    await run.assertProviderAcl(finalized, { ownerClientId: owner.clientId, bytes });

    const full = await raw(staff, finalized);
    assert.equal(full.status, 200, `${file}: full read`);
    assert.equal(full.headers.get("content-type"), contentType, `${file}: served with its type`);
    assert.equal(full.headers.get("accept-ranges"), "bytes", `${file}: advertises byte ranges`);
    assert.equal(sha256(full.bytes), sha256(bytes), `${file}: bytes unchanged`);

    const middle = Math.floor(bytes.length / 2);
    for (const [range, start, end] of [
      ["bytes=0-15", 0, 15], [`bytes=${middle}-${middle + 99}`, middle, middle + 99], ["bytes=-32", bytes.length - 32, bytes.length - 1],
    ]) {
      const part = await raw(staff, finalized, { range });
      assert.equal(part.status, 206, `${file}: ${range} is a partial response`);
      assert.equal(part.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`, `${file}: ${range} Content-Range`);
      assert.equal(sha256(part.bytes), sha256(bytes.subarray(start, end + 1)), `${file}: ${range} bytes`);
    }
    assert.equal((await raw(staff, finalized, { range: `bytes=${bytes.length + 10}-` })).status, 416, `${file}: range past the end is refused`);
    assert.equal((await raw(viewer, finalized, { range: "bytes=0-15" })).status, 403, `${file}: viewer (own training only) cannot watch`);
    assert.equal((await raw(foreign, finalized, { range: "bytes=0-15" })).status, 403, `${file}: other tenant's range read refused`);
    assert.equal((await raw(foreign, finalized)).status, 403, `${file}: other tenant's full read refused`);
    videos.push({ path: finalized, file });
  }

  // A viewer cannot attach even an upload staff reserved for this issue.
  const reservedForViewer = ok(await staff.request("POST", `/fix-track/issues/${issue.id}/request-upload`, { name: "clip.webm", contentType: "video/webm" }), 200, "reserve for viewer attempt");
  run.trackObject(reservedForViewer.objectPath);
  await fetch(reservedForViewer.uploadUrl, { method: "PUT", headers: { "Content-Type": "video/webm" }, body: await readFile(path.join(fixtures, "clip.webm")) });
  assert.equal((await viewer.request("POST", `/fix-track/issues/${issue.id}/media`, { objectPath: reservedForViewer.objectPath })).status, 403, "viewer cannot attach media");
  // Another tenant cannot attach this tenant's upload to its own issue either.
  const foreignIssue = ok(await foreign.request("POST", "/fix-track/issues", {
    title: "Foreign issue", issueType: "general", location: "Office", reportedBy: "Other", reportedDate: new Date().toISOString().slice(0, 10),
  }), 201, "foreign issue");
  assert.equal((await foreign.request("POST", `/fix-track/issues/${foreignIssue.id}/media`, { objectPath: reservedForViewer.objectPath })).status, 403, "other tenant cannot attach this upload");

  // ── Reload: the issue lists every attachment, in order ─────────────────────
  const reloaded = mediaOf(ok(await staff.request("GET", `/fix-track/issues/${issue.id}`), 200, "reload issue"));
  assert.deepEqual(reloaded, [...photos, ...videos.map((v) => v.path)], "reloaded issue lists the photos and videos");

  await playInBrowser(staff, owner.clientId, issue.id);
  console.log(`${SUITE}: iPhone-style JPEG and AVIF finalized upright; HEIC, truncated, GIF and fake MP4 refused; MP4, MOV and WebM attached, range-served, tenant-scoped and seekable in Chromium after reload`);
}

/**
 * Load the issue the way the gallery does after a reload, then show each photo
 * and play and seek each video from the same URLs the gallery builds.
 */
async function playInBrowser(user, clientId, issueId) {
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ executablePath });
  try {
    const context = await browser.newContext();
    const [name, ...value] = user.request.cookie().split("=");
    await context.addCookies([{ name, value: value.join("="), url: ORIGIN }]);
    const page = await context.newPage();
    const partials = [];
    page.on("response", (response) => { if (response.status() === 206) partials.push(response.url()); });
    for (const pass of ["first load", "after reload"]) {
      await page.goto(`${ORIGIN}/healthz`);
      const results = await page.evaluate(async ({ apiPath, ids }) => {
        const issue = await (await fetch(`${apiPath}/fix-track/issues/${ids.issueId}?clientId=${ids.clientId}`, { credentials: "same-origin" })).json();
        const media = issue.mediaUrls ?? issue.media_urls ?? [];
        const out = [];
        for (const objectPath of media) {
          const src = `${apiPath}/storage${objectPath}?clientId=${ids.clientId}`;
          const wait = (el, event) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), 15_000);
            el.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
            el.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`media error ${el.error?.code ?? ""} ${el.error?.message ?? ""}`)); }, { once: true });
          });
          try {
            if (/\.(mp4|mov|webm)$/i.test(objectPath)) {
              const video = document.createElement("video");
              Object.assign(video, { preload: "metadata", muted: true, playsInline: true, controls: true, src });
              document.body.append(video);
              await wait(video, "loadedmetadata");
              const duration = video.duration;
              video.currentTime = duration * 0.6;
              await wait(video, "seeked");
              await video.play();
              await new Promise((resolve) => setTimeout(resolve, 300));
              video.pause();
              out.push({ objectPath, ok: true, duration, at: video.currentTime, width: video.videoWidth });
            } else {
              const img = document.createElement("img");
              img.src = src;
              document.body.append(img);
              await img.decode();
              out.push({ objectPath, ok: true, width: img.naturalWidth, height: img.naturalHeight });
            }
          } catch (error) {
            out.push({ objectPath, ok: false, error: String(error) });
          }
        }
        return out;
      }, { apiPath: new URL(BASE).pathname, ids: { clientId, issueId } });
      assert.equal(results.length, 5, `${pass}: gallery lists five items`);
      for (const result of results) {
        assert.equal(result.ok, true, `${pass}: ${result.objectPath} ${result.error ?? ""}`);
        if (result.duration !== undefined) {
          assert.ok(Math.abs(result.duration - 2) < 0.2, `${pass}: ${result.objectPath} duration`);
          assert.ok(result.at >= 1.1, `${pass}: ${result.objectPath} seeked past the middle (${result.at})`);
          assert.equal(result.width, 64, `${pass}: ${result.objectPath} decoded frames`);
        } else {
          assert.ok(result.width > 0 && result.height > 0, `${pass}: ${result.objectPath} shows`);
        }
      }
      await page.reload();
    }
    assert.ok(partials.length > 0, "the browser used byte-range reads");
  } finally {
    await browser.close();
  }
}

let failure;
try { await main(); } catch (error) { failure = error; }
try { await run.cleanup(); } catch (error) {
  if (failure) console.error(error); else failure = error;
}
if (failure) throw failure;
