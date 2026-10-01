// Real HTTP routes/auth/storage/ACL logic, with an in-memory GCS boundary.
// This runs without signing credentials, a real bucket, or a live database.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = await mkdtemp(path.join(dir, ".build-private-acl-"));
const fixture = JSON.stringify(path.join(dir, "private-file-acl-fixture.mjs"));
let server;
try {
  const stubs = {
    gcs: `export { Storage, File } from ${fixture};`,
    db: `export { db } from ${fixture}; export const auditContext = { getStore() { return null; } };`,
    auth: "export const getUserById = () => { throw Error('Unexpected user lookup'); };",
    billing: "export const findLiveSubscription = () => { throw Error('Unexpected billing lookup'); };",
    references: "export const listTenantAttachmentObjectPaths = () => { throw Error('Unexpected attachment scan'); };",
    pdf: "export const createAcknowledgementRegisterPdf = () => { throw Error('Unexpected PDF export'); }; export const createCombinedAcknowledgementRegisterPdf = () => { throw Error('Unexpected combined PDF export'); };",
    downloads: `
      export const createDownloadMeter = () => ({ add() {}, async commit() {} });
      export const createDownloadToken = () => { throw Error('Unexpected download token'); };
      export const resolveDownloadToken = () => { throw Error('Unexpected token lookup'); };
      export const getMonthlyDownloadBytes = () => { throw Error('Unexpected usage lookup'); };
      export const utcMonth = () => '2026-01';`,
    validation: `
      export class ObjectContentError extends Error {}
      export const MAX_RESTRICTED_UPLOAD_BYTES = 10485760;
      export const detectIssueVideoType = () => { throw Error('Unexpected video validation'); };
      export const detectUploadType = () => { throw Error('Unexpected image validation'); };
      export const validatePdfInWorker = () => { throw Error('Unexpected PDF validation'); };
      export const validateUploadContent = () => { throw Error('Unexpected content validation'); };`,
  };
  const output = path.join(outDir, "routes.mjs");
  await build({
    entryPoints: [path.join(dir, "private-file-acl.entry.ts")],
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [{
      name: "isolated-acl-dependencies",
      setup(builder) {
        for (const [filter, name] of [
          [/^@google-cloud\/storage$/, "gcs"],
          [/^@workspace\/db$/, "db"],
          [/\/lib\/auth$|^\.\/auth$/, "auth"],
          [/\/lib\/billing$/, "billing"],
          [/\/attachmentReferences$/, "references"],
          [/\/acknowledgementRegisterPdf$/, "pdf"],
          [/\/downloadUsage$/, "downloads"],
          [/\/uploadValidation$/, "validation"],
        ]) {
          builder.onResolve({ filter }, () => ({ path: name, namespace: "acl-test" }));
        }
        builder.onLoad({ filter: /.*/, namespace: "acl-test" }, args => ({
          contents: stubs[args.path], loader: "js", resolveDir: dir,
        }));
      },
    }],
  });
  const lib = await import(pathToFileURL(output).href);
  // Change only provider configuration, never the ownership/access methods.
  lib.ObjectStorageService.prototype.getPrivateObjectDir = () => "/acl-test/private";
  const storage = new lib.ObjectStorageService();
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  const users = {
    owner: { id: 101, clientId: 7, role: "client_admin", name: "Uploader" },
    teammate: { id: 102, clientId: 7, role: "client_viewer", name: "Another user" },
    foreign: { id: 103, clientId: 8, role: "client_admin", name: "Other client" },
  };
  app.use((req, _res, next) => {
    req.currentUser = users[req.header("x-test-user")];
    req.session = { userId: req.currentUser?.id };
    req.log = { error() {}, warn() {} };
    next();
  });
  app.use("/api", lib.storageRouter);
  app.use("/api", lib.documentsRouter);
  app.use("/api/doc-track", lib.docTrackRouter);
  server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(user, method, route, body) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": user } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      data: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null,
      text, cache: response.headers.get("cache-control"),
    };
  }

  for (const flow of [
    {
      label: "DocTrack",
      upload: "/doc-track/documents/request-upload",
      register: "/doc-track/documents",
      urlField: "uploadUrl",
      body: { title: "Private policy", category: "policy", fileName: "policy.pdf", mimeType: "application/pdf" },
    },
    {
      label: "Generic",
      upload: "/storage/uploads/request-url",
      register: "/documents",
      urlField: "uploadURL",
      body: { name: "Private policy", mimeType: "application/pdf", fileSize: 30 },
    },
  ]) {
    const uploadBody = { name: "policy.pdf", size: 30, contentType: "application/pdf" };
    assert.equal((await request(null, "POST", flow.upload, uploadBody)).status, 401);
    assert.equal((await request("teammate", "POST", flow.upload, uploadBody)).status, 403,
      `${flow.label}: viewer cannot request uploads`);
    const upload = await request("owner", "POST", flow.upload, uploadBody);
    assert.equal(upload.status, 200, `${flow.label}: upload URL request succeeds`);
    const objectPath = upload.data.objectPath;
    assert.match(objectPath, /^\/objects\/uploads\/tenant-7\//,
      `${flow.label}: reservation uses client identity, not user identity`);
    assert.equal((await request("owner", "GET", `/storage${objectPath}`)).status, 404,
      `${flow.label}: signing must not create an object/ACL`);
    const bytes = Buffer.from(`%PDF-1.4\n${flow.label} private test content\n`);
    await lib.putSignedUpload(upload.data[flow.urlField], bytes);
    const file = await storage.getObjectEntityFile(objectPath);
    assert.equal(await lib.getObjectAclPolicy(file), null, "PUT alone must not grant access");
    assert.equal((await request("teammate", "GET", `/storage${objectPath}`)).status, 403);

    const writesBefore = lib.writes.length;
    assert.equal((await request("foreign", "POST", flow.register, { ...flow.body, objectPath })).status, 403,
      `${flow.label}: another client cannot finalize an unowned reservation`);
    assert.equal(lib.writes.length, writesBefore, "forbidden claim must not write a document");
    assert.equal((await request("owner", "POST", flow.register, { ...flow.body, objectPath })).status, 201);
    assert.equal(lib.writes.length, writesBefore + 1);
    assert.deepEqual(await lib.getObjectAclPolicy(file), { owner: "7", visibility: "private" },
      `${flow.label}: final ACL must be private and owned by the client`);
    const [metadata] = await file.getMetadata();
    assert.deepEqual(JSON.parse(metadata.metadata["custom:aclPolicy"]), { owner: "7", visibility: "private" });

    for (const user of ["owner", "teammate"]) {
      const read = await request(user, "GET", `/storage${objectPath}`);
      assert.equal(read.status, 200, `${flow.label}: ${user} can read the finalized private object`);
      assert.equal(read.text, bytes.toString(), "same-client readers receive uploaded bytes");
      assert.match(read.cache, /^private,/);
    }
    assert.equal((await request("foreign", "GET", `/storage${objectPath}`)).status, 403,
      `${flow.label}: another client cannot read the private object`);
    assert.equal((await request(null, "GET", `/storage${objectPath}`)).status, 401);
    assert.equal((await request("foreign", "POST", flow.register, { ...flow.body, objectPath })).status, 403);
    assert.deepEqual(await lib.getObjectAclPolicy(file), { owner: "7", visibility: "private" },
      "a denied foreign claim must not change ACL ownership");
    assert.equal(lib.writes.length, writesBefore + 1);
  }
  console.log("Private file ACL HTTP regression checks passed for DocTrack and generic uploads.");
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}