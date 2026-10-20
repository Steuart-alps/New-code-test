// Image uploads are capped at ~50 megapixels so one decode fits the 512 MB
// instance; concurrent validations queue rather than decoding in parallel.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(testsDir, ".build-upload-pixel-cap-"));
try {
  const outFile = path.join(outDir, "upload-validation.mjs");
  await build({
    entryPoints: [path.join(testsDir, "../src/lib/uploadValidation.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    packages: "external",
  });
  const { validateUploadContent, MAX_IMAGE_PIXELS, ObjectContentError } = await import(pathToFileURL(outFile).href);
  assert.equal(MAX_IMAGE_PIXELS, 50_000_000);
  const png = (width, height) => sharp({ create: { width, height, channels: 3, background: "#4477aa" } }).png().toBuffer();
  const allowed = new Set(["image/png"]);

  const small = await validateUploadContent(await png(1200, 900), allowed);
  assert.equal(small.contentType, "image/png", "an ordinary photo-sized image is accepted");

  // 7200 x 7200 = 51.8 MP: within the per-side limit but over the pixel cap.
  await assert.rejects(validateUploadContent(await png(7200, 7200), allowed),
    (err) => err instanceof ObjectContentError, "an image over the pixel cap is rejected");

  // Concurrent validations all complete (they queue for the decode permit).
  const results = await Promise.all([1, 2, 3].map(async () => validateUploadContent(await png(400, 300), allowed)));
  assert.equal(results.length, 3);
  console.log("upload pixel cap checks passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
