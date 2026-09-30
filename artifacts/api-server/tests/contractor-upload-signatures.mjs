// Fast, self-contained coverage for the content checks used by the contractor
// portal. This deliberately supplies bytes independently of a claimed MIME:
// callers must only accept a detected PDF/JPEG/PNG structure.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";
import sharp from "sharp";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-"));
const outFile = path.join(outDir, "contractor-upload-signatures.mjs");
let failures = 0;
function check(name, actual, expected) {
  if (actual !== expected) { failures++; console.error(`FAIL ${name}: expected ${expected}, got ${actual}`); }
}
try {
  await build({
    entryPoints: [path.join(dir, "contractor-upload-signatures.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: outFile, logLevel: "silent",
    packages: "external",
    external: ["@google-cloud/storage", "sharp", "pdfjs-dist/*"],
  });
  await build({
    entryPoints: [path.join(dir, "../src/workers/pdfValidationWorker.ts")],
    bundle: true, platform: "node", format: "esm",
    outfile: path.join(outDir, "pdf-validation-worker.mjs"), logLevel: "silent",
    external: ["pdfjs-dist/*"],
  });
  const { detectIssueVideoType, detectUploadType, validateUploadContent, validatePdfInWorker } = await import(new URL(`file://${outFile}`).href);
  check("valid PDF", detectUploadType(Buffer.from("%PDF-1.7\nbody")), "application/pdf");
  check("valid PNG IHDR", detectUploadType(Buffer.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52,
    0,0,0,1, 0,0,0,1, 8,2,0,0,0, 0,0,0,0,
  ])), "image/png");
  check("valid JPEG segment", detectUploadType(Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0])), "image/jpeg");
  const webpPrefix = Buffer.alloc(12);
  webpPrefix.write("RIFF", 0, "ascii");
  webpPrefix.writeUInt32LE(4, 4);
  webpPrefix.write("WEBP", 8, "ascii");
  check("valid WebP container", detectUploadType(webpPrefix), "image/webp");
  const heicPrefix = Buffer.alloc(16);
  heicPrefix.writeUInt32BE(16, 0);
  heicPrefix.write("ftyp", 4, "ascii");
  heicPrefix.write("heic", 8, "ascii");
  check("valid HEIC container", detectUploadType(heicPrefix), "image/heic");
  const heifPrefix = Buffer.from(heicPrefix);
  heifPrefix.write("mif1", 8, "ascii");
  check("valid HEIF container", detectUploadType(heifPrefix), "image/heif");
  check("MIME-spoofed HTML", detectUploadType(Buffer.from("<html>not an image</html>")), null);
  check("PDF-prefix spoof", detectUploadType(Buffer.from("%PDF-not-a-version")), null);
  check("PNG-prefix spoof", detectUploadType(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0])), null);
  check("JPEG-prefix spoof", detectUploadType(Buffer.from([0xff,0xd8,0xff,0xe0,0,2])), null);
  const mp4Prefix = Buffer.alloc(24);
  mp4Prefix.writeUInt32BE(24, 0);
  mp4Prefix.write("ftyp", 4, "ascii");
  mp4Prefix.write("isom", 8, "ascii");
  mp4Prefix.writeUInt32BE(0, 12);
  mp4Prefix.write("mp42", 16, "ascii");
  check("valid MP4 container", detectIssueVideoType(mp4Prefix), "video/mp4");
  const movPrefix = Buffer.alloc(16);
  movPrefix.writeUInt32BE(16, 0);
  movPrefix.write("ftyp", 4, "ascii");
  movPrefix.write("qt  ", 8, "ascii");
  movPrefix.writeUInt32BE(0, 12);
  check("valid QuickTime container", detectIssueVideoType(movPrefix), "video/quicktime");
  const webmPrefix = Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from([0x42, 0x82, 0x84]),
    Buffer.from("webm", "ascii"),
  ]);
  check("valid WebM container", detectIssueVideoType(webmPrefix), "video/webm");
  check("MIME-spoofed video payload", detectIssueVideoType(Buffer.from("<html>webm video/mp4</html>")), null);
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
  // Prefix-only data may pass cheap classification but must fail the full
  // finalisation parser.
  for (const [name, bytes] of [
    ["truncated PDF", Buffer.from("%PDF-1.7\nbody")],
    ["truncated JPEG", Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0])],
    ["truncated PNG", Buffer.from([
      0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52,
      0,0,0,1, 0,0,0,1, 8,2,0,0,0, 0,0,0,0,
    ])],
    ["fabricated marker-only JPEG", Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,0xda,0,2,0xff,0xd9])],
    ["fake PDF token structure", Buffer.from("%PDF-1.7\n1 0 obj <</Type /Page>> endobj\ntrailer <</Root 1 0 R>>\nstartxref\n9\n%%EOF\n")],
  ]) {
    let rejected = false;
    try { await validateUploadContent(bytes, allowed); } catch { rejected = true; }
    check(name, rejected, true);
  }
  const realJpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).jpeg().toBuffer();
  const jpegPolyglot = Buffer.concat([realJpeg, Buffer.from("<script>evil()</script>")]);
  const normalizedJpeg = await validateUploadContent(jpegPolyglot, new Set(["image/jpeg"]));
  check("JPEG polyglot decoded", normalizedJpeg.contentType, "image/jpeg");
  check("JPEG trailing payload stripped", normalizedJpeg.normalizedBytes.includes(Buffer.from("<script>")), false);

  const realPng = await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } }).png().toBuffer();
  const invalidPng = Buffer.from(realPng);
  invalidPng[Math.floor(invalidPng.length / 2)] ^= 0xff;
  let invalidPngRejected = false;
  try { await validateUploadContent(invalidPng, new Set(["image/png"])); } catch { invalidPngRejected = true; }
  check("invalid PNG decompression/checksum rejected", invalidPngRejected, true);
  const normalizedPng = await validateUploadContent(Buffer.concat([realPng, Buffer.from("PK\u0003\u0004polyglot")]), new Set(["image/png"]));
  check("PNG trailing payload stripped", normalizedPng.normalizedBytes.includes(Buffer.from("polyglot")), false);
  const realWebp = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).webp().toBuffer();
  const normalizedWebp = await validateUploadContent(realWebp, new Set(["image/webp"]));
  check("WebP normalized", normalizedWebp.contentType, "image/webp");
  check("normalized WebP remains valid", detectUploadType(normalizedWebp.normalizedBytes), "image/webp");
  const realAvif = await sharp({ create: { width: 2, height: 2, channels: 3, background: "orange" } }).avif().toBuffer();
  check("AVIF container detected", detectUploadType(realAvif), "image/avif");
  const normalizedAvif = await validateUploadContent(realAvif, new Set(["image/avif"]));
  check("AVIF normalized to JPEG", normalizedAvif.contentType, "image/jpeg");
  check("normalized AVIF remains a valid JPEG", detectUploadType(normalizedAvif.normalizedBytes), "image/jpeg");

  function minimalPdf(pageExtras = "") {
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R ${pageExtras} >>`,
      "<< /Length 0 >>\nstream\n\nendstream",
    ];
    let pdf = "%PDF-1.7\n", offsets = [0];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
  }
  const pdf = minimalPdf();
  check("valid PDF accepted", (await validateUploadContent(pdf, new Set(["application/pdf"]))).contentType, "application/pdf");
  let timeoutRejected = false;
  try { await validatePdfInWorker(pdf, { timeoutMs: 50, testMode: "timeout" }); } catch { timeoutRejected = true; }
  check("PDF worker timeout rejected", timeoutRejected, true);
  let oomRejected = false;
  try { await validatePdfInWorker(pdf, { timeoutMs: 3_000, testMode: "oom" }); } catch { oomRejected = true; }
  check("PDF worker resource exhaustion rejected", oomRejected, true);
  const oversizedImagePdf = minimalPdf(
    "/Resources << /XObject << /Im1 << /Subtype /Image /Width 100000 /Height 100000 >> >> >>",
  );
  let oversizedRejected = false;
  try { await validateUploadContent(oversizedImagePdf, new Set(["application/pdf"])); } catch { oversizedRejected = true; }
  check("oversized PDF image resource rejected", oversizedRejected, true);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
if (failures) process.exit(1);
console.log("contractor upload signature checks passed");