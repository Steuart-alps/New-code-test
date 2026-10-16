// End-to-end data export attachments against the dedicated test bucket
// (run through tests/run-storage-happy-path.sh; never application storage).
//
// One tenant stores a DocTrack document, a SafeTrack risk assessment, a
// contractor certificate (through the contractor portal), a compliance item
// certificate and a check photo through the normal upload routes. Its export
// must contain each file with the stored bytes, and every CSV must point at
// the archived file instead of the private storage path. A record pointed at
// another tenant's object and one pointed at a missing object are omitted and
// named in the manifest. A second API process with a small
// EXPORT_ATTACHMENT_MAX_BYTES must warn in the README and record cap omissions.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { skipWhenStorageUnavailable } from "./storage-test-availability.mjs";
import { openStorageFixture, storageFixtureConfigured } from "./storage-happy-path-fixture.mjs";
import { BASE, createRun, psqlScalar, session, sha256 } from "./storage-acl-session.mjs";

const SUITE = "Data export attachments";
const run = createRun("export-attach");

function minimalPdf(label) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
    `<< /Length 0 >>\nstream\n\nendstream`,
  ];
  let pdf = `%PDF-1.7\n% ${label}\n`;
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function put(uploadUrl, bytes, contentType, label) {
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  assert.equal(response.ok, true, `${label}: signed upload (${response.status})`);
}

function ok(response, status, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.data ?? response.text)}`);
  return response.data;
}

/** Minimal RFC 4180 reader for the export's own CSVs. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers = [], ...body] = rows;
  return body.map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""])));
}

async function downloadExport(base, request, label) {
  const response = await request("GET", `${base === BASE ? "" : base}/export`);
  assert.equal(response.status, 200, `${label}: export download (${response.text ?? JSON.stringify(response.data)})`);
  const dir = await mkdtemp(path.join(tmpdir(), "export-attach-"));
  const zip = path.join(dir, "export.zip");
  await writeFile(zip, response.bytes);
  const entries = new Set(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean));
  const read = (name) => execFileSync("unzip", ["-p", zip, name], { maxBuffer: 64 * 1024 * 1024 });
  return {
    entries,
    read,
    text: (name) => read(name).toString("utf8"),
    manifest: parseCsv(read("attachment-manifest.csv").toString("utf8")),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A second API on the same database and test bucket, with a small attachment cap. */
async function startCappedApi(maxBytes) {
  const port = await freePort();
  const entry = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--enable-source-maps", entry], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), EXPORT_ATTACHMENT_MAX_BYTES: String(maxBytes) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  };
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("capped export API exited before readiness");
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (ready) return { base: `http://127.0.0.1:${port}/api`, stop };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await stop();
  throw new Error("capped export API did not become ready");
}

async function main() {
  const owner = await run.registerTenant("owner");
  const foreign = await run.registerTenant("foreign");
  const site = ok(await owner.request("POST", "/sites", { name: `Export attachments ${run.runId}`, seedStarterChecks: false }), 201, "create site");

  // ── DocTrack ───────────────────────────────────────────────────────────────
  const docBytes = minimalPdf(`doc-track ${run.runId}`);
  let response = await owner.request("POST", "/doc-track/documents/request-upload", { name: "policy.pdf", contentType: "application/pdf" });
  if (skipWhenStorageUnavailable(response, SUITE)) return;
  let reserved = ok(response, 200, "DocTrack upload URL");
  await put(reserved.uploadUrl, docBytes, "application/pdf", "DocTrack");
  const doc = ok(await owner.request("POST", "/doc-track/documents", {
    title: "Export policy", category: "policy", fileName: "policy.pdf", fileSize: docBytes.length,
    mimeType: "application/pdf", objectPath: reserved.objectPath, siteId: site.id,
  }), 201, "DocTrack document");

  // ── SafeTrack risk assessment ──────────────────────────────────────────────
  const raBytes = minimalPdf(`safe-track ${run.runId}`);
  reserved = ok(await owner.request("POST", "/safe-track/request-upload", {}), 200, "SafeTrack upload URL");
  await put(reserved.uploadUrl, raBytes, "application/pdf", "SafeTrack");
  const ra = ok(await owner.request("POST", "/safe-track/risk-assessments", {
    title: "Export risk assessment", objectPath: reserved.objectPath, fileName: "risk.pdf",
    fileSize: raBytes.length, mimeType: "application/pdf", siteId: site.id,
  }), 201, "SafeTrack risk assessment");

  // ── Contractor certificate, uploaded by the contractor through the portal ──
  const contractorBytes = minimalPdf(`contractor ${run.runId}`);
  const contractor = ok(await owner.request("POST", "/contractors", {
    name: "Export engineer", email: `engineer-${run.runId}@contractor.test`,
  }), 201, "contractor");
  const link = ok(await owner.request("POST", `/contractors/${contractor.id}/portal-link`, {}), 201, "portal link");
  const portal = session();
  reserved = ok(await portal("POST", `/contractor-portal/${link.token}/upload-url`, { contentType: "application/pdf" }), 200, "portal upload URL");
  await put(reserved.uploadUrl, contractorBytes, "application/pdf", "contractor certificate");
  const portalCert = ok(await portal("POST", `/contractor-portal/${link.token}/certificates`, {
    certificateName: "Gas Safe certificate", objectPath: reserved.objectPath,
  }), 201, "portal certificate");

  // ── Compliance item certificate (generic upload, registered on the item) ───
  const itemCertBytes = minimalPdf(`item certificate ${run.runId}`);
  const item = ok(await owner.request("POST", "/compliance-items", { title: "Export EICR", siteId: site.id }), 201, "compliance item");
  response = ok(await owner.request("POST", "/storage/uploads/request-url", {
    name: "eicr.pdf", size: itemCertBytes.length, contentType: "application/pdf",
  }), 200, "certificate upload URL");
  await put(response.uploadURL, itemCertBytes, "application/pdf", "item certificate");
  const itemCert = ok(await owner.request("POST", `/items/${item.id}/certificates`, {
    name: "EICR 2026", fileUrl: response.objectPath,
  }), 201, "item certificate");
  ok(await owner.request("GET", `/storage${itemCert.fileUrl}`), 200, "item certificate file is readable once attached");

  // ── Check photo on the risk assessment ─────────────────────────────────────
  const photoBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();
  reserved = ok(await owner.request("POST", "/photos/request-upload", {
    entityType: "safe_risk_assessment", entityId: ra.id, name: "photo.png", contentType: "image/png",
  }), 200, "photo upload URL");
  await put(reserved.uploadUrl, photoBytes, "image/png", "photo");
  const photo = ok(await owner.request("POST", "/photos", {
    entityType: "safe_risk_assessment", entityId: ra.id, objectPath: reserved.objectPath, caption: "Export photo",
  }), 201, "photo");

  // ── A foreign tenant's object and a missing object, attached by database ───
  // Simulates a tampered or stale row: the export must check each object's
  // own ACL and existence, not trust the record that names it.
  const foreignBytes = minimalPdf(`foreign ${run.runId}`);
  reserved = ok(await foreign.request("POST", "/doc-track/documents/request-upload", { name: "foreign.pdf", contentType: "application/pdf" }), 200, "foreign upload URL");
  await put(reserved.uploadUrl, foreignBytes, "application/pdf", "foreign document");
  const foreignDoc = ok(await foreign.request("POST", "/doc-track/documents", {
    title: "Foreign policy", category: "policy", fileName: "foreign.pdf", mimeType: "application/pdf", objectPath: reserved.objectPath,
  }), 201, "foreign document");
  const borrowed = ok(await owner.request("POST", "/safe-track/sops", { title: "Borrowed file SOP" }), 201, "SOP for foreign object");
  const stale = ok(await owner.request("POST", "/safe-track/sops", { title: "Stale file SOP" }), 201, "SOP for missing object");
  const missingPath = `/objects/uploads/tenant-${owner.clientId}/missing-${randomUUID()}.pdf`;
  await psqlScalar(`
    UPDATE safe_sops SET object_path = '${foreignDoc.object_path}', file_name = 'foreign.pdf' WHERE id = ${Number(borrowed.id)} AND client_id = ${Number(owner.clientId)};
    UPDATE safe_sops SET object_path = '${missingPath}', file_name = 'missing.pdf' WHERE id = ${Number(stale.id)} AND client_id = ${Number(owner.clientId)};`);

  const storage = storageFixtureConfigured() ? openStorageFixture() : null;
  const stored = async (objectPath) => (await storage.fileFor(objectPath).download())[0];
  const expected = [
    { label: "DocTrack", module: "doc-track", recordId: String(doc.id), objectPath: doc.object_path, uploaded: docBytes,
      csv: "doc-track/documents.csv", column: "object_path" },
    { label: "SafeTrack", module: "safe-track/risk-assessments", recordId: String(ra.id), objectPath: ra.objectPath, uploaded: raBytes,
      csv: "safe-track/risk-assessments.csv", column: "objectPath" },
    { label: "contractor certificate", module: "contractors/certificates", recordId: String(portalCert.id), uploaded: contractorBytes,
      csv: "contractors/uploaded-certificates.csv", column: "object_path" },
    { label: "item certificate", module: "compliance/certificates", recordId: String(itemCert.id), objectPath: itemCert.fileUrl, uploaded: itemCertBytes,
      csv: "compliance/certificates.csv", column: "file_url" },
    // Photos are re-encoded on finalize, so compare with the stored object.
    { label: "photo", module: "check-photos", recordId: String(photo.id), objectPath: photo.object_path,
      csv: "check-photos/photos.csv", column: "object_path" },
  ];

  // ── Full export ────────────────────────────────────────────────────────────
  const full = await downloadExport(BASE, owner.request, "full export");
  try {
    for (const want of expected) {
      const row = full.manifest.find((r) => r.module === want.module && r.recordId === want.recordId);
      assert.ok(row, `${want.label}: manifest row (${JSON.stringify(full.manifest)})`);
      assert.equal(row.status, "included", `${want.label}: included (${row.reason})`);
      want.objectPath ??= row.objectPath;
      assert.equal(row.objectPath, want.objectPath, `${want.label}: manifest names its object`);
      assert.ok(full.entries.has(row.zipPath), `${want.label}: archived at ${row.zipPath}`);
      const archived = full.read(row.zipPath);
      if (want.uploaded) assert.equal(sha256(archived), sha256(want.uploaded), `${want.label}: archived bytes match the upload`);
      if (storage) assert.equal(sha256(archived), sha256(await stored(want.objectPath)), `${want.label}: archived bytes match the stored object`);
      if (want.label === "photo") {
        const meta = await sharp(archived).metadata();
        assert.deepEqual([meta.format, meta.width, meta.height], ["png", 8, 8], "photo: archived file is the 8x8 PNG");
      }
      const csvRows = parseCsv(full.text(want.csv));
      const csvRow = csvRows.find((r) => String(r.id) === want.recordId);
      assert.ok(csvRow, `${want.label}: ${want.csv} has the record`);
      assert.equal(csvRow[want.column], row.zipPath, `${want.label}: ${want.csv} points at the archived file`);
      assert.equal(full.text(want.csv).includes(want.objectPath), false, `${want.label}: ${want.csv} hides the storage path`);
      want.zipPath = row.zipPath;
    }

    const borrowedRow = full.manifest.find((r) => r.module === "safe-track/sops" && r.recordId === String(borrowed.id));
    assert.deepEqual([borrowedRow?.status, borrowedRow?.reason, borrowedRow?.zipPath], ["omitted", "not authorized for exporting client", ""],
      "foreign-ACL object is omitted and named in the manifest");
    const staleRow = full.manifest.find((r) => r.module === "safe-track/sops" && r.recordId === String(stale.id));
    assert.deepEqual([staleRow?.status, staleRow?.reason, staleRow?.zipPath], ["omitted", "object unavailable", ""],
      "missing object is omitted and named in the manifest");
    const foreignSha = sha256(foreignBytes);
    assert.equal([...full.entries].some((name) => !name.endsWith("/") && sha256(full.read(name)) === foreignSha), false,
      "no archive member carries the foreign tenant's file");
    const readme = full.text("README.txt");
    assert.doesNotMatch(readme, /attachment\(s\) omitted because/, "no cap warning when everything fits");
  } finally {
    await full.done();
  }

  // ── Small attachment cap ───────────────────────────────────────────────────
  // DocTrack is listed first, so a cap of exactly its size includes it and
  // omits every later attachment.
  const capped = await startCappedApi(docBytes.length);
  try {
    const small = await downloadExport(capped.base, owner.request, "capped export");
    try {
      const [docWant, ...later] = expected;
      const docRow = small.manifest.find((r) => r.module === docWant.module && r.recordId === docWant.recordId);
      assert.equal(docRow?.status, "included", "capped: first attachment still fits");
      assert.equal(sha256(small.read(docRow.zipPath)), sha256(docBytes), "capped: included bytes match");
      for (const want of later) {
        const row = small.manifest.find((r) => r.module === want.module && r.recordId === want.recordId);
        assert.deepEqual([row?.status, row?.reason, row?.zipPath], ["omitted", "attachment size cap", ""], `capped: ${want.label} omitted for the cap`);
        assert.equal(small.entries.has(want.zipPath), false, `capped: ${want.label} not archived`);
      }
      // A file referenced by two records (a portal upload is both an uploaded
      // certificate and a register entry) has a manifest row for each.
      const capRows = small.manifest.filter((r) => r.reason === "attachment size cap");
      assert.ok(capRows.length >= later.length, "capped: every later attachment has a cap row");
      const readme = small.text("README.txt");
      assert.match(readme, new RegExp(`WARNING: ${capRows.length} attachment\\(s\\) omitted because the ${docBytes.length}-byte cap was reached\\. ${docBytes.length} bytes included\\.`),
        "capped: README warns about the cap");
    } finally {
      await small.done();
    }
  } finally {
    await capped.stop();
  }

  console.log(`${SUITE}: DocTrack, SafeTrack, contractor certificate, item certificate and photo exported with matching bytes; foreign, missing and capped files omitted with reasons`);
}

let failure;
try { await main(); } catch (error) { failure = error; }
try { await run.cleanup(); } catch (error) {
  if (failure) console.error(error); else failure = error;
}
if (failure) throw failure;
