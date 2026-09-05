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
    external: ["@google-cloud/storage", "sharp", "pdfjs-dist/*"],
  });
  await build({
    entryPoints: [path.join(dir, "../src/workers/pdfValidationWorker.ts")],
    bundle: true, platform: "node", format: "esm",
    outfile: path.join(outDir, "pdf-validation-worker.mjs"), logLevel: "silent",
    external: ["pdfjs-dist/*"],
  });
  const { detectUploadType, validateUploadContent, validatePdfInWorker } = await import(new URL(`file://${outFile}`).href);
  check("valid PDF", detectUploadType(Buffer.from("%PDF-1.7\nbody")), "application/pdf");
  check("valid PNG IHDR", detectUploadType(Buffer.from([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52,
    0,0,0,1, 0,0,0,1, 8,2,0,0,0, 0,0,0,0,
  ])), "image/png");
  check("valid JPEG segment", detectUploadType(Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0])), "image/jpeg");
  check("MIME-spoofed HTML", detectUploadType(Buffer.from("<html>not an image</html>")), null);
  check("PDF-prefix spoof", detectUploadType(Buffer.from("%PDF-not-a-version")), null);
  check("PNG-prefix spoof", detectUploadType(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0])), null);
  check("JPEG-prefix spoof", detectUploadType(Buffer.from([0xff,0xd8,0xff,0xe0,0,2])), null);
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