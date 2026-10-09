// Regression coverage for generic client document upload ownership.
// This is deliberately separate from DocTrack because the customer Documents
// page uses /storage/uploads/request-url and /documents directly.
// The provider-backed run is tests/run-storage-happy-path.sh (dedicated test
// bucket); tests/run-generic-document-object-acl.sh runs the app-level checks only.
import assert from "node:assert/strict";
import { skipWhenStorageUnavailable } from "./storage-test-availability.mjs";
import { createRun, sha256 } from "./storage-acl-session.mjs";

const run = createRun("generic-doc");

async function main() {
  const owner = await run.registerTenant("owner");
  const other = await run.registerTenant("other");
  // A second signed-in user of the uploading client (not the uploader).
  const colleague = await run.addSameClientUser(owner, "colleague");
  const uploaded = Buffer.from(`%PDF-1.4\nGeneric document ACL coverage ${run.runId}\n`);

  let response = await owner.request("POST", "/storage/uploads/request-url", {
    name: "tenant-policy.pdf",
    size: uploaded.length,
    contentType: "application/pdf",
  });
  if (skipWhenStorageUnavailable(response, "Generic document object ACL integration")) return;
  assert.equal(response.status, 200, "owner receives a presigned upload URL");
  const { uploadURL, objectPath } = response.data;
  assert.equal(typeof uploadURL, "string", "upload URL returned");
  assert.equal(typeof objectPath, "string", "tenant object path returned");
  assert.equal(objectPath.startsWith(`/objects/uploads/tenant-${owner.clientId}/`), true, "upload reserved under the owner's tenant");

  // A reserved path is not readable before the direct upload creates an object.
  response = await owner.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 404, "reserved but unuploaded object is absent");

  const put = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: uploaded,
  });
  assert.equal(put.ok, true, "direct object upload succeeds");

  // Upload completion alone must not grant access; document registration is the
  // ACL finalization boundary.
  await run.assertProviderHasNoAcl(objectPath);
  response = await owner.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 403, "uploaded but unregistered object remains private");

  // The other tenant cannot attach the owner's object to its own document row.
  response = await other.request("POST", "/documents", {
    name: "stolen-policy",
    objectPath,
    fileSize: uploaded.length,
    mimeType: "application/pdf",
  });
  assert.equal(response.status, 403, "foreign tenant cannot register owner's object");

  response = await owner.request("POST", "/documents", {
    name: "tenant-policy",
    objectPath,
    fileSize: uploaded.length,
    mimeType: "application/pdf",
  });
  assert.equal(response.status, 201, "owner registers and finalizes its document");
  const documentId = response.data?.id;
  assert.equal(Number.isInteger(documentId), true, "registered document has an id");

  // Provider metadata: owner is the uploading client, visibility private.
  await run.assertProviderAcl(objectPath, { ownerClientId: owner.clientId, bytes: uploaded });

  response = await owner.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 200, "owner can read finalized object");
  response = await owner.request("GET", `/documents/${documentId}/download`);
  assert.equal(response.status, 200, "owner can download its document");
  assert.match(response.text ?? "", /Generic document ACL coverage/, "download contains uploaded content");

  // Another logged-in user of the same client gets exactly the uploaded bytes.
  response = await colleague.request("GET", `/documents/${documentId}/download`);
  assert.equal(response.status, 200, "same-client colleague can download the document");
  assert.equal(sha256(response.bytes), sha256(uploaded), "colleague download matches the uploaded bytes");
  response = await colleague.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 200, "same-client colleague can read the finalized object");
  assert.equal(sha256(response.bytes), sha256(uploaded), "colleague object read matches the uploaded bytes");

  // The database tenant predicate blocks the foreign document ID, and the
  // storage ACL independently blocks direct object access.
  response = await other.request("GET", `/documents/${documentId}/download`);
  assert.equal(response.status, 404, "foreign tenant cannot download owner's document record");
  response = await other.request("GET", `/storage${objectPath}`);
  assert.equal(response.status, 403, "foreign tenant cannot read owner's finalized object");

  // A nonexistent object must never create a database document row.
  response = await owner.request("POST", "/documents", {
    name: "missing-policy",
    objectPath: objectPath.replace(/\/[^/]+$/, "/does-not-exist"),
    mimeType: "application/pdf",
  });
  assert.equal(response.status, 404, "missing object registration is rejected");

  console.log("Generic document object ACL coverage passed");
}

let failure;
try { await main(); } catch (error) { failure = error; }
try { await run.cleanup(); } catch (error) {
  if (failure) console.error(error); else failure = error;
}
if (failure) throw failure;
