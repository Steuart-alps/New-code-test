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
let lib;
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
  lib = await import(pathToFileURL(output).href);
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
      // Current contract: an ACL persistence failure is a 500 "could not secure".
      aclFailure: { status: 500, error: "Could not secure uploaded document" },
    },
    {
      label: "Generic",
      upload: "/storage/uploads/request-url",
      register: "/documents",
      urlField: "uploadURL",
      body: { name: "Private policy", mimeType: "application/pdf", fileSize: 30 },
      // Current contract: an ACL persistence failure is a 400 "could not be verified".
      aclFailure: { status: 400, error: "Uploaded file could not be verified" },
    },
  ]) {
    const uploadBody = { name: "policy.pdf", size: 30, contentType: "application/pdf" };

    // Failure path: the provider rejects the ACL write once during registration.
    // Only the fake SDK fails; routes, ownership checks and ACL code stay real.
    {
      const reserved = await request("owner", "POST", flow.upload, uploadBody);
      assert.equal(reserved.status, 200, `${flow.label}: failure-path upload URL request succeeds`);
      const failedPath = reserved.data.objectPath;
      assert.match(failedPath, /^\/objects\/uploads\/tenant-7\//);
      const failedBytes = Buffer.from(`%PDF-1.4\n${flow.label} ACL failure content\n`);
      await lib.putSignedUpload(reserved.data[flow.urlField], failedBytes);
      const failedFile = await storage.getObjectEntityFile(failedPath);
      const writesBefore = lib.writes.length;

      lib.failNextSetMetadata();
      const failed = await request("owner", "POST", flow.register, { ...flow.body, objectPath: failedPath });
      assert.deepEqual(lib.consumedSetMetadataFaults(), [failedFile.name],
        `${flow.label}: registration must reach the provider ACL write that was made to fail`);
      assert.equal(failed.status, flow.aclFailure.status,
        `${flow.label}: ACL persistence failure returns an explicit non-success status`);
      assert.ok(failed.status >= 400, `${flow.label}: ACL failure must not be 2xx`);
      assert.deepEqual(failed.data, { error: flow.aclFailure.error },
        `${flow.label}: failure body is an error only, with no document or id`);
      assert.equal(lib.writes.length, writesBefore, `${flow.label}: no document row after ACL failure`);
      assert.equal(await lib.getObjectAclPolicy(failedFile), null, `${flow.label}: no tenant ACL granted`);
      const [failedMetadata] = await failedFile.getMetadata();
      assert.equal(failedMetadata.metadata["custom:aclPolicy"], undefined,
        `${flow.label}: no partial ACL metadata on the object`);
      for (const user of ["owner", "teammate", "foreign"]) {
        const read = await request(user, "GET", `/storage${failedPath}`);
        assert.equal(read.status, 403, `${flow.label}: ${user} cannot read an object whose ACL write failed`);
        assert.ok(!read.text.includes("ACL failure content"), `${flow.label}: no bytes leak to ${user}`);
      }
      assert.equal((await request(null, "GET", `/storage${failedPath}`)).status, 401);

      // The fault was one-shot: with it cleared, the same upload registers and
      // becomes readable, so the failure above was not a broken fixture.
      assert.equal(lib.clearSetMetadataFault(), false, "the injected fault was consumed exactly once");
      const retried = await request("owner", "POST", flow.register, { ...flow.body, objectPath: failedPath });
      assert.equal(retried.status, 201, `${flow.label}: registration succeeds once the provider recovers`);
      assert.ok(retried.data?.id, `${flow.label}: retried registration returns a document id`);
      assert.equal(lib.writes.length, writesBefore + 1);
      assert.deepEqual(await lib.getObjectAclPolicy(failedFile), { owner: "7", visibility: "private" });
      for (const user of ["owner", "teammate"]) {
        const read = await request(user, "GET", `/storage${failedPath}`);
        assert.equal(read.status, 200, `${flow.label}: ${user} can read after a successful retry`);
        assert.equal(read.text, failedBytes.toString());
      }
      assert.equal((await request("foreign", "GET", `/storage${failedPath}`)).status, 403);
    }

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
  lib?.clearSetMetadataFault();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}