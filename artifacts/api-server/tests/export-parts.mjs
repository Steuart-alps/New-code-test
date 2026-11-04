// A business with more files than one download holds gets them all, split
// into numbered parts of at most EXPORT_ATTACHMENT_MAX_BYTES: the records are
// in part 1, each file is in exactly one part, a file bigger than a part gets
// one of its own, and the manifest in every part says where each file is.
// Storage is an in-memory stand-in for the provider bucket (only
// objectStorageClient.bucket() is replaced; the real export route runs).
// Disposable DB only:
//   FRESH_SCHEMA_BASE=push bash tests/run-fresh-schema.sh tests/export-parts.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { build } from "esbuild";
import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTenant, db, sql, pool } from "./approval-workflow-fixtures.mjs";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1"
    || !process.env.DATABASE_URL?.includes("host=/tmp/")) {
  throw new Error("The export parts test requires the disposable fresh-schema database.");
}

// A made-up bucket name: the fake below answers for it, nothing reaches Google.
const BUCKET = "export-parts-test-fake-bucket";
process.env.PRIVATE_OBJECT_DIR = `/${BUCKET}/private`;
const PART_BYTES = 700;
process.env.EXPORT_ATTACHMENT_MAX_BYTES = String(PART_BYTES);

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(testsDir, ".build-export-parts-"));
let lib;
try {
  const output = path.join(temp, "export.mjs");
  await build({
    entryPoints: [path.join(testsDir, "export-parts.entry.ts")],
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    external: ["sharp", "*.node", "pg-native", "pino", "pino-pretty", "@google-cloud/*", "@sentry/*", "nodemailer", "pdfjs-dist/*"],
    banner: { js: "import { createRequire as __testRequire } from 'node:module'; globalThis.require = __testRequire(import.meta.url);" },
  });
  lib = await import(pathToFileURL(output).href);
} finally {
  await rm(temp, { recursive: true, force: true });
}

// ── In-memory bucket ─────────────────────────────────────────────────────────
const objects = new Map(); // provider object name -> { bytes, acl }
const reads = [];
const nameOf = (objectPath) => `private/${objectPath.replace(/^\/objects\//, "")}`;
lib.objectStorageClient.bucket = (bucketName) => {
  assert.equal(bucketName, BUCKET, "only the fake bucket may be touched");
  return {
    file: (name) => ({
      name,
      async exists() { return [objects.has(name)]; },
      async getMetadata() {
        const object = objects.get(name);
        if (!object) throw Object.assign(new Error("No such object"), { code: 404 });
        return [{ size: String(object.bytes.length), metadata: object.acl ? { "custom:aclPolicy": JSON.stringify(object.acl) } : {} }];
      },
      createReadStream() { reads.push(name); return Readable.from([objects.get(name).bytes]); },
    }),
  };
};

const tenant = await createTenant("export-parts");
const T = tenant.clientId;
const app = express();
app.use((req, _res, next) => { req.currentUser = { id: tenant.userId, role: "client_admin", clientId: T, email: "owner@test.local", active: true }; next(); });
app.use(lib.exportRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

// Files in record order: 400 + 300 fill part 1, 300 + 200 + 100 make part 2,
// and 800 (bigger than a part) gets part 3. One file belongs to another
// business and is left out.
const sizes = [400, 300, 300, 200, 100, 800];
const files = [];
for (const [i, size] of sizes.entries()) {
  const objectPath = `/objects/finalized/tenant-${T}/doc-${i}.pdf`;
  const bytes = Buffer.alloc(size, 65 + i);
  objects.set(nameOf(objectPath), { bytes, acl: { owner: String(T), visibility: "private" } });
  const row = await db.execute(sql`INSERT INTO client_documents (client_id, name, object_path, file_size)
    VALUES (${T}, ${`Doc ${i}.pdf`}, ${objectPath}, ${size}) RETURNING id`);
  files.push({ id: row.rows[0].id, objectPath, bytes, part: [1, 1, 2, 2, 2, 3][i] });
}
const foreignPath = `/objects/legacy/someone-else.pdf`;
objects.set(nameOf(foreignPath), { bytes: Buffer.alloc(10), acl: { owner: String(T + 1000), visibility: "private" } });
await db.execute(sql`INSERT INTO client_documents (client_id, name, object_path) VALUES (${T}, 'Borrowed.pdf', ${foreignPath})`);

function parseCsv(text) {
  const [header, ...lines] = text.trim().split("\n");
  const keys = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, i) => [keys[i], value])));
}

async function download(query = "") {
  const response = await fetch(`${base}/export${query}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) return { status: response.status, json: JSON.parse(body.toString("utf8")) };
  const dir = await mkdtemp(path.join(tmpdir(), "export-parts-"));
  const zip = path.join(dir, "export.zip");
  await writeFile(zip, body);
  const entries = new Set(execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean));
  const contents = new Map([...entries].map((name) => [name, execFileSync("unzip", ["-p", zip, name], { maxBuffer: 16 * 1024 * 1024 })]));
  const read = (name) => contents.get(name) ?? assert.fail(`${name} missing from the archive`);
  const result = {
    status: response.status, headers: response.headers, entries, read,
    manifest: parseCsv(read("attachment-manifest.csv").toString("utf8")),
    readme: read("README.txt").toString("utf8"),
  };
  await rm(dir, { recursive: true, force: true });
  return result;
}

try {
  const seen = new Map();
  for (const part of [1, 2, 3]) {
    reads.length = 0;
    const zip = await download(part === 1 ? "" : `?part=${part}`);
    assert.equal(zip.status, 200, `part ${part} downloads`);
    assert.equal(zip.headers.get("x-export-parts"), "3", `part ${part}: three parts in all`);
    assert.equal(zip.headers.get("x-export-part"), String(part));
    assert.match(zip.headers.get("content-disposition"), new RegExp(`-part-${part}-of-3\\.zip`));
    assert.equal(zip.entries.has("sites.csv"), part === 1, `records are in part 1 only (part ${part})`);
    assert.match(zip.readme, new RegExp(`This is part ${part} of 3`));
    for (const file of files) {
      const row = zip.manifest.find((r) => r.objectPath === file.objectPath);
      assert.equal(row?.part, String(file.part), `manifest in part ${part} names the part of ${file.objectPath}`);
      assert.equal(row.status, file.part === part ? "included" : "part");
      assert.equal(zip.entries.has(row.zipPath), file.part === part, `${row.zipPath} only in its own part`);
      if (file.part === part) {
        assert.ok(zip.read(row.zipPath).equals(file.bytes), `${row.zipPath}: bytes match`);
        assert.ok(!seen.has(file.objectPath), "each file is in exactly one part");
        seen.set(file.objectPath, part);
      }
    }
    const foreign = zip.manifest.find((r) => r.objectPath === foreignPath);
    assert.deepEqual([foreign?.status, foreign?.reason], ["omitted", "not authorized for exporting client"]);
    assert.deepEqual(reads.sort(), files.filter((f) => f.part === part).map((f) => nameOf(f.objectPath)).sort(),
      `part ${part} reads only its own files from storage`);
  }
  assert.equal(seen.size, files.length, "every file is in some part");
  // Part 1's CSVs link files held in later parts too.
  const first = await download();
  const docsCsv = first.read("client-documents/documents.csv").toString("utf8");
  assert.ok(docsCsv.includes("files/client-documents/Doc 5.pdf"), "records link a file in a later part");
  assert.equal((await download("?part=4")).status, 404, "no part beyond the last");
  assert.equal((await download("?part=0")).status, 400, "part numbers start at 1");

  // Everything fits in one part: no part suffix and no part note.
  await db.execute(sql`DELETE FROM client_documents WHERE client_id = ${T} AND object_path <> ${files[0].objectPath}`);
  const single = await download();
  assert.equal(single.headers.get("x-export-parts"), "1");
  assert.doesNotMatch(single.headers.get("content-disposition"), /-part-/);
  assert.doesNotMatch(single.readme, /This is part/);
  console.log("A large export is split into parts; each file is in exactly one part and the records are in part 1.");
} finally {
  server.close();
  await pool.end().catch(() => {});
}
