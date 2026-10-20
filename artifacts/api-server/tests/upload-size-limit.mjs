// Every new upload is refused above MAX_UPLOAD_MB (default 250 MB), videos
// included, and the refused bytes are dropped; finalised objects are never
// touched. Pure: in-memory bucket, no database or credentials.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const MB = 1024 * 1024;
const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-upload-size-limit-"));
process.env.PRIVATE_OBJECT_DIR = "/upload-size-limit-test-bucket/private";
process.env.PUBLIC_OBJECT_SEARCH_PATHS = "/upload-size-limit-test-bucket/public";
process.env.LOG_LEVEL ||= "silent";
delete process.env.MAX_UPLOAD_MB;

try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "upload-size-limit.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
    plugins: [{
      name: "no-database",
      setup(builder) {
        // Size checks never reach the database; fail loudly if they do.
        const stubs = {
          db: "const fail = () => { throw new Error('Unexpected database use'); }; export const db = new Proxy({}, { get: fail }); export const pool = db;",
          downloads: "export const createDownloadToken = () => { throw new Error('Unexpected download token'); };",
        };
        builder.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "stub" }));
        builder.onResolve({ filter: /\/downloadUsage$/ }, () => ({ path: "downloads", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
      },
    }],
  });
  const t = await import(outfile);
  const storage = new t.ObjectStorageService();
  const reserved = (id, ext = ".pdf") => [`private/uploads/tenant-7/${id}${ext}`, `/objects/uploads/tenant-7/${id}${ext}`];

  // Default limit and the setting.
  assert.equal(t.maxUploadBytes(), 250 * MB);
  for (const [value, expected] of [["100", 100 * MB], [" 500 ", 500 * MB], ["0", 250 * MB], ["abc", 250 * MB], ["1.5", 250 * MB], ["9999", 250 * MB]]) {
    process.env.MAX_UPLOAD_MB = value;
    assert.equal(t.maxUploadBytes(), expected, `MAX_UPLOAD_MB=${JSON.stringify(value)}`);
  }
  delete process.env.MAX_UPLOAD_MB;

  // Exactly at the limit is stored and finalised.
  const [atName, atPath] = reserved("at-limit");
  t.put(atName, 250 * MB);
  await storage.finalizeTenantUpload(atPath, 7);
  assert.equal(JSON.parse(t.objects.get(atName).metadata["custom:aclPolicy"]).owner, "7");

  // One byte over is refused with a plain message and the bytes are dropped.
  const [overName, overPath] = reserved("over-limit", ".mp4");
  t.put(overName, 250 * MB + 1, "video/mp4");
  await assert.rejects(storage.finalizeTenantUpload(overPath, 7), (error) =>
    error instanceof t.UploadTooLargeError && /up to 250 MB/.test(error.message));
  assert.equal(t.objects.has(overName), false, "refused upload is dropped");

  // A lower configured limit applies everywhere.
  process.env.MAX_UPLOAD_MB = "50";
  const [midName, midPath] = reserved("mid");
  t.put(midName, 60 * MB);
  await assert.rejects(storage.finalizeTenantUpload(midPath, 7), (error) => /up to 50 MB/.test(error.message));
  delete process.env.MAX_UPLOAD_MB;

  // Finalised objects (outside the upload reservation) are never touched.
  const finalized = "private/finalized/tenant-7/old-video.mp4";
  t.put(finalized, 900 * MB, "video/mp4");
  await storage.enforceUploadSizeLimit("/objects/finalized/tenant-7/old-video.mp4", 7);
  assert.equal(t.objects.has(finalized), true, "existing large files are kept");

  // Another tenant's reservation is not this tenant's to drop.
  const foreign = "private/uploads/tenant-8/foreign.mp4";
  t.put(foreign, 900 * MB, "video/mp4");
  await storage.enforceUploadSizeLimit("/objects/uploads/tenant-8/foreign.mp4", 7);
  assert.equal(t.objects.has(foreign), true);

  // FixTrack issue videos use the same limit.
  const [videoName, videoPath] = reserved("issue-video", ".mp4");
  t.put(videoName, 251 * MB, "video/mp4");
  await assert.rejects(storage.finalizeVerifiedIssueMediaUpload(videoPath, 7), (error) => error instanceof t.UploadTooLargeError);

  console.log("Upload size limit checks passed.");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
process.exit(0);
