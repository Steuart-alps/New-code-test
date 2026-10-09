// Adversarial ACL checks for ZIP attachment exports. These protect against a
// tenant record being pointed at another client's otherwise valid object path.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
// Keep the bundle below api-server so its external dependencies resolve from
// this workspace's node_modules, as the other bundled job tests do.
const outDir = await mkdtemp(path.join(dir, ".build-export-acl-"));
try {
  const outfile = path.join(outDir, "entry.mjs");
  await build({
    entryPoints: [path.join(dir, "export-attachment-acl.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent",
    external: [
      "pg-native", "pino", "pino-pretty", "resend", "@google-cloud/*",
      "sharp", "pdfjs-dist/*",
    ],
    banner: {
      js: `import { createRequire as __createRequire } from 'node:module'; globalThis.require = __createRequire(import.meta.url);`,
    },
  });
  const {
    ObjectNotFoundError,
    fitsAttachmentExportCap,
    getAttachmentOmissionReason,
    getAttachmentZipPath,
    isExportAttachmentAuthorized,
    rawToCsv,
    attachmentCap,
  } = await import(outfile);
  assert.equal(isExportAttachmentAuthorized({ owner: "42", visibility: "private" }, 42), true);
  assert.equal(isExportAttachmentAuthorized({ owner: "43", visibility: "private" }, 42), false, "other tenant owner is denied");
  assert.equal(isExportAttachmentAuthorized({ owner: "42", visibility: "public" }, 42), false, "public ACL is denied");
  assert.equal(isExportAttachmentAuthorized(null, 42), false, "legacy/unmarked object is denied");
  assert.equal(getAttachmentOmissionReason(new ObjectNotFoundError()), "object unavailable", "missing objects are recorded, not silently skipped");

  const usedNames = new Set();
  const first = getAttachmentZipPath(
    { module: "doc-track", record_id: "1", label: "Fire certificate", file_name: "certificate.pdf" },
    usedNames,
  );
  const second = getAttachmentZipPath(
    { module: "doc-track", record_id: "2", label: "Fire certificate", file_name: "certificate.pdf" },
    usedNames,
  );
  assert.equal(first, "files/doc-track/Fire certificate.pdf", "available attachment gets an archive path");
  assert.equal(second, "files/doc-track/Fire certificate (2).pdf", "same-name attachments do not overwrite each other");
  const cap = 500 * 1024 * 1024;
  assert.equal(fitsAttachmentExportCap("1048576", cap - 1048576, cap), true, "metadata byte size is included in cap calculation");
  assert.equal(fitsAttachmentExportCap("1048577", cap - 1048576, cap), false, "metadata size cannot exceed the attachment cap");
  const objectPath = "/objects/uploads/tenant-42/certificate.pdf";
  const csv = rawToCsv([{ object_path: objectPath, media_urls: [objectPath, "/objects/missing"], external_url: "https://example.test/doc" }],
    new Map([[objectPath, first]]));
  assert.ok(csv.includes(first), "included files use relative archive paths in CSV and nested media");
  assert.ok(!csv.includes("/objects/"), "omitted private paths do not leak as unusable CSV links");
  assert.ok(csv.includes("https://example.test/doc"), "external URLs remain unchanged");
  const priorCap = process.env.EXPORT_ATTACHMENT_MAX_BYTES;
  try {
    process.env.EXPORT_ATTACHMENT_MAX_BYTES = "1024";
    assert.equal(attachmentCap(), 1024, "attachment cap is configurable");
    process.env.EXPORT_ATTACHMENT_MAX_BYTES = "-1";
    assert.throws(() => attachmentCap(), /Invalid EXPORT_ATTACHMENT_MAX_BYTES/, "invalid cap is rejected");
  } finally {
    if (priorCap === undefined) delete process.env.EXPORT_ATTACHMENT_MAX_BYTES;
    else process.env.EXPORT_ATTACHMENT_MAX_BYTES = priorCap;
  }
  console.log("export attachment ACL adversarial checks passed");
} finally {
  await rm(outDir, { recursive: true, force: true });
}